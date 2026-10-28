// Read-only Git review scope. A merge without an explicit parent is not
// silently interpreted as a first-parent diff; other resolved changes survive.
import { createHash } from 'node:crypto';
import { lstat, readlink, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { withWorkspaceEntry } from './workspace-fs-boundary.mjs';
import { execFileSafe } from './repo.mjs';
import { validateTaskSpec, emptyTaskSpec } from './routing/task-spec.mjs';

const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const GIT_ENV = { GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_NO_REPLACE_OBJECTS: '1' };
const MAX_OUTPUT = 1_500_000;
async function git(root, args, signal) {
  const { stdout } = await execFileSafe('git', args, { cwd: root, signal, env: GIT_ENV,
    timeoutMs: 30_000, maxCaptureChars: MAX_OUTPUT + 10, maxResultChars: MAX_OUTPUT });
  if (stdout.length >= MAX_OUTPUT) throw new Error('git_inventory_too_large');
  return stdout;
}
const safeRef = (value) => /^[a-zA-Z0-9_./~^-]{1,160}$/.test(value) &&
  !value.startsWith('-') && !value.includes('..') && !value.includes('@{') && !value.endsWith('.lock');
async function resolveRef(root, value, signal) {
  if (!safeRef(value)) throw new Error('unsafe_git_revision');
  return (await git(root, ['rev-parse', '--verify', `${value}^{commit}`], signal)).trim();
}
function validPath(path) {
  return typeof path === 'string' && !!path && !path.startsWith('/') && !path.includes('\\0') &&
    !path.split('/').includes('..');
}
function nameStatus(raw) {
  const fields = raw.split('\0');
  const entries = [];
  for (let i = 0; i < fields.length - 1;) {
    const status = fields[i++];
    if (!/^[ACDMRTUXB][0-9]*$/.test(status)) throw new Error('invalid_git_inventory');
    const oldPath = fields[i++];
    const path = /^[RC]/.test(status) ? fields[i++] : oldPath;
    if (!validPath(path) || !validPath(oldPath)) throw new Error('invalid_git_path');
    entries.push({ path, status: status[0], ...(path !== oldPath ? { oldPath } : {}) });
  }
  return entries;
}
const reasonCode = (error) => /^[a-z_]+$/.test(String(error?.message)) ? error.message : 'git_scope_resolution_failed';

// Content fingerprints, not mtime, bind explicit-file selections to a real
// checkout snapshot. Symlinks are hashed as links, never followed. Missing
// paths are retained as missing (e.g. deleted tracked files).
async function explicitFileFingerprint(root, path) {
  try {
    return await withWorkspaceEntry(root, path, {}, async (full) => {
      const stat = await lstat(full);
      if (stat.isSymbolicLink()) return `symlink:${await readlink(full)}`;
      if (!stat.isFile()) return `other:${stat.mode}`;
      const handle = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        if (!(await handle.stat()).isFile()) throw new Error('unsafe_explicit_file_type');
        const digest = createHash('sha256');
        for await (const chunk of handle.createReadStream({autoClose:false})) digest.update(chunk);
        return `file:${digest.digest('hex')}`;
      } finally { await handle.close(); }
    });
  } catch (error) {
    if (error?.code === 'ENOENT') return 'missing';
    throw error;
  }
}


// Changesets retain per-commit identity. Paths are derived as a distinct
// projection and must never masquerade as a complete ticket patch.
export async function resolveReviewScope(repoRoot, task, reviewTarget = null, signal = null) {
  // Public and internal callers must supply validated typed input.
  const typed = task && typeof task === 'object' && !Array.isArray(task);
  const selectorInput = typed ? (task.type
    ? validateTaskSpec({...emptyTaskSpec('review'),target:{kind:'git',selector:task}}).target.selector
    : validateTaskSpec(task).target.selector) : null;
  if (!typed) return {status:'unresolved',available:false,complete:false,required:true,
    reason:'typed_git_selector_required',paths:[],unresolved:[],unresolvedChanges:null,
    resolvedChanges:0,revisionKey:null,manifestKey:null};
  const requestedParent = selectorInput?.mergeParentIndex ?? reviewTarget?.mergeParentIndex;
  // Explicit union preserves provenance of every independent selector. A
  // partially resolved component never silently shrinks the user's target.
  if (selectorInput?.type === 'union') {
    const parts=[];
    for (const one of selectorInput.selectors) {
      const result=await resolveReviewScope(repoRoot,one,null,signal);
      if (result.status !== 'resolved') return {status:'unresolved',available:false,complete:false,
        required:true,reason:`union_component_${result.reason??result.status}`,paths:[],
        unresolved:[{selector:one.type,reason:result.reason??result.status}],
        resolvedChanges:0,unresolvedChanges:1,revisionKey:null,manifestKey:null};
      parts.push(result);
    }
    const byPath=new Map();
    for (const part of parts) for (const row of part.paths) {
      const existing=byPath.get(row.path);
      if (!existing) byPath.set(row.path,{...row,changes:[...row.changes],oldPaths:[...row.oldPaths]});
      else {
        for (const change of row.changes) {
          if (!existing.changes.some(prior => JSON.stringify(prior) === JSON.stringify(change))) existing.changes.push(change);
        }
        existing.oldPaths=[...new Set([...existing.oldPaths,...row.oldPaths])];
      }
    }
    const paths=[...byPath.values()].sort((a,b)=>a.path.localeCompare(b.path,'en'));
    const changesets=[...new Map(parts.flatMap(part=>part.changesets).map(set=>[hash(set),set])).values()];
    const revisions=[...new Set(parts.flatMap(part=>part.revisions))];
    const revisionKey=hash({selector:'union',members:parts.map(part=>part.revisionKey)});
    return {status:'resolved',available:true,complete:true,required:true,selector:'union',
      revisions,changesets,memberSelectors:parts.map(p=>p.selector),unresolved:[],resolvedChanges:changesets.length,unresolvedChanges:0,
      revisionKey,manifestKey:hash({revisionKey,paths}),paths,total:paths.length,totalKnown:true};
  }

  let selector = null, revisions = [], changesets = [], unresolved = [];
  try {
    const range = selectorInput?.type === 'range' ? [null,selectorInput.left,selectorInput.notation,selectorInput.right] : null;
    const recent = selectorInput?.type === 'recent_commits' ? [null,String(selectorInput.count)] : null;
    const relative = selectorInput?.type === 'relative_ref' ? [null,selectorInput.ref] : null;
    const wantsRecent = !!recent;
    const wantsWorking = ['worktree','staged','unstaged'].includes(selectorInput?.type);
    if (wantsRecent) {
      const count = Number(recent[1]);
      if (!Number.isSafeInteger(count) || count < 1 || count > 128) throw new Error('invalid_recent_commit_count');
      selector = 'recent-first-parent';
      const commits = (await git(repoRoot, ['rev-list','--first-parent',`--max-count=${count}`,'HEAD'],signal))
        .trim().split('\n').filter(Boolean);
      if (commits.length !== count) throw new Error('insufficient_commit_history');
      for (const commit of commits) {
        const family = (await git(repoRoot,['rev-list','--parents','-n','1',commit],signal)).trim().split(/\s+/);
        const parent = family[1] ?? null;
        const entries = parent
          ? nameStatus(await git(repoRoot,['diff','--no-ext-diff','--name-status','-z','-M',parent,commit,'--'],signal))
          : nameStatus(await git(repoRoot,['diff-tree','--root','-r','--no-commit-id','--name-status','-z','-M',commit],signal));
        changesets.push({commit,parent,entries});
      }
      revisions = [...commits,changesets.at(-1).parent].filter(Boolean);
    } else if (relative) {
      selector='relative-ref';
      const reference=await resolveRef(repoRoot,relative[1],signal);
      const head=await resolveRef(repoRoot,'HEAD',signal);
      const base=(await git(repoRoot,['merge-base',reference,head],signal)).trim();
      if (!/^[a-f0-9]{40,64}$/i.test(base)) throw new Error('git_merge_base_not_found');
      revisions=[reference,head,base];
      changesets.push({commit:head,parent:base,entries:nameStatus(await git(repoRoot,
        ['diff','--no-ext-diff','--name-status','-z','-M',base,head,'--'],signal))});
    } else if (selectorInput?.type === 'commit') {
      selector = 'commit';
      const commit = await resolveRef(repoRoot, selectorInput.ref, signal);
      const family = (await git(repoRoot, ['rev-list', '--parents', '-n', '1', commit], signal)).trim().split(/\s+/);
      revisions = [...family];
      const parents = family.slice(1);
      const selected = requestedParent;
      if (parents.length > 1 && !(Number.isInteger(selected) && selected >= 1 && selected <= parents.length)) {
        unresolved.push({ commit, reason: 'ambiguous_merge_parent', parentCount: parents.length });
      } else {
        const parent = parents.length ? parents[(selected ?? 1) - 1] : null;
        const entries = parent
          ? nameStatus(await git(repoRoot, ['diff', '--no-ext-diff', '--name-status', '-z', '-M', parent, commit, '--'], signal))
          : nameStatus(await git(repoRoot, ['diff-tree', '--root', '-r', '--no-commit-id', '--name-status', '-z', '-M', commit], signal));
        changesets.push({ commit, parent, entries });
      }
    } else if (range) {
      const left = await resolveRef(repoRoot, range[1], signal);
      const right = await resolveRef(repoRoot, range[3], signal);
      selector = range[2] === '...' ? 'merge-base-range' : 'direct-range';
      const base = selector === 'merge-base-range' ? (await git(repoRoot, ['merge-base', left, right], signal)).trim() : left;
      revisions = [left, right, base];
      changesets.push({ commit: right, parent: base, entries: nameStatus(await git(repoRoot,
        ['diff', '--no-ext-diff', '--name-status', '-z', '-M', base, right, '--'], signal)) });
    } else if (selectorInput?.type === 'files') {
      selector = 'explicit-files';
      revisions = [await resolveRef(repoRoot, 'HEAD', signal)];
      const entries = [];
      for (const path of selectorInput.paths) {
        if (!validPath(path)) throw new Error('invalid_explicit_file_paths');
        entries.push({path,status:'S',fingerprint:await explicitFileFingerprint(repoRoot,path),source:'explicit_files'});
      }
      changesets.push({commit:null,parent:null,source:'explicit_files',entries});
    } else if (wantsWorking) {
      const stagedOnly = selectorInput.type === 'staged';
      const unstagedOnly = selectorInput.type === 'unstaged';
      selector = stagedOnly ? 'staged' : unstagedOnly ? 'unstaged' : 'worktree';
      revisions = [await resolveRef(repoRoot, 'HEAD', signal)];
      const diffArgs = stagedOnly ? ['diff','--cached'] : unstagedOnly ? ['diff'] : ['diff','HEAD'];
      const entries = nameStatus(await git(repoRoot, [...diffArgs,'--no-ext-diff','--name-status','-z','-M','--'], signal));
      const untracked = selector === 'worktree'
        ? (await git(repoRoot, ['ls-files', '--others', '--exclude-standard', '-z'], signal)).split('\0').filter(Boolean)
        : [];
      if (untracked.some((path) => !validPath(path))) throw new Error('invalid_git_path');
      entries.push(...untracked.map((path) => ({ path, status: 'A' })));
      changesets.push({ commit: revisions[0], parent: null, entries });
    } else {
      const ticket = selectorInput?.type === 'ticket_commits' ? [selectorInput.ticket] : null;
      if (ticket) {
        selector = 'commits-by-key';
        const commits = (await git(repoRoot, ['log', '--format=%H', '-i', '--fixed-strings', '--grep', ticket[0], 'HEAD'], signal)).trim().split('\n').filter(Boolean);
        if (!commits.length) throw new Error('matching_commits_not_found');
        if (commits.length > 128) throw new Error('too_many_matching_commits');
        revisions = commits;
        for (const commit of commits) {
          const family = (await git(repoRoot, ['rev-list', '--parents', '-n', '1', commit], signal)).trim().split(/\s+/);
          const parentCount = family.length - 1;
          if (parentCount > 1 && !(Number.isInteger(requestedParent) && requestedParent >= 1 && requestedParent <= parentCount)) {
            unresolved.push({ commit, reason: 'ambiguous_merge_parent', parentCount });
            continue;
          }
          const parent = parentCount ? family[requestedParent ?? 1] : null;
          const entries = parent
            ? nameStatus(await git(repoRoot, ['diff', '--no-ext-diff', '--name-status', '-z', '-M', parent, commit, '--'], signal))
            : nameStatus(await git(repoRoot, ['diff-tree', '--root', '-r', '--no-commit-id', '--name-status', '-z', '-M', commit], signal));
          changesets.push({ commit, parent, entries });
        }
      }
    }
    if (!selector) return { status: 'unresolved', available: false, required: Boolean(task?.ambiguities?.length), reason: 'git_scope_not_specified', paths: [] };
    // Do not merge by path: distinct changes remain available in changesets,
    // while the file-unit planner receives unique paths with all statuses.
    const byPath = new Map();
    for (const set of changesets) for (const entry of set.entries) {
      const previous = byPath.get(entry.path);
      if (!previous) byPath.set(entry.path, { ...entry,
        oldPaths: entry.oldPath ? [entry.oldPath] : [],
        changes: [{ commit: set.commit, status: entry.status, ...(entry.oldPath ? { oldPath: entry.oldPath } : {}), ...(entry.source ? {source:entry.source, fingerprint:entry.fingerprint} : {}) }] });
      else {
        previous.changes.push({ commit: set.commit, status: entry.status,
          ...(entry.oldPath ? { oldPath: entry.oldPath } : {}), ...(entry.source ? {source:entry.source,fingerprint:entry.fingerprint} : {}) });
        if (entry.oldPath && !previous.oldPaths.includes(entry.oldPath)) previous.oldPaths.push(entry.oldPath);
      }
    }
    const paths = [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path, 'en'));
    const status = unresolved.length ? changesets.length ? 'partial' : 'unresolved' : 'resolved';
    const reason = unresolved[0]?.reason ?? null;
    return { available: status !== 'unresolved', complete: status === 'resolved', status,
      required: true, reason, selector, revisions, changesets, unresolved,
      resolvedChanges: changesets.length, unresolvedChanges: unresolved.length,
      revisionKey: hash({ selector, requestedParent: requestedParent ?? null, revisions, changesets: changesets.map((set) => set.source === 'explicit_files'
        ? [set.commit, set.parent, set.source, set.entries.map(e => [e.path,e.fingerprint])]
        : [set.commit,set.parent]), unresolved }),
      manifestKey: hash({ paths, unresolved }), paths, total: paths.length,
      totalKnown: status === 'resolved' };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { status: 'unresolved', available: false, complete: false, required: true,
      reason: reasonCode(error), paths: [], unresolved: [], unresolvedChanges: null, resolvedChanges: 0,
      revisionKey: null, manifestKey: null };
  }
}

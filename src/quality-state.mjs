// P2: task-owned evidence and findings. Never a second Plan/checkpoint authority.
// All external/model text is untrusted and is recorded as a claim, not a tool result.
import { createHash, randomUUID } from 'node:crypto';
import { sanitizeQualityText as clip } from './quality-privacy.mjs';
import { verificationCheckId, verificationSuiteId } from './verification-inputs.mjs';
import { lstat, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { activeImplementationTask } from './implementation-tasks.mjs';
import { captureRepoState } from './repo.mjs';
import { repositoryFingerprint, buildImplementationStages } from './implementation-stages.mjs';
import { implementationReconciliationChanges } from './implementation-reconciliation.mjs';

const MAX_RECORDS = 800;
const MAX_QUALITY_BYTES = 2_000_000;
const MAX_TEXT = 1200;
const MAX_PATHS = 64;

const digest = (value) => createHash('sha256').update(Buffer.isBuffer(value) ? value : String(value)).digest('hex');
const now = () => new Date().toISOString();
const validPath = (p) => typeof p === 'string' && p.length <= 500 && !path.isAbsolute(p) &&
  !p.split(/[\\/]/).includes('..') && !p.includes('\0') && !p.split(/[\\/]/).includes('.git');

export function ensureQuality(task) {
  if (!task || task.version !== 1 || !task.taskId) throw new Error('Quality state requires an existing implementation task.');
  if (task.quality === undefined || task.quality === null) {
    task.quality = { version: 1, revision: 0, evidence: [], findings: [], decisions: [], attempts: [] };
  }
  const q = task.quality;
  if (q.attempts === undefined) q.attempts = []; // legacy sessions are loadable, not silently reverified
  if (q.version !== 1 || !Number.isSafeInteger(q.revision) || q.revision < 0 ||
      !Array.isArray(q.evidence) || !Array.isArray(q.findings) || !Array.isArray(q.decisions) || !Array.isArray(q.attempts) ||
      [q.evidence, q.findings, q.decisions, q.attempts].some((xs) => xs.length > MAX_RECORDS)) {
    throw new Error('Invalid saved Quality State; refusing to discard evidence or findings.');
  }
  if (Buffer.byteLength(JSON.stringify(q), 'utf8') > MAX_QUALITY_BYTES) throw new Error('Saved Quality State exceeds the size budget.');
  return q;
}

function compactUnverifiedClaims(q) {
  const referenced = new Set(q.findings.flatMap((f) => f.evidenceIds ?? []));
  const latest = new Map();
  for (let i = 0; i < q.evidence.length; i++) {
    const e = q.evidence[i];
    if (e.assessment === 'unverified' && e.source?.kind === 'role_report' &&
        !referenced.has(e.id) && e.subject?.kind !== 'acceptance') {
      latest.set(`${e.subject.kind}:${e.subject.id}:${e.source.role}`, i);
    }
  }
  let removed = 0;
  q.evidence = q.evidence.filter((e, i) => {
    if (e.assessment !== 'unverified' || e.source?.kind !== 'role_report' || referenced.has(e.id) ||
        e.subject?.kind === 'acceptance') return true;
    const keep = latest.get(`${e.subject.kind}:${e.subject.id}:${e.source.role}`) === i;
    if (!keep) removed++;
    return keep;
  });
  if (removed) q.compaction = { supersededUnverifiedClaims: (q.compaction?.supersededUnverifiedClaims ?? 0) + removed };
  return removed;
}

function append(q, kind, record) {
  if (q[kind].length >= MAX_RECORDS) {
    if (kind !== 'evidence' || !compactUnverifiedClaims(q)) throw new Error(`QUALITY_CAPACITY_EXCEEDED:${kind}; export/archive the task before continuing.`);
  }
  q[kind].push(record);
  if (Buffer.byteLength(JSON.stringify(q), 'utf8') > MAX_QUALITY_BYTES) {
    q[kind].pop();
    throw new Error('QUALITY_CAPACITY_EXCEEDED:bytes; no authoritative evidence was discarded.');
  }
  q.revision++;
  return record;
}

// Fingerprint only explicit, bounded dependencies. No HEAD-only freshness:
// tracked, modified and untracked files are evaluated from their contents.
// Unknown dependencies cannot produce a positive freshness assertion.
export async function dependencyFingerprint(repoRoot, relativePath) {
  if (!validPath(relativePath)) return null;
  const contents = await readSafeFile(repoRoot, relativePath);
  if (contents === undefined) return null;
  return contents === null ? 'missing' : digest(contents);
}

// Return bytes only for ordinary files inside the repository, refusing symlink
// traversal and oversized reads. null = absent; undefined = unsafe/unreadable.
async function readSafeFile(repoRoot, relativePath) {
  if (!validPath(relativePath)) return undefined;
  const root = path.resolve(repoRoot);
  const absolute = path.resolve(root, relativePath);
  if (!absolute.startsWith(`${root}${path.sep}`)) return undefined;
  try {
    const stat = await lstat(absolute);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8_000_000) return undefined;
    const parts = path.relative(root, absolute).split(path.sep);
    for (let i = 1; i < parts.length; i++) {
      const parent = await lstat(path.join(root, ...parts.slice(0, i)));
      if (parent.isSymbolicLink() || !parent.isDirectory()) return undefined;
    }
    const fd = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = await fd.stat();
      if (!opened.isFile() || opened.size > 8_000_000 || opened.ino !== stat.ino || opened.dev !== stat.dev) return undefined;
      return await fd.readFile();
    } finally { await fd.close(); }
  } catch (error) {
    return error?.code === 'ENOENT' ? null : undefined;
  }
}

// Deterministically validate review citations against actual source bytes.
// This is grounded source evidence, NOT proof that a static claim is true.
async function inspectSourceAnchors(repoRoot, declaredPaths, anchors) {
  if (!Array.isArray(declaredPaths) || !declaredPaths.length || declaredPaths.length > 8 ||
      declaredPaths.some((p) => !validPath(p)) || new Set(declaredPaths).size !== declaredPaths.length ||
      !Array.isArray(anchors) || anchors.length !== declaredPaths.length) return null;
  if (new Set(anchors.map((a) => a?.path)).size !== anchors.length) return null;
  const entries = [];
  for (const p of declaredPaths) {
    const anchor = anchors.find((a) => a?.path === p);
    if (!anchor || typeof anchor.excerpt !== 'string' || anchor.excerpt.length < 12 || anchor.excerpt.length > 300) return null;
    const contents = await readSafeFile(repoRoot, p);
    if (!contents || !contents.toString('utf8').includes(anchor.excerpt)) return null;
    entries.push({ path: p, fingerprint: digest(contents) });
  }
  return { kind: 'paths', entries: entries.sort((a, b) => a.path.localeCompare(b.path)) };
}

export async function captureDependencies(repoRoot, paths) {
  if (!Array.isArray(paths) || !paths.length || paths.length > MAX_PATHS ||
      paths.some((p) => !validPath(p))) return { kind: 'unknown', paths: [] };
  const unique = [...new Set(paths)].sort();
  const entries = await Promise.all(unique.map(async (p) => ({ path: p, fingerprint: await dependencyFingerprint(repoRoot, p) })));
  return entries.some((x) => x.fingerprint === null)
    ? { kind: 'unknown', paths: unique }
    : { kind: 'paths', entries };
}

export async function freshnessOf(evidence, repoRoot, checkoutState = null) {
  const binding = evidence?.dependencies;
  if (evidence?.inputsStable === false) return 'stale';
  if (!binding || binding.kind === 'unknown') return 'unknown';
  if (binding.kind === 'not_applicable') return 'not_applicable';
  if (binding.kind === 'checkout') {
    // Git is only a partial input witness. A changed checkout invalidates the
    // observation; an unchanged checkout cannot certify ignored files, env,
    // installed tools, external services or dynamic imports.
    try { return repositoryFingerprint(checkoutState ?? await captureRepoState(repoRoot)) === binding.fingerprint ? 'unknown' : 'stale'; }
    catch { return 'unknown'; }
  }
  if (binding.kind !== 'paths' || !Array.isArray(binding.entries) || !binding.entries.length) return 'unknown';
  for (const entry of binding.entries) {
    const actual = await dependencyFingerprint(repoRoot, entry.path);
    if (actual === null) return 'unknown';
    if (actual !== entry.fingerprint) return 'stale';
  }
  for (const item of binding.environment ?? []) {
    const current = digest(process.env[item.name] === undefined ? 'absent' : `present:${process.env[item.name]}`);
    if (current !== item.fingerprint) return 'stale';
  }
  // Source anchoring witnesses only the file bytes, not semantic correctness.
  // For command checks the caller must also declare verified input closure.
  return binding.completeness === 'complete' || ['static_review', 'repository_inspection'].includes(evidence?.source?.kind) ? 'fresh' : 'unknown';
}

// Bindings are durable, so arbitrary model/provider objects cannot become
// persistence payloads. Nonconforming metadata degrades to unknown instead.
function boundedEvidenceDependencies(value) {
  if (value?.kind === 'not_applicable') return { kind: 'not_applicable' };
  if (value?.kind === 'checkout') return typeof value.fingerprint === 'string' && /^[a-f0-9]{64}$/.test(value.fingerprint)
    ? { kind: 'checkout', fingerprint: value.fingerprint } : { kind: 'unknown' };
  if (value?.kind === 'paths' && Array.isArray(value.entries) && value.entries.length > 0 &&
      value.entries.length <= MAX_PATHS && value.entries.every((entry) => validPath(entry?.path) &&
        clip(entry.path) === entry.path && (entry.fingerprint === 'missing' ||
          (typeof entry.fingerprint === 'string' && /^[a-f0-9]{64}$/.test(entry.fingerprint))))) {
    const environment = value.environment;
    if (environment !== undefined && (!Array.isArray(environment) || environment.length > 16 ||
      environment.some((entry) => typeof entry?.name !== 'string' ||
        !/^[A-Z_][A-Z0-9_]{0,79}$/i.test(entry.name) ||
        /(?:TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE|AUTH|CREDENTIAL|COOKIE|API_KEY|ACCESS_KEY)/i.test(entry.name) ||
        !/^[a-f0-9]{64}$/.test(entry.fingerprint)))) return { kind: 'unknown' };
    return { kind: 'paths', entries: value.entries.map(({ path: filename, fingerprint }) => ({ path: filename, fingerprint })),
      ...(environment?.length ? { environment: environment.map(({ name, fingerprint }) => ({ name, fingerprint })) } : {}),
      ...(value.completeness === 'complete' ? { completeness: 'complete' } : {}) };
  }
  return { kind: 'unknown' };
}

export function recordEvidence(task, { subject, claim, source, assessment = 'unverified', outcome = 'unknown', dependencies = { kind: 'unknown' }, runId = null, attemptId = null, inputsStable = null }) {
  const q = ensureQuality(task);
  if (!subject?.id || !['acceptance', 'stage', 'finding', 'contract', 'verification'].includes(subject.kind) ||
      !['observed', 'supported', 'hypothesis', 'unverified'].includes(assessment) ||
      !['pass', 'fail', 'unavailable', 'unknown'].includes(outcome) || !source?.kind) {
    throw new Error('Invalid evidence contract.');
  }
  subject = { kind: subject.kind, id: clip(subject.id, 150) };
  dependencies = boundedEvidenceDependencies(dependencies);
  const safeSource = { kind: clip(source.kind, 80), ...(source.checkId || source.command ? { checkId: source.checkId ?? verificationCheckId(source.command) } : {}),
    ...(source.role ? { role: clip(source.role, 80) } : {}) };
  const key = digest(JSON.stringify({ subject, claim: clip(claim), source: safeSource, dependencies, runId, attemptId, inputsStable }));
  const previous = q.evidence.find((entry) => entry.key === key);
  if (previous) return previous; // idempotent replay (do not inflate certainty)
  return append(q, 'evidence', {
    id: randomUUID(), key, taskId: task.taskId, subject, claim: clip(claim),
    source: safeSource, assessment, outcome,
    dependencies, runId, attemptId, inputsStable, createdAt: now(),
  });
}

// A stable UUID owns the finding lifecycle. Identity is only an exact,
// conservative observation signature, not permission to merge every issue
// reported under the same broad contract and reproduction category.
// Legacy version-2 identities were too coarse; they are retained on saved
// findings so existing decisions remain bound to their original records.
const normalizedFindingText = (text, max = MAX_TEXT) =>
  clip(text ?? '', max).trim().toLowerCase().replace(/\s+/g, ' ');

export const findingIdentity = (issue) => digest(JSON.stringify({
  version: 3,
  contract: normalizedFindingText(issue?.contractId ?? issue?.violatedContract, 300),
  scenario: normalizedFindingText(issue?.reproductionKey ?? issue?.reproductionScenario ?? issue?.scenario, 500),
  location: validPath(issue?.path) ? issue.path : '',
  // Both the violated assertion and its witness are needed to avoid silently
  // collapsing distinct defects sharing a generic contract/scenario/file.
  assertion: normalizedFindingText(issue?.message),
  witness: normalizedFindingText(issue?.evidence ?? issue?.message),
}));

function matchingFinding(q, issue) {
  const identity = findingIdentity(issue);
  const title = clip(issue.message, 160);
  const description = clip(issue.evidence ?? issue.message);
  const paths = validPath(issue.path) ? [issue.path] : [];
  return q.findings.find((f) =>
    (f.identityVersion === 3 && f.identity === identity) ||
    // Legacy identity (including v2) must NOT authorize coarse semantic
    // merging. Exact original description/location can still be replayed.
    (f.identityVersion !== 3 && f.title === title && f.description === description &&
      JSON.stringify(f.affectedPaths ?? []) === JSON.stringify(paths) &&
      normalizedFindingText(f.contractId, 300) === normalizedFindingText(issue.contractId ?? issue.violatedContract, 300) &&
      normalizedFindingText(f.reproductionKey, 500) === normalizedFindingText(issue.reproductionKey ?? issue.reproductionScenario ?? issue.scenario, 500)));
}

// Preserve legacy finding identities when binding a new user decision to a
// pre-existing saved finding. Distinct v3 observations remain distinct keys.
function findingKeyForIssue(q, issue) {
  return matchingFinding(q, issue)?.identity ?? findingIdentity(issue);
}

function observedRegressionEvidence(q, finding, id) {
  const evidence = q.evidence.find((e) => e.id === id);
  if (!evidence || evidence.source?.kind !== 'tool_execution' ||
      evidence.assessment !== 'observed' || evidence.outcome !== 'fail' ||
      !evidence.source.checkId || !evidence.runId) return false;
  const earlierFailures = finding.evidenceIds.map((ref) => q.evidence.find((e) => e.id === ref))
    .filter((e) => e?.source?.kind === 'tool_execution' && e.assessment === 'observed' && e.outcome === 'fail');
  if (!earlierFailures.some((e) => e.source.checkId === evidence.source.checkId)) return false;
  const resolution = q.evidence.find((e) => e.id === finding.resolutionEvidenceId) ??
    [...finding.evidenceIds].reverse().map((ref) => q.evidence.find((e) => e.id === ref))
      .find((e) => e?.source?.kind === 'tool_execution' && e.assessment === 'observed' && e.outcome === 'pass');
  if (!resolution?.runId || !q.evidence.includes(resolution)) return false;
  return q.evidence.indexOf(evidence) > q.evidence.indexOf(resolution) &&
    evidence.runId !== resolution.runId &&
    earlierFailures.some((e) => e.source.checkId === evidence.source.checkId && e.runId !== evidence.runId);
}

export function recordFinding(task, issue, { source = 'reviewer', evidenceIds = [] } = {}) {
  const q = ensureQuality(task);
  if (!issue || typeof issue.message !== 'string' || !issue.message.trim()) return null;
  const identity = findingIdentity(issue);
  const previous = matchingFinding(q, issue);
  const evidence = [...new Set(evidenceIds.filter((id) => q.evidence.some((e) => e.id === id)))];
  if (previous) {
    const newRegressionIds = previous.lifecycle === 'resolved' ? evidence.filter((id) =>
      observedRegressionEvidence(q, previous, id)) : [];
    if (newRegressionIds.length) {
      previous.lifecycle = 'reopened';
      previous.transitions.push({ state: 'reopened', at: now(), reason: 'new_observed_regression' });
    }
    // A repeated, unverified role assertion must neither reopen a resolved
    // defect nor upgrade its severity to change the user's earlier decision.
    const severityOrder = { info: 0, minor: 1, major: 2, blocking: 3 };
    const newSeverity = ['blocking', 'major', 'minor', 'info'].includes(issue.severity) ? issue.severity : 'info';
    let changed = newRegressionIds.length > 0;
    if (previous.lifecycle !== 'resolved' && severityOrder[newSeverity] > severityOrder[previous.severity]) {
      previous.transitions.push({ state: previous.lifecycle, at: now(),
        reason: `severity_escalated:${previous.severity}->${newSeverity}` });
      previous.severity = newSeverity;
      if (newSeverity === 'blocking') previous.taskImpact = 'blocking';
      changed = true;
    }
    const updatedEvidence = [...new Set([...previous.evidenceIds, ...evidence])];
    if (updatedEvidence.length !== previous.evidenceIds.length) {
      previous.evidenceIds = updatedEvidence;
      changed = true;
    }
    if (!previous.reportedBy.includes(source)) {
      previous.reportedBy.push(source);
      changed = true;
    }
    if (changed) q.revision++;
    return previous;
  }
  const severity = ['blocking', 'major', 'minor', 'info'].includes(issue.severity) ? issue.severity : 'info';
  const permission = issue.remediationScope === 'in_scope' ? 'authorized_by_existing_scope' : 'requires_scope_check';
  // Conservative hints for a human/role: never merge based on text or path alone.
  const possibleDuplicateIds = q.findings.filter((f) =>
    f.identity !== identity && validPath(issue.path) && f.affectedPaths?.includes(issue.path) &&
    (f.title === clip(issue.message, 160) || (issue.contractId && f.contractId === clip(issue.contractId, 300))))
    .map((f) => f.id).slice(0, 8);
  return append(q, 'findings', {
    id: randomUUID(), taskId: task.taskId, identity, identityVersion: 3, title: clip(issue.message, 160),
    description: clip(issue.evidence ?? issue.message), severity,
    confidence: 'hypothesis', lifecycle: 'candidate',
    origin: clip(issue.origin ?? 'unknown', 60), taskRelation: clip(issue.taskRelation ?? 'unknown', 60),
    contractId: clip(issue.contractId ?? issue.violatedContract ?? '', 300),
    reproductionKey: clip(issue.reproductionKey ?? issue.reproductionScenario ?? issue.scenario ?? '', 500),
    taskImpact: severity === 'blocking' ? 'blocking' : 'undetermined',
    remediationAuthorization: permission, affectedPaths: validPath(issue.path) ? [issue.path] : [],
    evidenceIds: evidence, possibleDuplicateIds, reportedBy: [source], transitions: [{ state: 'candidate', at: now(), reason: 'reported' }],
    createdAt: now(),
  });
}

function applyFindingTransition(task, id, state, evidenceIds = [], { resolutionFresh = false } = {}) {
  const q = ensureQuality(task);
  const finding = q.findings.find((f) => f.id === id);
  if (!finding || !['confirmed', 'disputed', 'resolved', 'reopened'].includes(state)) throw new Error('Unknown finding or state');
  if (!evidenceIds.length || evidenceIds.some((x) => !q.evidence.some((e) => e.id === x))) throw new Error('Finding transition requires saved evidence');
  if (finding.lifecycle === 'resolved' && state !== 'resolved' && state !== 'reopened')
    throw new Error('Resolved finding requires new observed regression evidence before reopening');
  if (state === 'reopened' && (finding.lifecycle !== 'resolved' ||
      !evidenceIds.some((id) => observedRegressionEvidence(q, finding, id))))
    throw new Error('Finding reopening requires a new relevant observed regression');
  if (state === 'resolved' && (!resolutionFresh || !evidenceIds.some((id) => {
    const priorFailures = finding.evidenceIds.map((ref) => q.evidence.find((x) => x.id === ref)).filter((e) =>
      e?.source?.kind === 'tool_execution' && e.assessment === 'observed' && e.outcome === 'fail');
    if (!priorFailures.length) return false;
    const e = q.evidence.find((item) => item.id === id);
    return e?.outcome === 'pass' && e?.source?.kind === 'tool_execution' && e.assessment === 'observed' &&
      e.inputsStable === true && e.dependencies?.kind === 'paths' && e.dependencies.completeness === 'complete' &&
      priorFailures.some((failed) => failed.source.checkId === e.source.checkId && failed.runId !== e.runId &&
        JSON.stringify(failed.dependencies) !== JSON.stringify(e.dependencies));
  }))) throw new Error('Finding resolution requires fresh, independently observed passing verification with complete dependencies');
  finding.evidenceIds = [...new Set([...finding.evidenceIds, ...evidenceIds])];
  finding.lifecycle = state;
  if (state === 'resolved') finding.resolutionEvidenceId = evidenceIds.find((id) =>
    q.evidence.find((e) => e.id === id)?.outcome === 'pass');
  finding.transitions.push({ state, at: now(), reason: state === 'reopened' ? 'new_observed_regression' : 'evidence_updated' });
  q.revision++;
  return finding;
}

// Non-resolution transitions stay synchronous for existing role/workflow callers.
// A direct resolved transition is deliberately unavailable: freshness requires
// reading the *current* checkout, which is asynchronous. This is the only
// exported entry point for recording a resolved finding.
export function transitionFinding(task, id, state, evidenceIds = []) {
  if (state === 'resolved') throw new Error('Finding resolution requires resolveFinding with the current repository');
  return applyFindingTransition(task, id, state, evidenceIds);
}

export async function resolveFinding(task, id, evidenceIds, repoRoot) {
  if (typeof repoRoot !== 'string' || !repoRoot.trim())
    throw new Error('Finding resolution requires a current repository root');
  const q = ensureQuality(task);
  if (!Array.isArray(evidenceIds) || !evidenceIds.length)
    throw new Error('Finding resolution requires saved evidence');
  const candidates = evidenceIds.map((ref) => q.evidence.find((e) => e.id === ref));
  if (candidates.some((e) => !e)) throw new Error('Finding resolution requires saved evidence');
  const statuses = await Promise.all(candidates.map((e) => freshnessOf(e, repoRoot)));
  // An unknown, stale or unbound PASS must not close a finding. If the check
  // came from a recorded verification attempt, that attempt must be stable.
  const admissible = candidates.filter((e, i) => {
    const attempt = e.attemptId ? q.attempts.find((a) => a.id === e.attemptId) : null;
    return statuses[i] === 'fresh' && (!e.attemptId ||
      (attempt?.status === 'completed' && attempt.checkoutStable === true));
  });
  if (!admissible.length) throw new Error('Finding resolution requires currently fresh verification evidence');
  // Structural relevance (same failed check, different run, changed inputs)
  // is still enforced by the authoritative transition itself.
  return applyFindingTransition(task, id, 'resolved', admissible.map((e) => e.id), { resolutionFresh: true });
}

function subjectStateKey(q, keys) {
  return digest(JSON.stringify(q.findings.filter((f) => keys.includes(f.identity))
    .map((f) => ({ id: f.id, identity: f.identity, lifecycle: f.lifecycle, severity: f.severity,
      taskImpact: f.taskImpact, remediationAuthorization: f.remediationAuthorization,
      evidenceIds: f.evidenceIds ?? [] })).sort((a, b) => a.id.localeCompare(b.id))));
}

function decisionSubjectsCurrent(q, gate) {
  // Legacy gates that name findings but lack a persisted subject binding
  // cannot grant permissions or be reused after a change to those findings.
  if (!gate.subjectStateKey) return !(gate.subjectKeys?.length || gate.findingKeys?.length);
  return gate.subjectStateKey === subjectStateKey(q, gate.subjectKeys ?? []);
}

export function proposeDecision(task, { kind, summary, rationale, options, stateBinding, subjectKeys = [] }) {
  const q = ensureQuality(task);
  if (!kind || !summary || !Array.isArray(options) || options.length < 2 ||
      options.some((o) => !o?.id || typeof o.description !== 'string') ||
      !stateBinding?.planId || !stateBinding?.repositoryFingerprint) throw new Error('Invalid decision gate');
  const subjects = [...new Set(subjectKeys)].sort();
  if (subjects.some((key) => typeof key !== 'string' || key.length > 128)) throw new Error('Invalid decision subjects');
  const signature = digest(JSON.stringify({ kind, summary, options, stateBinding, subjects }));
  // A resolved gate with unchanged checkout is NOT reusable after its finding
  // changes. Invalidate it in the authoritative task state before reissuing.
  const existing = q.decisions.findLast((d) => d.signature === signature && ['pending', 'resolved'].includes(d.status));
  if (existing && decisionSubjectsCurrent(q, existing)) return existing;
  for (const d of q.decisions) if (d.signature === signature && ['pending', 'resolved'].includes(d.status) &&
      !decisionSubjectsCurrent(q, d)) {
    d.status = 'invalidated'; d.invalidatedAt = now(); q.revision++;
  }
  // An invalidated/expired gate cannot be reused: the user must see a fresh gate ID.
  for (const d of q.decisions) if (d.kind === kind && d.status === 'pending') {
    d.status = 'invalidated'; d.invalidatedAt = now();
  }
  return append(q, 'decisions', {
    id: randomUUID(), taskId: task.taskId, signature, kind, status: 'pending',
    summary: clip(summary), rationale: clip(rationale),
    options: options.map((o) => ({ id: clip(o.id, 60), description: clip(o.description, 400) })),
    stateBinding, subjectKeys: subjects, subjectStateKey: subjectStateKey(q, subjects), createdAt: now(),
  });
}

// Caller must supply an independently re-read repository/Plan binding. This
// records a user's choice, never grants arbitrary tool or write permissions.
export function resolveDecision(task, id, optionId, stateBinding, { userInitiated = false } = {}) {
  if (!userInitiated) throw new Error('Only an explicit host-verified user choice may resolve a gate');
  const q = ensureQuality(task);
  const gate = q.decisions.find((d) => d.id === id);
  if (!gate) throw new Error('Decision gate not found');
  const previouslyDeclined = gate.status === 'resolved' && gate.selection === 'decline';
  if (gate.status !== 'pending' && !(gate.status === 'resolved' && gate.selection === optionId) && !previouslyDeclined) {
    throw new Error('Decision gate is no longer pending');
  }
  if (JSON.stringify(gate.stateBinding) !== JSON.stringify(stateBinding) ||
      !decisionSubjectsCurrent(q, gate)) {
    gate.status = 'invalidated'; gate.invalidatedAt = now(); q.revision++;
    return gate; // persist invalidation, do not throw and roll it back
  }
  if (!gate.options.some((o) => o.id === optionId)) throw new Error('Unknown decision option');
  if (gate.status === 'resolved' && gate.selection === optionId) return gate;
  // An explicit user may reconsider a refusal while the inspected state is
  // IDENTICAL. Never silently reverse an authorization after it was granted.
  if (previouslyDeclined) {
    gate.amendments = [...(gate.amendments ?? []), { from: 'decline', to: optionId, at: now() }];
  }
  gate.status = 'resolved'; gate.selection = optionId; gate.resolvedAt = now(); q.revision++;
  return gate;
}

// Persist the start *before* invoking a verification command. If the process
// crashes or the provider cancels, the saved started attempt prevents a stale
// successful suite from being treated as current. Not a second checkpoint.
export function beginVerificationAttempt(task, attempt) {
  const q = ensureQuality(task);
  if (!attempt || typeof attempt.id !== 'string' ||
      !['mandatory_final', 'targeted'].includes(attempt.phase) ||
      !Array.isArray(attempt.requiredCheckIds) || attempt.requiredCheckIds.length > 65 ||
      !attempt.requiredCheckIds.every((id) => /^[a-f0-9]{64}$/.test(id))) {
    throw new Error('Invalid verification attempt start');
  }
  const existing = q.attempts.find((x) => x.id === attempt.id);
  if (existing) return existing;
  return append(q, 'attempts', {
    id: attempt.id, phase: attempt.phase, suiteId: clip(attempt.suiteId, 80),
    requiredCheckIds: [...attempt.requiredCheckIds], observedCheckIds: [],
    status: 'started', startedAt: attempt.startedAt ?? now(), createdAt: now(),
    checkoutStable: false,
  });
}

// A failure is a direct observation of a failure, not evidence that a criterion passes.
// Reviewer claims are model assertions. A verified review requires traceable
// matching executed verification before the Matrix can mark it observed.
export async function ingestWorkflowResult(task, result, repoRoot, { runId = randomUUID(), trustedDependencyClosures = null } = {}) {
  if (!task?.plan || !result || typeof result !== 'object') return;
  const plan = task.plan.plan;
  const checks = Array.isArray(result.verification) ? result.verification : [];
  const q = ensureQuality(task);
  const supplied = result.verificationAttempt;
  // Only execution-owned runVerification produces this observation contract.
  // Legacy or manually reconstructed results remain diagnostically useful but
  // cannot gain an observed current-run PASS just by having a result array.
  const validAttempt = supplied && typeof supplied.id === 'string' &&
    ['targeted', 'mandatory_final'].includes(supplied.phase) &&
    Array.isArray(supplied.requiredCheckIds) && Array.isArray(supplied.observedCheckIds) &&
    supplied.requiredCheckIds.length <= 65 &&
    supplied.requiredCheckIds.every((x) => /^[a-f0-9]{64}$/.test(x)) &&
    supplied.observedCheckIds.every((x) => /^[a-f0-9]{64}$/.test(x));
  const attempt = validAttempt ? {
    id: supplied.id, runId, phase: supplied.phase, suiteId: clip(supplied.suiteId, 80),
    requiredCheckIds: [...supplied.requiredCheckIds],
    observedCheckIds: [...supplied.observedCheckIds],
    status: supplied.status === 'completed' ? 'completed' : 'interrupted',
    startedAt: supplied.startedAt, completedAt: supplied.completedAt,
    // Missing explicit checkout observation is not proof of stability.
    checkoutStable: result.verificationWorkspaceChanged === false,
    createdAt: now(),
  } : {
    id: randomUUID(), runId, phase: 'legacy_unknown', suiteId: null,
    requiredCheckIds: [], observedCheckIds: [], status: 'unverified',
    checkoutStable: false, createdAt: now(),
  };
  const priorAttempt = q.attempts.find((a) => a.id === attempt.id);
  if (priorAttempt) Object.assign(priorAttempt, attempt);
  else append(q, 'attempts', attempt);
  q.activeAttemptId = attempt.id;
  // Git metadata alone is not an exhaustive witness of tool dependencies.
  const deps = result.verificationRepoKey && result.verificationWorkspaceChanged !== true
    ? { kind: 'checkout', fingerprint: result.verificationRepoKey } : { kind: 'unknown' };
  const commandEvidence = new Map();
  for (const check of checks) {
    if (!check?.command || typeof check.command !== 'string') continue;
    const checkId = verificationCheckId(check.command);
    const observed = Number.isInteger(check.exitCode);
    const outcome = observed && check.status === 'PASS' && (check.exitCode === 0 || check.diagnostic?.accepted === true) ? 'pass'
      : observed && check.status === 'TEST_FAILED' ? 'fail' : 'unavailable';
    // Never construct a fingerprint *after* execution as if it were pre-run evidence.
    // Old synthetic checks without pre/post witnesses can only be legacy reports.
    const witness = check.inputBefore?.kind === 'paths' && check.inputAfter?.kind === 'paths' &&
      check.inputsStable === true && JSON.stringify(check.inputBefore) === JSON.stringify(check.inputAfter);
    const checkDeps = witness ? check.inputAfter : deps;
    const e = recordEvidence(task, {
      subject: { kind: 'verification', id: checkId },
      claim: `Configured verification ${checkId.slice(0, 12)}: ${clip(check.status, 40)}`,
      source: { kind: 'tool_execution', checkId },
      assessment: observed ? 'observed' : 'unverified', outcome,
      dependencies: checkDeps, runId, attemptId: attempt.id,
      inputsStable: check.inputsStable === false ? false : witness ? true : null,
    });
    commandEvidence.set(check.command.trim(), e);
  }
  for (const row of result.review?.acceptanceResults ?? []) {
    if (!/^A\d+$/.test(row?.id) || Number(row.id.slice(1)) > (plan?.acceptanceCriteria?.length ?? 0)) continue;
    const declared = (plan?.acceptanceChecks ?? []).find((x) => x?.id === row.id)?.commands ?? [];
    // An independent reviewer mentioning a successful command is not enough:
    // the Plan must also declare that this exact check exercises the criterion.
    const matching = [...commandEvidence.entries()].filter(([command]) =>
      declared.includes(command) && String(row.evidence ?? '').includes(command));
    recordEvidence(task, {
      subject: { kind: 'acceptance', id: row.id }, claim: `Independent review assertion for criterion ${row.id}`,
      source: { kind: 'role_report', role: 'reviewer' }, assessment: row.status === 'verified' ? 'supported' : 'unverified',
      outcome: 'unknown', // a model's blocked verdict is not an observed code failure
      dependencies: deps, runId, attemptId: attempt.id,
    });
    for (const [, observed] of matching) {
      if (row.status === 'verified') recordEvidence(task, {
        subject: { kind: 'acceptance', id: row.id },
        claim: `Correlated reviewer criterion ${row.id} with check ${observed.source.checkId.slice(0, 12)}`,
        source: { kind: 'correlation', checkId: observed.source.checkId },
        assessment: observed.assessment === 'observed' ? 'supported' : 'unverified',
        outcome: observed.outcome, dependencies: observed.dependencies, runId, attemptId: attempt.id,
      });
    }
    // Non-runtime acceptance: anchor independent reviewer analysis to actual
    // repository contents, as declared in the Plan. Semantic correctness is
    // still a reviewer assessment, not a trusted tool-execution result.
    const sourcePaths = (plan?.acceptanceReviews ?? []).find((x) => x?.id === row.id)?.paths;
    if (row.status === 'verified' && result.review?.verdict === 'pass' &&
        (!declared.length) && sourcePaths?.length) {
      const inspected = await inspectSourceAnchors(repoRoot, sourcePaths, row.sourceAnchors);
      if (inspected) recordEvidence(task, {
        subject: { kind: 'acceptance', id: row.id },
        claim: `Independent source-anchored review for criterion ${row.id}`,
        source: { kind: 'static_review', role: 'reviewer' },
        assessment: 'supported', outcome: 'pass', dependencies: inspected, runId,
      });
    }
  }
  for (const [role, issues] of [['reviewer', result.review?.issues ?? []],
    ['finalValidator', result.finalValidation?.issues ?? []], ['workflow', result.unresolvedFindings ?? []]]) {
    for (const issue of issues) {
      const finding = recordFinding(task, issue, { source: role });
      if (!finding) continue;
      const claim = recordEvidence(task, { subject: { kind: 'finding', id: finding.id },
        claim: issue.evidence ?? issue.message, source: { kind: 'role_report', role },
        assessment: 'supported', outcome: 'unknown', dependencies: deps, runId });
      finding.evidenceIds = [...new Set([...finding.evidenceIds, claim.id])];
      const failure = [...commandEvidence.entries()].find(([cmd, e]) =>
        e.assessment === 'observed' && e.outcome === 'fail' &&
        (String(issue.evidence ?? '').includes(cmd) || String(issue.message ?? '').includes(cmd)));
      if (failure) {
        // A regression stays visibly reopened (instead of bouncing through
        // confirmed and obscuring the resolved -> reopened transition).
        if (finding.lifecycle === 'resolved') transitionFinding(task, finding.id, 'reopened', [failure[1].id]);
        else if (!['confirmed', 'reopened'].includes(finding.lifecycle)) transitionFinding(task, finding.id, 'confirmed', [failure[1].id]);
        else finding.evidenceIds = [...new Set([...finding.evidenceIds, failure[1].id])];
        finding.confidence = 'observed';
      }
    }
  }
  // Corroborated independent static findings may be confirmed with SUPPORTED
  // confidence (never OBSERVED). Two agreeing role reports and the final
  // validator's explicit defect assessment are needed; repeated prose from a
  // single role is insufficient. This can support an explicit risk gate.
  if (result.finalValidation?.verdict === 'fix' &&
      result.finalValidation?.assessment?.correctness === 'defect_confirmed') {
    const reviewerKeys = new Set((result.review?.issues ?? []).map((issue) => findingKeyForIssue(q, issue)));
    const validatorKeys = new Set((result.finalValidation?.issues ?? []).map((issue) => findingKeyForIssue(q, issue)));
    for (const finding of ensureQuality(task).findings) {
      if (finding.lifecycle !== 'candidate' || !reviewerKeys.has(finding.identity) ||
          !validatorKeys.has(finding.identity)) continue;
      const modelEvidence = finding.evidenceIds.filter((id) => {
        const e = ensureQuality(task).evidence.find((x) => x.id === id);
        return e?.source?.kind === 'role_report' &&
          ['reviewer', 'finalValidator'].includes(e.source.role);
      });
      const roles = new Set(modelEvidence.map((id) => ensureQuality(task).evidence.find((e) => e.id === id)?.source.role));
      if (roles.size === 2) {
        transitionFinding(task, finding.id, 'confirmed', modelEvidence);
        finding.confidence = 'supported';
      }
    }
  }
  // A confirmed, test-backed finding may be closed only by a NEW observed
  // PASS of its failing command in a different checkout, plus agreement from
  // both independent review and final validation. A generic reviewer PASS,
  // unknown freshness or a role-reported test never resolves a finding.
  const reportedNow = new Set([
    ...(result.review?.issues ?? []), ...(result.finalValidation?.issues ?? []),
    ...(result.unresolvedFindings ?? []),
  ].map((issue) => findingKeyForIssue(q, issue)));
  if (result.review?.verdict === 'pass' && result.finalValidation?.verdict === 'pass' &&
      result.finalValidation?.assessment?.taskCompliance !== 'incomplete' &&
      checks.length > 0 && checks.every((c) => c.status === 'PASS' && c.exitCode === 0)) {
    for (const finding of q.findings) {
      if (!['confirmed', 'reopened'].includes(finding.lifecycle) || reportedNow.has(finding.identity)) continue;
      // A changed checkout is insufficient: demand a reported mutation to the
      // affected source path. If localization is unknown, resolution stays open.
      if (!finding.affectedPaths.length || !finding.affectedPaths.some((p) =>
        Array.isArray(result.changedPaths) && result.changedPaths.includes(p))) continue;
      const priorFailing = finding.evidenceIds.map((id) => q.evidence.find((e) => e.id === id)).filter((e) =>
        e?.source?.kind === 'tool_execution' && e.assessment === 'observed' && e.outcome === 'fail');
      const passing = priorFailing.map((failure) => [...commandEvidence.values()].find((e) => e.source.checkId === failure.source.checkId))
        .find((e) => e?.assessment === 'observed' && e.outcome === 'pass' &&
          e.inputsStable === true && e.dependencies?.kind === 'paths' && e.dependencies.completeness === 'complete');
      if (passing && await freshnessOf(passing, repoRoot) === 'fresh' &&
          priorFailing.some((failure) => JSON.stringify(failure.dependencies) !== JSON.stringify(passing.dependencies))) {
        await resolveFinding(task, finding.id, [passing.id], repoRoot);
        finding.confidence = 'observed';
      }
    }
  }
  q.lastRun = { runId, attemptId: attempt.id, status: clip(result.status, 80), timestamp: now() };
  q.revision++;
}

// Acceptance for command-bound criteria is conjunctive and run-scoped. A PASS
// of one command cannot mask another failed, missing or unavailable command.
// Never assemble a synthetic passing suite out of unrelated previous runs.
export async function evidenceMatrix(task, repoRoot, { currentAttemptId = null } = {}) {
  const q = qualityForRead(task);
  const plan = task.plan?.plan ?? {};
  const criteria = plan.acceptanceCriteria ?? [];
  let checkoutState = null;
  if (q.evidence.some((e) => e.dependencies?.kind === 'checkout')) {
    try { checkoutState = await captureRepoState(repoRoot); } catch { /* unknown */ }
  }
  const statuses = await Promise.all(q.evidence.map(async (e) => ({
    ...e, freshness: await freshnessOf(e, repoRoot, checkoutState),
  })));
  return criteria.map((criterion, i) => {
    const id = `A${i + 1}`;
    const evidence = statuses.filter((e) => e.subject.kind === 'acceptance' && e.subject.id === id);
    const commands = (plan.acceptanceChecks ?? []).find((x) => x.id === id)?.commands ?? [];
    const anchored = evidence.some((e) => e.source.kind === 'static_review' &&
      e.assessment === 'supported' && e.outcome === 'pass' && e.freshness === 'fresh');

    // An explicit mandatory generation is authoritative even if it recorded
    // no checks. Older PASS observations cannot be inherited by a new attempt.
    const latestAttempt = q.attempts?.at(-1); // any newer attempt blocks reuse of an older verdict
        const requiredIds = commands.map(verificationCheckId);
    const latest = latestAttempt ? statuses.filter((e) => e.subject.kind === 'verification' &&
      e.attemptId === latestAttempt.id && requiredIds.includes(e.source.checkId)) : [];
    const reviews = evidence.filter((e) => e.source.kind === 'role_report' &&
      e.source.role === 'reviewer' && e.assessment === 'supported' &&
      latestAttempt && e.attemptId === latestAttempt.id);
    const correlated = evidence.filter((e) => e.source.kind === 'correlation' &&
      e.assessment === 'supported' && e.outcome === 'pass' && e.attemptId === latestAttempt?.id);
    const suiteComplete = latestAttempt?.status === 'completed' &&
      latestAttempt.phase === 'mandatory_final' &&
      requiredIds.every((id) => latestAttempt.requiredCheckIds.includes(id) &&
        latestAttempt.observedCheckIds.includes(id));
    // A command may leave its declared inputs untouched while modifying OTHER
    // checkout files. No durable or current-run PASS certifies that final state.
    const allCommandsPass = commands.length > 0 && suiteComplete && latestAttempt.checkoutStable === true && requiredIds.every((id) =>
      latest.some((e) => e.source.checkId === id && e.assessment === 'observed' &&
        e.outcome === 'pass' && e.inputsStable !== false && e.freshness === 'fresh') &&
      correlated.some((e) => e.source.checkId === id));
    const commandPass = allCommandsPass && reviews.length > 0;
    const observedCurrent = commands.length > 0 && suiteComplete && latestAttempt.checkoutStable &&
      latestAttempt.id === currentAttemptId && reviews.length > 0 &&
      requiredIds.every((id) => latest.some((e) => e.source.checkId === id &&
        e.assessment === 'observed' && e.outcome === 'pass' && e.inputsStable !== false && e.freshness !== 'stale') &&
        correlated.some((e) => e.source.checkId === id));
    const reviewAttested = commands.length === 0 && anchored;
    const positive = commandPass;
    const currentOnly = !positive && observedCurrent;
    // An observed failed check must remain visible even when its full input
    // closure is unknown. Only a demonstrably stale failure can be downgraded
    // to a revalidation need; reviewer prose never masks a real failure.
    const failure = latest.some((e) => e.assessment === 'observed' && e.outcome === 'fail' && e.freshness !== 'stale');
    const contradiction = failure && reviews.length > 0;
    const checkoutRevalidation = commands.length > 0 && latestAttempt?.status === 'completed' &&
      latestAttempt.checkoutStable === false;
    const stale = commands.length ? checkoutRevalidation || latest.some((e) => e.freshness === 'stale') :
      evidence.some((e) => e.freshness === 'stale');
    const state = contradiction ? 'conflict' : failure ? 'failed' : positive ? 'verified' : currentOnly ? 'verified_current_run'
      : stale ? 'revalidation_required' : reviewAttested ? 'supported' : 'not_verified';
    return {
      id, criterion, state,
      proofMethod: commandPass ? 'observed_command_with_review' : currentOnly ? 'observed_current_run_not_reusable'
        : reviewAttested ? 'source_attested_not_semantically_verified' : null,
      evidence: [...evidence, ...latest],
      nextAction: failure ? 'investigate_failure' : positive || currentOnly ? null
        : commands.length > 0 ? 'execute_mandatory_suite_and_review_or_provide_complete_input_binding'
          : 'run_deterministic_contract_assertion_or_report_supported_only',
    };
  });
}

export async function assessRecovery(task, repoRoot) {
  const q = qualityForRead(task);
  const checkpoint = task.checkpoint;
  const plan = task.plan;
  let checkoutState = null;
  try { checkoutState = await captureRepoState(repoRoot); } catch { /* uninspectable */ }
  const activeAttempt = q.attempts?.at(-1);
  const values = await Promise.all(q.evidence.map(async (e) => {
    const measured = await freshnessOf(e, repoRoot, checkoutState);
    // An older successful verification cannot be recommended as reusable
    // when a newer mandatory attempt is incomplete/failed or from another suite.
    const isCheck = ['tool_execution', 'correlation'].includes(e.source?.kind);
    const eligible = activeAttempt?.phase === 'mandatory_final' && activeAttempt.status === 'completed' &&
      e.attemptId === activeAttempt.id;
    return { id: e.id, freshness: isCheck && !eligible && measured === 'fresh' ? 'unknown' : measured };
  }));
  const reusable = values.filter((x) => x.freshness === 'fresh' || x.freshness === 'not_applicable').map((x) => x.id);
  const stale = values.filter((x) => x.freshness === 'stale').map((x) => x.id);
  const unknown = values.filter((x) => x.freshness === 'unknown').map((x) => x.id);
  const revalidationTargets = values.filter((x) => x.freshness === 'stale' || x.freshness === 'unknown')
    .slice(0, 50).map((x) => {
      const evidence = q.evidence.find((e) => e.id === x.id);
      return {
        evidenceId: x.id, subject: evidence.subject, freshness: x.freshness,
        action: evidence.source.kind === 'static_review' ? 'reinspect_source' :
          evidence.source.kind === 'tool_execution' || evidence.source.kind === 'correlation' ? 'rerun_configured_verification' : 'reassess_claim',
        paths: evidence.dependencies?.entries?.map((e) => e.path) ?? [],
        checkId: ['tool_execution', 'correlation'].includes(evidence.source.kind) ? evidence.source.checkId ?? null : null,
      };
    });
  const stages = checkpoint?.completedStages ?? [];
  const plannedStages = plan?.plan ? buildImplementationStages(plan.plan) : [];
  const nextStage = checkpoint?.interruptedStage ?? plannedStages[stages.length]?.id ?? null;
  const checkoutDrift = checkpoint?.repoKey && checkoutState
    ? repositoryFingerprint(checkoutState) !== checkpoint.repoKey : null;
  const reconciliationChanges = checkoutDrift && checkoutState
    ? implementationReconciliationChanges(checkpoint.repoSnapshot, checkoutState) : null;
  const blockers = [];
  if (!plan) blockers.push('legacy_orphan_checkpoint');
  if (checkpoint && plan && checkpoint.planId !== plan.planId) blockers.push('checkpoint_plan_mismatch');
  const changedPaths = [...new Set(q.evidence.filter((e) => stale.includes(e.id)).flatMap((e) => e.dependencies?.entries?.map((x) => x.path) ?? []))];
  return {
    taskId: task.taskId, planId: plan?.planId ?? checkpoint?.planId ?? null,
    recoverable: blockers.length === 0 && checkoutDrift === false || (blockers.length === 0 && !checkpoint),
    checkpointStatus: checkpoint?.status ?? 'not_started', completedStages: stages,
    nextStage,
    reusableEvidenceIds: reusable, staleEvidenceIds: stale, unknownEvidenceIds: unknown,
    revalidationTargets, // advisory; mandatory verification suite must still run
    changedPaths: [...new Set([...changedPaths, ...(reconciliationChanges?.changedPaths ?? [])])],
    checkoutDrift, reconciliationChanges, unresolvedFindings: q.findings.filter((f) => f.lifecycle !== 'resolved').map((f) => f.id),
    findingSummaries: q.findings.filter((f) => f.lifecycle !== 'resolved').slice(0, 30).map((f) => ({
      id: f.id, severity: f.severity, lifecycle: f.lifecycle, message: f.title, paths: f.affectedPaths,
      authorization: f.remediationAuthorization,
    })),
    requiredActions: [...(checkoutDrift === true ? ['checkout_reconciliation_required'] : checkoutDrift === null && checkpoint ? ['verify_checkout_compatibility'] : []),
      ...(stale.length || unknown.length ? ['targeted_revalidation_or_explicit_impact_analysis'] : []),
      ...(checkpoint?.status === 'review_interrupted' ? ['retry_readonly_review'] : []), ...blockers],
    // A pending risk *acknowledgement* is optional: it cannot block recovery.
    // Mandatory reconciliation/scope gates are distinct from optional notices.
    requiresApproval: q.decisions.some((d) => d.status === 'pending' &&
      ['checkout_reconciliation', 'remediation_scope'].includes(d.kind)) || checkoutDrift === true, blockers,
    // Assessment is deliberately read-only. Continuation is owned by workflow.
  };
}

const qualityForRead = (task) => task.quality ?? { version: 1, revision: 0, evidence: [], findings: [], decisions: [], attempts: [] };
export function activeQuality(session) {
  const task = activeImplementationTask(session);
  return task ? { task, state: qualityForRead(task) } : null;
}

// Called in the same atomic task update as the checkpoint. Stage evidence is
// model-reported only; a stepResults.checks entry is NOT observed tool execution.
export async function ingestStageCheckpoint(task, checkpoint, repoRoot) {
  if (!task?.plan || !Array.isArray(checkpoint?.records)) return;
  const q = ensureQuality(task);
  const reports = Array.isArray(checkpoint.reports) ? checkpoint.reports : [];
  const dependencies = await captureDependencies(repoRoot, reports.flatMap((r) => r.changedPaths ?? []).slice(0, MAX_PATHS));
  for (const row of checkpoint.records) {
    if (!row?.id) continue;
    recordEvidence(task, {
      subject: { kind: 'stage', id: row.id }, claim: row.evidence ?? '',
      source: { kind: 'role_report', role: 'coder' },
      assessment: row.status === 'implemented' ? 'supported' : 'unverified',
      dependencies, runId: checkpoint.planId,
    });
  }
  if (checkpoint.interruption) {
    q.lastInterruption = {
      stage: clip(checkpoint.interruption.stage, 60), reason: clip(checkpoint.interruption.reason, 100),
      at: now(),
    };
    q.revision++;
  }
}

export async function currentDecisionBinding(task, repoRoot) {
  return {
    planId: task.plan?.planId ?? null,
    checkpointKey: task.checkpoint?.repoKey ?? null,
    checkpointStatus: task.checkpoint?.status ?? null,
    completedStagesHash: digest(JSON.stringify(task.checkpoint?.completedStages ?? [])),
    repositoryFingerprint: repositoryFingerprint(await captureRepoState(repoRoot)),
  };
}

export async function proposeWorkflowDecision(task, result, repoRoot) {
  const disposition = result?.fixDisposition;
  if (!['approval_required', 'report_only'].includes(disposition?.action)) return null;
  const findings = (disposition.findings ?? []).filter((x) => x?.message);
  if (!findings.length) return null;
  const keys = [...new Set(findings.map((issue) => findingKeyForIssue(qualityForRead(task), issue)))];
  const paths = [...new Set(findings.map((x) => x.path).filter(validPath))];
  const binding = await currentDecisionBinding(task, repoRoot);
  if (disposition.action === 'approval_required') {
    const gate = proposeDecision(task, {
      kind: 'remediation_scope',
      summary: `Extend remediation scope for ${findings.length} reported finding(s)?`,
      rationale: `Affected paths: ${paths.join(', ') || '(not established)'}. ` +
        `Findings remain visible regardless of this decision. Existing tool permissions remain mandatory.`,
      options: [
        { id: 'approve_scope', description: 'Authorize remediation only for the listed findings in the current checkout.' },
        { id: 'decline', description: 'Do not expand permitted remediation; preserve and report findings.' },
      ], stateBinding: binding, subjectKeys: keys,
    });
    gate.findingKeys = keys;
    gate.affectedPaths = paths;
    return gate;
  }
  // Risk acceptance is ONLY an acknowledgement of independently corroborated,
  // non-blocking out-of-scope findings with a passing observed verification.
  // It NEVER upgrades a failed test, unverified acceptance or workflow verdict.
  const quality = ensureQuality(task);
  const credible = keys.filter((key) => quality.findings.some((f) =>
    f.identity === key && f.lifecycle === 'confirmed' && f.confidence !== 'hypothesis' &&
    f.taskImpact !== 'blocking' && f.remediationAuthorization !== 'authorized_by_existing_scope'));
  if (!credible.length || result.verificationDisposition !== 'PASS' ||
      result.qualityAssessment?.complete === false) return null;
  const gate = proposeDecision(task, {
    kind: 'risk_acceptance', summary: `Acknowledge ${credible.length} confirmed out-of-scope finding(s)?`,
    rationale: 'Acceptance records informed consent to leave these findings unresolved. ' +
      'It never marks the task verified, permits source changes, or bypasses tests/tool security.',
    options: [
      { id: 'acknowledge_risk', description: 'Record that I accept the documented residual findings without claiming they are fixed.' },
      { id: 'decline', description: 'Do not accept residual risk; retain the incomplete/with-findings outcome.' },
    ], stateBinding: binding, subjectKeys: credible,
  });
  gate.findingKeys = credible;
  return gate;
}

export async function applicableRiskAcceptance(task, repoRoot) {
  const binding = await currentDecisionBinding(task, repoRoot);
  const q = qualityForRead(task);
  return [...new Set(q.decisions.filter((gate) => gate.kind === 'risk_acceptance' &&
    gate.status === 'resolved' && gate.selection === 'acknowledge_risk' &&
    JSON.stringify(gate.stateBinding) === JSON.stringify(binding) &&
    decisionSubjectsCurrent(q, gate))
    .flatMap((gate) => gate.findingKeys ?? []))];
}

// Reconciliation approval belongs to the existing Plan/reconciliation owner;
// this Decision Gate only records explicit user intent for that exact proposal.
export async function proposeReconciliationDecision(task, proposal, repoRoot) {
  if (!proposal || task.reconciliation !== proposal || !task.plan ||
      proposal.planId !== task.plan.planId || !proposal.repoKey) return null;
  const binding = await currentDecisionBinding(task, repoRoot);
  if (binding.repositoryFingerprint !== proposal.repoKey) return null;
  const gate = proposeDecision(task, {
    kind: 'checkout_reconciliation',
    summary: `Accept the assessed checkout changes for proposal ${proposal.token}?`,
    rationale: `${proposal.analysis?.summary ?? 'Inspected checkout delta'} ` +
      'This accepts the checked baseline only; verification and tool permissions remain mandatory.',
    options: [
      { id: 'accept_checkout', description: 'Accept this particular reconciliation proposal and allow explicit Plan continuation.' },
      { id: 'decline', description: 'Do not accept this checkout for the saved Plan.' },
    ], stateBinding: binding, subjectKeys: [proposal.token],
  });
  gate.proposalToken = proposal.token;
  gate.proposalRepoKey = proposal.repoKey;
  return gate;
}

export async function reconciliationDecision(task, repoRoot) {
  const proposal = task?.reconciliation;
  if (!proposal) return null;
  const binding = await currentDecisionBinding(task, repoRoot);
  const gate = qualityForRead(task).decisions.find((d) =>
    d.kind === 'checkout_reconciliation' && d.proposalToken === proposal.token &&
    d.proposalRepoKey === proposal.repoKey && d.status === 'resolved' &&
    JSON.stringify(d.stateBinding) === JSON.stringify(binding));
  return gate?.selection ?? null;
}

export function expireReconciliationDecisions(task) {
  const q = ensureQuality(task);
  for (const gate of q.decisions) if (gate.kind === 'checkout_reconciliation' && gate.status === 'pending') {
    gate.status = 'invalidated'; gate.invalidatedAt = now(); q.revision++;
  }
}

// The workflow compares incoming issue signatures, while saved v2 approvals
// refer to the original finding identity. Reconstruct only the exact saved
// assertion+witness signature, never the old broad contract/scenario key.
function approvedIssueSignatures(q, key) {
  const legacy = q.findings.find((f) => f.identity === key && f.identityVersion !== 3);
  if (!legacy) return [key];
  return [key, findingIdentity({
    contractId: legacy.contractId, reproductionKey: legacy.reproductionKey,
    path: legacy.affectedPaths?.[0], message: legacy.title, evidence: legacy.description,
  })];
}

export async function applicableApproval(task, repoRoot) {
  const state = qualityForRead(task);
  const resolved = state.decisions.filter((d) => d.kind === 'remediation_scope' &&
    d.status === 'resolved' && d.selection === 'approve_scope');
  if (!resolved.length) return [];
  const binding = await currentDecisionBinding(task, repoRoot);
  return [...new Set(resolved.filter((gate) => JSON.stringify(gate.stateBinding) === JSON.stringify(binding) &&
    decisionSubjectsCurrent(state, gate))
    .flatMap((gate) => (gate.findingKeys ?? []).flatMap((key) => approvedIssueSignatures(state, key))))];
}

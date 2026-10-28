// Operator-owned, deterministic interpretation of checks that emit diagnostic
// reports. Never accept policy definitions from a role, repository or Plan.
import { createHash } from 'node:crypto';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { open, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, relative, sep, isAbsolute } from 'node:path';

const execGit = promisify(execFileCb);
const hash = (value) => createHash('sha256').update(value).digest('hex');
const safePath = (name) => typeof name === 'string' && name.length > 0 && name.length < 500 &&
  !isAbsolute(name) && !name.includes('\0') && !name.split(/[\\/]/).some((p) => p === '..' || p === '.git');
const safeField = (name) => typeof name === 'string' && /^(?:[a-zA-Z_$][\w$]*)(?:\.[a-zA-Z_$][\w$]*){0,7}$/.test(name);
const unique = (xs) => xs.length === new Set(xs).size;

export function configuredVerificationPolicies(raw = process.env.AGENT_VERIFY_POLICIES) {
  if (!raw) return Object.create(null);
  let data;
  try { data = JSON.parse(raw); } catch { throw new Error('Invalid AGENT_VERIFY_POLICIES JSON'); }
  if (!data || Array.isArray(data) || typeof data !== 'object' || Object.keys(data).length > 24) {
    throw new Error('AGENT_VERIFY_POLICIES requires a bounded command map');
  }
  const policies = Object.create(null);
  for (const [command, policy] of Object.entries(data)) {
    if (!command.trim() || command.length > 400 || !policy || policy.kind !== 'diagnostic_json_delta' ||
        (policy.baseline !== undefined && !['pre_run', 'git_head'].includes(policy.baseline)) ||
        !Array.isArray(policy.reports) || !policy.reports.length || policy.reports.length > 48 ||
        !Array.isArray(policy.acceptedExitCodes) || !policy.acceptedExitCodes.length ||
        policy.acceptedExitCodes.length > 8 || !policy.acceptedExitCodes.includes(0) ||
        policy.acceptedExitCodes.some((v) => !Number.isInteger(v) || v < 0 || v > 255) ||
        policy.reports.some((r) => !r || !safePath(r.path) ||
          (r.itemsPath !== undefined && !safeField(r.itemsPath)) ||
          !Array.isArray(r.identityFields) || !r.identityFields.length || r.identityFields.length > 12 ||
          r.identityFields.some((f) => !safeField(f))) ||
        !unique(policy.reports.map((r) => r.path)) ||
        (policy.completion !== undefined && (!policy.completion || !safePath(policy.completion.path) ||
          policy.reports.some((r) => r.path === policy.completion.path)))) {
      throw new Error(`Invalid trusted diagnostic verification policy for ${command}`);
    }
    policies[command] = { kind: 'diagnostic_json_delta', baseline: policy.baseline ?? 'pre_run',
      acceptedExitCodes: [...new Set(policy.acceptedExitCodes)],
      reports: policy.reports.map((r) => ({ path: r.path, itemsPath: r.itemsPath ?? '', identityFields: [...r.identityFields] })),
      ...(policy.completion ? { completion: { path: policy.completion.path } } : {}),
    };
  }
  return policies;
}

const get = (object, field) => field ? field.split('.').reduce((v, part) => v?.[part], object) : object;
function parseReportBytes(bytes, report) {
  const parsed = JSON.parse(bytes.toString('utf8'));
  const items = get(parsed, report.itemsPath);
  if (!Array.isArray(items) || items.length > 20_000) throw new Error('Invalid diagnostic JSON array');
  const ids = items.map((item) => {
    const values = report.identityFields.map((field) => get(item, field));
    if (values.some((v) => typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean')) {
      throw new Error('Incomplete diagnostic identity');
    }
    return hash(JSON.stringify(values));
  });
  return { hash: hash(bytes), ids: ids.sort() };
}

async function reportSnapshot(root, report) {
  const base = resolve(root);
  const file = resolve(base, report.path);
  if (!file.startsWith(`${base}${sep}`) || relative(base, file).startsWith('..')) return null;
  const parts = relative(base, file).split(sep);
  try {
    for (let i = 1; i < parts.length; i++) {
      const st = await lstat(resolve(base, ...parts.slice(0, i)));
      if (!st.isDirectory() || st.isSymbolicLink()) return null;
    }
    const st = await lstat(file);
    if (!st.isFile() || st.isSymbolicLink() || st.size > 2_000_000) return null;
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    let bytes;
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.dev !== st.dev || opened.ino !== st.ino || opened.size > 2_000_000) return null;
      bytes = await handle.readFile();
    } finally { await handle.close(); }
    return { ...parseReportBytes(bytes, report), mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs };

  } catch { return null; }
}

export async function witnessDiagnosticReports(root, policy) {
  if (!policy) return null;
  const reports = [];
  for (const report of policy.reports) {
    const snapshot = await reportSnapshot(root, report);
    if (!snapshot) return null;
    reports.push({ path: report.path, ...snapshot });
  }
  return reports;
}

// Nonzero domain-success requires an operator-owned completion protocol. The
// analyzer writes this marker *after* all reports are durably generated and
// successfully inspected. A fresh invocation nonce binds it to this execution;
// hashes bind it to the actual observed JSON. Timestamps alone are never proof.
export async function witnessDiagnosticCompletion(root, policy, invocationId, reports) {
  if (!policy?.completion || !invocationId || !Array.isArray(reports)) return false;
  const marker = await safeReadMarker(root, policy.completion.path);
  if (!marker || marker.invocationId !== invocationId || marker.status !== 'completed' ||
      !marker.reportHashes || typeof marker.reportHashes !== 'object' || Array.isArray(marker.reportHashes)) return false;
  const expected = policy.reports.map((r) => r.path);
  if (Object.keys(marker.reportHashes).length !== expected.length) return false;
  return expected.every((path) => typeof marker.reportHashes[path] === 'string' &&
    reports.some((report) => report.path === path && report.hash === marker.reportHashes[path]));
}

async function safeReadMarker(root, name) {
  const base = resolve(root);
  const path = resolve(base, name);
  if (!safePath(name) || !path.startsWith(`${base}${sep}`)) return null;
  const parts = relative(base, path).split(sep);
  try {
    for (let i = 1; i < parts.length; i++) {
      const entry = await lstat(resolve(base, ...parts.slice(0, i)));
      if (!entry.isDirectory() || entry.isSymbolicLink()) return null;
    }
    const entry = await lstat(path);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.size > 8192) return null;
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.dev !== entry.dev || opened.ino !== entry.ino || opened.size > 8192) return null;
      return JSON.parse((await handle.readFile()).toString('utf8'));
    } finally { await handle.close(); }
  } catch { return null; }
}

// Compare against an explicit, stable Git baseline when a diagnostic checker
// itself uses committed reports as its comparison target. This is an opt-in
// *operator* contract, never inferred from the model or the file names.
export async function witnessGitBaselineReports(root, policy) {
  if (!policy || policy.baseline !== 'git_head') return null;
  try {
    const { stdout: rev } = await execGit('git', ['rev-parse', '--verify', 'HEAD'],
      { cwd: root, encoding: 'utf8', maxBuffer: 1000 });
    const oid = rev.trim();
    if (!/^[a-f0-9]{40,64}$/.test(oid)) return null;
    const reports = [];
    for (const report of policy.reports) {
      const { stdout } = await execGit('git', ['show', `${oid}:${report.path}`],
        { cwd: root, encoding: 'buffer', maxBuffer: 2_100_000 });
      if (!Buffer.isBuffer(stdout) || stdout.length > 2_000_000) return null;
      reports.push({ path: report.path, ...parseReportBytes(stdout, report), mtimeMs: null, ctimeMs: null });
    }
    return reports;
  } catch { return null; }
}

export function assessDiagnosticDelta(before, after, policy, exitCode, { timedOut = false, signal = null, completionVerified = false } = {}) {
  if (!policy || !before || !after || timedOut || signal || !policy.acceptedExitCodes.includes(exitCode)) {
    return { outcome: 'unknown', accepted: false, changedPaths: [] };
  }
  let added = 0; let removed = 0;
  const changedPaths = [];
  for (let i = 0; i < before.length; i++) {
    const a = before[i], b = after[i];
    if (!b || a.path !== b.path) return { outcome: 'unknown', accepted: false, changedPaths: [] };
    if (a.hash !== b.hash) changedPaths.push(a.path);
    const old = new Map(), next = new Map();
    for (const id of a.ids) old.set(id, (old.get(id) ?? 0) + 1);
    for (const id of b.ids) next.set(id, (next.get(id) ?? 0) + 1);
    for (const [id, count] of next) added += Math.max(0, count - (old.get(id) ?? 0));
    for (const [id, count] of old) removed += Math.max(0, count - (next.get(id) ?? 0));
  }
  const outcome = added > 0 ? 'regressed' : removed > 0 ? 'improved' : 'unchanged';
  // A non-zero exit with unchanged reports may be a crash before reports were
  // updated. Do not turn that into a successful check just because policy lists it.
  const accepted = outcome !== 'regressed' && (exitCode === 0 ||
    (outcome === 'improved' && completionVerified === true));
  return { outcome, accepted, added, removed, changedPaths, completionVerified: completionVerified === true };
}

export function expectedReportEffects(results, changedPaths, gitMetadataStable) {
  if (!gitMetadataStable) return false;
  const expected = new Set();
  for (const result of results) {
    const outcome = result.diagnostic;
    if (outcome?.outcome === 'unknown' || (outcome?.outcome === 'regressed' && result.status !== 'TEST_FAILED')) return false;
    for (const path of outcome?.changedPaths ?? []) expected.add(path);
  }
  return changedPaths.every((path) => expected.has(path));
}

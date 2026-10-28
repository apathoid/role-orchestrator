// Trusted operator-owned manifest for optional verification input closure.
// This is never accepted from a model, repository instruction, or role report.
// Absence means unknown inputs, not that all inputs are covered by Git.
import { isAbsolute } from 'node:path';

const safeEnvironmentKey = (name) => typeof name === 'string' && /^[A-Z_][A-Z0-9_]{0,79}$/i.test(name) &&
  !/(?:TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE|AUTH|CREDENTIAL|COOKIE|API_KEY|ACCESS_KEY)/i.test(name);

// Path spellings are canonical and independent of the host OS. A path like
// a//b, a/./b or C:relative must not create duplicate/ambiguous cache inputs.
const safePath = (name) => typeof name === 'string' && name.length > 0 && name.length <= 500 &&
  !isAbsolute(name) && !/^[A-Za-z]:/.test(name) &&
  !/[\\\\\x00-\x1f\x7f]/.test(name) &&
  name.split('/').every(part => part && part !== '.' && part !== '..' &&
    part.toLowerCase() !== '.git');

export function configuredVerificationInputClosures(raw = process.env.AGENT_VERIFY_INPUT_CLOSURES) {
  if (!raw) return {};
  let value;
  try { value = JSON.parse(raw); } catch { throw new Error('Invalid AGENT_VERIFY_INPUT_CLOSURES JSON'); }
  if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).length > 32) {
    throw new Error('AGENT_VERIFY_INPUT_CLOSURES must be a bounded command map');
  }
  const result = Object.create(null);
  for (const [command, declaration] of Object.entries(value)) {
    if (!command.trim() || command.length > 400 || command === '__proto__' ||
        !declaration || declaration.complete !== true || !Array.isArray(declaration.paths) ||
        !declaration.paths.length || declaration.paths.length > 64 ||
        declaration.paths.some((p) => !safePath(p)) ||
        ((declaration.cacheable !== undefined && typeof declaration.cacheable !== 'boolean') ||
        declaration.environment !== undefined && (!Array.isArray(declaration.environment) ||
          declaration.environment.length > 16 || declaration.environment.some((key) => !safeEnvironmentKey(key))))) {
      throw new Error('Invalid verification input closure; refuse to infer completeness');
    }
    result[command] = { complete: true, cacheable: declaration.cacheable === true, paths: [...new Set(declaration.paths)],
      environment: [...new Set(declaration.environment ?? [])] };
  }
  return result;
}

// Host-owned command witnesses. The caller must never infer a complete input
// manifest from model text or from Git alone.
import { createHash, randomUUID } from 'node:crypto';
import { lstat, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { withWorkspaceEntry } from './workspace-fs-boundary.mjs';
const sha = (s) => createHash('sha256').update(s).digest('hex');
export const verificationCheckId = (command) => sha(String(command));
export const verificationSuiteId = (commands) => sha(JSON.stringify(commands.map(verificationCheckId)));
export const verificationAttemptId = () => randomUUID();
// Read through a pinned, no-symlink directory chain. Checking parent names
// with lstat followed by an ordinary pathname open is vulnerable to renames
// between those operations. Fail closed where safe directory-fd access is absent.
async function fingerprintFile(root, relative) {
  if (!safePath(relative)) return null;
  try {
    return await withWorkspaceEntry(root, relative, {}, async (filename) => {
      const before = await lstat(filename, { bigint: true });
      if (!before.isFile() || before.isSymbolicLink() ||
          before.nlink !== 1n || before.size > 8_000_000n) return null;
      const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const opened = await file.stat({ bigint: true });
        if (!opened.isFile() || opened.nlink !== 1n ||
            opened.dev !== before.dev || opened.ino !== before.ino ||
            opened.size !== before.size || opened.mtimeNs !== before.mtimeNs ||
            opened.ctimeNs !== before.ctimeNs) return null;
        const data = await file.readFile();
        const after = await file.stat({ bigint: true });
        if (data.length > 8_000_000 || after.size !== opened.size ||
            after.mtimeNs !== opened.mtimeNs || after.ctimeNs !== opened.ctimeNs ||
            after.nlink !== 1n) return null;
        return sha(data);
      } finally { await file.close(); }
    });
  } catch (error) {
    return error?.code === 'ENOENT' ? 'missing' : null;
  }
}
export async function witnessVerificationInputs(root, declaration) {
  if (!declaration || declaration.complete !== true || !Array.isArray(declaration.paths) ||
      !declaration.paths.length || declaration.paths.length > 64 ||
      declaration.paths.some((p) => !safePath(p)) ||
      (declaration.environment !== undefined && (!Array.isArray(declaration.environment) ||
        declaration.environment.length > 16 || declaration.environment.some((name) => !safeEnvironmentKey(name))))) return { kind: 'unknown' };
  const entries = [];
  for (const relative of [...new Set(declaration.paths)].sort()) {
    const fingerprint = await fingerprintFile(root, relative);
    if (fingerprint === null) return { kind: 'unknown' };
    entries.push({ path: relative, fingerprint });
  }
  const environment = [...new Set(declaration.environment ?? [])].sort().map((name) => ({ name,
    fingerprint: sha(process.env[name] === undefined ? 'absent' : `present:${process.env[name]}`) }));
  return { kind: 'paths', completeness: 'complete', entries, ...(environment.length ? { environment } : {}) };
}

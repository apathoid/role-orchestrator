import { posix } from 'node:path';

const SECURITY_LIST_KEYS = ['denyPaths', 'denyGlobs', 'allowPaths', 'allowGlobs'];
// This non-serialized metadata can only be attached by the config loader.
// Workspace JSON cannot forge or remove the trusted inherited policy.
const TRUSTED_BASE_POLICY = Symbol('trusted-base-security-policy');

function normalizeRepoPath(value, label = 'path') {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  if (value.includes('\0')) throw new Error(`${label} must not contain NUL bytes.`);

  let normalized = value.replaceAll('\\', '/');
  while (normalized.startsWith('./')) normalized = normalized.slice(2);
  if (normalized.startsWith('/')) throw new Error(`${label} must be repository-relative: ${value}`);
  if (normalized.split('/').includes('..')) {
    throw new Error(`${label} must not contain parent-directory segments: ${value}`);
  }
  normalized = posix.normalize(normalized);
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`${label} must stay inside the repository: ${value}`);
  }
  return normalized;
}

function normalizeGlob(value, label = 'glob') {
  return normalizeRepoPath(value, label);
}

export function validateSecurityConfig(raw = {}) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('security must be an object.');
  }

  if (raw.caseSensitive !== undefined && typeof raw.caseSensitive !== 'boolean') {
    throw new Error('security.caseSensitive must be a boolean.');
  }

  const out = {
    caseSensitive: raw.caseSensitive ?? false,
  };

  for (const key of SECURITY_LIST_KEYS) {
    const value = raw[key] ?? [];
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) {
      throw new Error(`security.${key} must be an array of non-empty strings.`);
    }
    const normalize = key.endsWith('Globs') ? normalizeGlob : normalizeRepoPath;
    out[key] = [...new Set(value.map((item, i) => normalize(item, `security.${key}[${i}]`)))];
  }

  if (raw[TRUSTED_BASE_POLICY]) Object.defineProperty(out, TRUSTED_BASE_POLICY, { value: raw[TRUSTED_BASE_POLICY] });
  return out;
}

export function mergeSecurityConfig(base = {}, override = {}, { lockBaseDenials = false, trustedOverride = false } = {}) {
  if (base === null || typeof base !== 'object' || Array.isArray(base)) throw new Error('base security config must be an object.');
  if (override === null || typeof override !== 'object' || Array.isArray(override)) throw new Error('security override must be an object.');
  if (override.caseSensitive !== undefined && typeof override.caseSensitive !== 'boolean') {
    throw new Error('security.caseSensitive must be a boolean.');
  }

  const merged = {
    caseSensitive: override.caseSensitive ?? base.caseSensitive ?? false,
  };
  for (const key of SECURITY_LIST_KEYS) {
    const baseList = base[key] ?? [];
    const overrideList = override[key] ?? [];
    if (!Array.isArray(baseList) || !Array.isArray(overrideList)) {
      throw new Error(`security.${key} must be an array of non-empty strings.`);
    }
    merged[key] = [...new Set([...baseList, ...overrideList])];
  }
  const validated = validateSecurityConfig(merged);
  const inherited = trustedOverride ? null :
    (base[TRUSTED_BASE_POLICY] ?? (lockBaseDenials ? validateSecurityConfig(base) : null));
  if (inherited) Object.defineProperty(validated, TRUSTED_BASE_POLICY, { value: inherited });
  return validated;
}

function comparable(value, policy) {
  return policy.caseSensitive ? value : value.toLowerCase();
}

function exactMatch(path, entries, policy) {
  const candidate = comparable(path, policy);
  return entries.find((entry) => comparable(entry, policy) === candidate) ?? null;
}

function globMatch(path, globs, policy) {
  const candidate = comparable(path, policy);
  return globs.find((glob) => posix.matchesGlob(candidate, comparable(glob, policy))) ?? null;
}

/**
 * Evaluate a repository-relative path against the configured security policy.
 *
 * Precedence is intentionally asymmetric:
 * 1. exact denyPaths always deny and cannot be weakened by an allow glob;
 * 2. explicit/broad allow rules can exempt a path from denyGlobs;
 * 3. denyGlobs deny everything else that matches.
 */
export function evaluateSecurityPath(relPath, policy) {
  const path = normalizeRepoPath(relPath, 'repository path');

  const exactDeny = exactMatch(path, policy.denyPaths, policy);
  if (exactDeny) {
    return { denied: true, path, reason: `security.denyPaths: ${exactDeny}` };
  }

  // A project-level allow cannot weaken a denial from the trusted base.
  // Existing exceptions at that same trusted level are evaluated first.
  const inherited = policy[TRUSTED_BASE_POLICY];
  if (inherited) {
    const decision = evaluateSecurityPath(path, inherited);
    if (decision.denied) return { ...decision, reason: `inherited ${decision.reason}` };
  }

  const exactAllow = exactMatch(path, policy.allowPaths, policy);
  if (exactAllow) {
    return { denied: false, path, reason: `security.allowPaths: ${exactAllow}` };
  }

  const globAllow = globMatch(path, policy.allowGlobs, policy);
  if (globAllow) {
    return { denied: false, path, reason: `security.allowGlobs: ${globAllow}` };
  }

  const globDeny = globMatch(path, policy.denyGlobs, policy);
  if (globDeny) {
    return { denied: true, path, reason: `security.denyGlobs: ${globDeny}` };
  }

  return { denied: false, path, reason: null };
}

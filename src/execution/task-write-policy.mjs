// Deterministic POST-WRITE task-scope audit. The ACP provider owns its tools:
// this guard can refuse acceptance/continuation but CANNOT prevent writes that
// already occurred. Provider-side write interception is a separate requirement.
import { classifyTestCandidate } from '../testing/discovery.mjs';
import { validateTaskSpec } from '../routing/task-spec.mjs';
const SCOPES = new Set(['unspecified','tests_only','production_only','combined']);
export const WRITE_SCOPES = Object.freeze([...SCOPES]);

export function assessTaskWriteScope(changedPaths, taskSpec) {
  const scope = taskSpec?.constraints?.writeScope ?? 'unspecified';
  if (!SCOPES.has(scope)) throw new Error('invalid_task_write_scope');
  const excludes = taskSpec?.constraints?.excludedPaths ?? [];
  if (!Array.isArray(changedPaths) || !Array.isArray(excludes)) throw new Error('invalid_task_write_paths');
  const violations=[];
  for (const path of changedPaths) {
    if (typeof path !== 'string' || !path || path.startsWith('/') || path.includes('\\') || path.includes('\0') ||
        path.split('/').some(part => !part || part === '.' || part === '..' || part === '.git') || /^[A-Za-z]:/.test(path)) {
      violations.push({path:'[invalid]',reason:'unsafe_path'}); continue;
    }
    if (excludes.some(prefix => path === prefix || path.startsWith(`${prefix}/`))) {
      violations.push({path,reason:'explicit_exclusion'}); continue;
    }
    if (scope==='tests_only' || scope==='production_only') {
      const kind=classifyTestCandidate(path).kind;
      if (kind !== (scope==='tests_only'?'test':'production_candidate'))
        violations.push({path,reason:kind==='unknown'?'unknown_path_classification':'outside_declared_write_scope'});
    }
  }
  return {scope,checked:changedPaths.length,violations,accepted:violations.length===0,
    enforcement:'POST_WRITE_DETECTION_ONLY'};
}

export function assertTaskWriteScope(paths, taskSpec) {
  const result=assessTaskWriteScope(paths,taskSpec);
  if (!result.accepted) {
    const error=new Error(`Task write scope violated: ${result.violations.map(v=>`${v.path} (${v.reason})`).join(', ')}. Changes were preserved for manual inspection; no automatic reset was attempted.`);
    error.code='TASK_WRITE_SCOPE_VIOLATION';
    error.violations=result.violations;
    throw error;
  }
  return result;
}

// A continuation cannot silently broaden the saved Plan's restriction. Verify
// against BOTH the current intent and the persisted scope, not a first-nonnull
// fallback that would discard the older, narrower boundary.
export function assertTaskWriteScopes(paths, scopes = []) {
  const outcomes=[];
  for (const scope of scopes) if (scope) outcomes.push(assertTaskWriteScope(paths,scope));
  return outcomes;
}

// ACP tool notifications and permission prompts are observations, not a
// mandatory interception point. An agent may write without requesting host
// permission. Until a filesystem-enforced path boundary is supplied by the
// host, refuse restricted write turns BEFORE invoking provider-owned tools.
// Do not accept a model-supplied capability or claim that instructions alone
// make a provider enforce a path allowlist.
export function assessPreWriteBoundary(taskSpecs = [], { sandboxMode = 'workspace-write' } = {}) {
  if (sandboxMode !== 'read-only' && sandboxMode !== 'workspace-write') return {
    accepted: false, enforcement: 'NOT_ENFORCEABLE', reason: 'unsupported_sandbox_mode',
  };
  if (sandboxMode === 'read-only') return {
    accepted: true, enforcement: 'READ_ONLY_MODE_REQUESTED_NOT_VERIFIED', reason: null,
  };
  if (!Array.isArray(taskSpecs) || taskSpecs.length === 0) return {
    accepted: false, enforcement: 'NOT_ENFORCEABLE', reason: 'missing_task_authorization',
  };
  // Revalidate all model-interpreted and persisted Task Specs at the last
  // pre-invocation boundary. A caller must not bypass structural constraints
  // with a partial object, an ambiguous intent or a malformed saved Plan.
  // This validates DATA; it does not turn a Router response into a trusted
  // user grant or provide filesystem enforcement.
  const active = [];
  for (const [index, spec] of taskSpecs.entries()) {
    if (index > 0 && spec == null) continue; // optional saved Plan
    try { active.push(validateTaskSpec(spec)); }
    catch {
      return { accepted: false, enforcement: 'NOT_ENFORCEABLE', reason: 'invalid_task_authorization' };
    }
  }
  // Only the current turn can authorize a write; a saved Plan restricts scope.
  const current = active[0];
  if (current.operation !== 'change' || current.writeIntent !== 'explicit') return {
    accepted: false, enforcement: 'NOT_ENFORCEABLE', reason: 'write_not_authorized',
  };
  if (current.ambiguities.length) return {
    accepted: false, enforcement: 'NOT_ENFORCEABLE', reason: 'ambiguous_write_authorization',
  };
  for (const spec of active) {
    const scope = spec.constraints?.writeScope ?? 'unspecified';
    if (!SCOPES.has(scope)) return {
      accepted: false, enforcement: 'NOT_ENFORCEABLE', reason: 'unknown_write_scope',
    };
    if (scope === 'tests_only' || scope === 'production_only') return {
      accepted: false, enforcement: 'NOT_ENFORCEABLE', reason: 'restricted_scope_requires_enforced_sandbox',
    };
    if (!Array.isArray(spec.constraints?.excludedPaths)) return {
      accepted: false, enforcement: 'NOT_ENFORCEABLE', reason: 'invalid_path_exclusions',
    };
    if (spec.constraints.excludedPaths.length) return {
      accepted: false, enforcement: 'NOT_ENFORCEABLE', reason: 'excluded_paths_require_enforced_sandbox',
    };
  }
  // Unrestricted legacy changes retain compatibility, but this is expressly
  // NOT a security certification for ACP provider-owned operations.
  return { accepted: true, enforcement: 'NO_PER_PATH_ENFORCEMENT', reason: null };
}

export function assertPreWriteBoundary(taskSpecs, options = {}) {
  const assessment = assessPreWriteBoundary(taskSpecs, options);
  if (!assessment.accepted) {
    const error = new Error(`Write-capable provider invocation refused before execution (${assessment.reason}). No per-path ACP write interception is available; use an enforced host sandbox.`);
    error.code = 'WRITE_AUTHORIZATION_BOUNDARY_UNAVAILABLE';
    error.reasonCode = assessment.reason;
    error.enforcement = assessment.enforcement;
    throw error;
  }
  return assessment;
}

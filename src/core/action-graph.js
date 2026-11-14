import { sameRecord } from './operation.js';

/** @import {Action, ReasonCode} from './contracts.js' */

/**
 * @typedef {{kind: 'accepted', action: Action} | {kind: 'duplicate', actionId: string} |
 *   {kind: 'rejected', actionId: string, code: ReasonCode, dependencyId?: string,
 *    reason: 'identity' | 'unknown_dependency' | 'unavailable_dependency' | 'cyclic_dependency'}} Admission
 */

/**
 * Admit independent actions even if another component of the proposal is
 * malformed. Existing entries are immutable and may satisfy new references.
 * @param {readonly Action[]} existing
 * @param {readonly Action[]} additions
 * @returns {Admission[]}
 */
export function admitActions(existing, additions) {
  const known = new Map(existing.map(action => [action.actionId, action]));
  /** @type {Map<string, Action>} */
  const proposed = new Map();
  /** @type {Map<string, Admission>} */
  const results = new Map();

  for (const action of additions) {
    const actionId = action.actionId;
    const earlier = known.get(actionId) ?? proposed.get(actionId);
    if (!earlier) proposed.set(actionId, action);
    else if (!sameRecord(earlier, action)) {
      results.set(actionId, { kind: 'rejected', actionId, code: 'IDENTITY_CONFLICT', reason: 'identity' });
    } else if (known.has(actionId) && !results.has(actionId)) {
      results.set(actionId, { kind: 'duplicate', actionId });
    }
  }

  /** @type {Map<string, number>} */
  const remaining = new Map();
  /** @type {Map<string, Set<string>>} */
  const dependents = new Map();
  const ready = [];
  const invalid = [];
  for (const [actionId, action] of proposed) {
    if (results.has(actionId)) {
      invalid.push(actionId);
      continue;
    }
    const pending = new Set(action.dependsOn.map(edge => edge.actionId).filter(id => !known.has(id)));
    const missing = [...pending].find(id => !proposed.has(id));
    if (missing !== undefined) {
      results.set(actionId, {
        kind: 'rejected', actionId, code: 'INVALID_PROPOSAL', dependencyId: missing, reason: 'unknown_dependency',
      });
      invalid.push(actionId);
      continue;
    }
    for (const id of pending) {
      const list = dependents.get(id) ?? new Set();
      list.add(actionId);
      dependents.set(id, list);
    }
    remaining.set(actionId, pending.size);
    if (pending.size === 0) ready.push(actionId);
  }

  for (const dependencyId of invalid) {
    for (const actionId of dependents.get(dependencyId) ?? []) {
      if (results.has(actionId)) continue;
      results.set(actionId, {
        kind: 'rejected', actionId, code: 'INVALID_PROPOSAL', dependencyId, reason: 'unavailable_dependency',
      });
      invalid.push(actionId);
    }
  }

  for (const actionId of ready) {
    const action = proposed.get(actionId);
    if (!action || results.has(actionId)) continue;
    results.set(actionId, { kind: 'accepted', action });
    for (const dependent of dependents.get(actionId) ?? []) {
      const size = (remaining.get(dependent) ?? 0) - 1;
      remaining.set(dependent, size);
      if (size === 0) ready.push(dependent);
    }
  }

  return [...new Set(additions.map(action => action.actionId))].map(actionId => results.get(actionId) ?? {
    kind: 'rejected', actionId, code: 'INVALID_PROPOSAL', reason: 'cyclic_dependency',
  });
}

/**
 * Return the exact model-authored edges still outstanding. A terminal failure
 * satisfies after_terminal and only an explicit model assessment satisfies
 * after_model_acceptance.
 * @param {Action} action
 * @param {ReadonlySet<string>} terminal
 * @param {ReadonlySet<string>} modelAccepted
 */
export function pendingDependencies(action, terminal, modelAccepted) {
  return action.dependsOn.filter(edge => !terminal.has(edge.actionId) ||
    (edge.kind === 'after_model_acceptance' && !modelAccepted.has(edge.actionId)));
}

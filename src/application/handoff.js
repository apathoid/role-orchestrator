import { workspaceContextFor } from '../core/operation.js';
import { compactContext, unavailableContext } from './context-bundle.js';
import { coordinationFacts, operationHistory } from './controller-context.js';
/** @import {LookupStatus} from './recovery.js' */
/** @import {ContextItem} from '../core/observation.js' */
/** @import {Action} from '../core/contracts.js' */
/** @import {Operation, Reason} from '../core/operation.js' */
/** @import {CatalogEntry, Invocation} from '../core/ports.js' */

/** @typedef {Omit<Invocation, 'attemptId' | 'signal' | 'timeoutMs' | 'idempotencyKey' | 'context'>} Handoff */

/**
 * The catalog and authority reference are supplied by the Host. Role and skill
 * instructions travel separately and cannot change the selected profile or grant.
 * @param {Operation} operation
 * @param {Action} action
 * @param {readonly CatalogEntry[]} catalog
 * @returns {{kind: 'accepted', handoff: Handoff} | {kind: 'rejected', reason: Reason, resource: string}}
 */
export function prepareHandoff(operation, action, catalog) {
  /** @param {string} resource @returns {{kind: 'rejected', reason: Reason, resource: string}} */
  const missing = resource => ({
    kind: 'rejected', resource, reason: {
      code: 'CAPABILITY_UNAVAILABLE', operationId: operation.operationId, actionId: action.actionId,
      dispatchCertainty: 'not_sent', effect: 'none',
    },
  });

  const profile = catalog.find(item => item.kind === 'profile' && item.value.profileId === action.profileId);
  if (profile?.kind !== 'profile') return missing(action.profileId);
  const instructions = [];
  if (action.roleId) {
    const role = catalog.find(item => item.kind === 'role' && item.value.id === action.roleId);
    if (role?.kind !== 'role') return missing(action.roleId);
    instructions.push(role.value.instructions);
  }
  for (const id of action.skills ?? []) {
    const skill = catalog.find(item => item.kind === 'skill' && item.value.id === id);
    if (skill?.kind !== 'skill') return missing(id);
    if (skill.value.instructions !== undefined) instructions.push(skill.value.instructions);
  }

  return {
    kind: 'accepted', handoff: {
      kind: 'delegate', operationId: operation.operationId, actionId: action.actionId,
      objective: action.objective, instructions, profile: profile.value, workspaceContext: workspaceContextFor(operation),
      userConstraints: operation.request.userConstraints, authorityRef: operation.authorityRef,
      attachments: operation.request.attachments.filter(attachment => action.contextRefs.includes(attachment.ref)),
      requiredCapabilities: action.requiredCapabilities,
      expectedResult: action.expectedResult, continuationReference: action.continuationReference,
    },
  };
}


/**
 * @param {Operation} operation @param {readonly string[]} refs @param {number} maxBytes
 * @param {ReadonlyMap<string, LookupStatus>} [lookups] @returns {ContextItem[]}
 */
export function handoffContext(operation, refs, maxBytes, lookups) {
  const selected = new Set(refs);
  const facts = coordinationFacts(operation, lookups);
  const includeFacts = facts.unresolvedAttempts.length || facts.cancellations.length;
  const factsRef = 'host:operation-state';
  if (includeFacts) selected.delete(factsRef);
  /** @type {Map<string, ContextItem>} */
  const found = new Map();
  for (const item of operationHistory(operation)) {
    if (selected.has(item.ref) && !found.has(item.ref)) found.set(item.ref, item);
  }
  const attachments = new Set(operation.request.attachments.map(item => item.ref));
  const records = [...selected].filter(ref => found.has(ref) || !attachments.has(ref))
    .map(ref => found.get(ref) ?? unavailableContext(ref, 'missing'));
  const { context, omitted } = compactContext(records, maxBytes, true);
  // Byte-budget omissions already have per-reference markers. A summary is
  // needed only when the record-count limit suppresses entire references.
  if (records.length > 128 && omitted > 0) {
    context.push({ ref: 'host:context-budget', source: 'host_observed',
      completeness: 'complete', value: { omitted, selected: records.length, limit: 128 } });
  }
  if (includeFacts) {
    context.push({ ref: factsRef, source: 'host_observed', completeness: 'complete', value: facts });
  }
  return context;
}

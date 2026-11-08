/** @import {ContextItem} from '../core/observation.js' */
/** @import {Action} from '../core/contracts.js' */
/** @import {Operation, Reason} from '../core/operation.js' */
/** @import {CatalogEntry, Invocation} from '../core/ports.js' */

/** @typedef {Omit<Invocation, 'attemptId' | 'signal' | 'timeoutMs' | 'idempotencyKey'>} Handoff */

/**
 * The catalog and authority reference are supplied by the Host. Role and skill
 * instructions travel separately and cannot change the selected profile or grant.
 * @param {Operation} operation
 * @param {Action} action
 * @param {readonly CatalogEntry[]} catalog
 * @param {readonly ContextItem[]} availableContext
 * @returns {{kind: 'accepted', handoff: Handoff} | {kind: 'rejected', reason: Reason, resource: string}}
 */
export function materializeHandoff(operation, action, catalog, availableContext) {
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
    instructions.push(skill.value.instructions);
  }

  /** @type {ContextItem[]} */
  const context = [...new Set(action.contextRefs)].map(ref =>
    availableContext.find(item => item.ref === ref) ?? { ref, completeness: 'unavailable', source: 'host_observed' });
  return {
    kind: 'accepted', handoff: {
      kind: 'delegate', operationId: operation.operationId, actionId: action.actionId,
      objective: action.objective, instructions, profile: profile.value, workspaceContext: operation.request.workspaceContext,
      userConstraints: operation.request.userConstraints, context, authorityRef: operation.authorityRef,
      attachments: operation.request.attachments.filter(attachment => action.contextRefs.includes(attachment.ref)),
      requiredCapabilities: action.requiredCapabilities,
      expectedResult: action.expectedResult, continuationReference: action.continuationReference,
    },
  };
}

import {createHash} from 'node:crypto';

/** @import {Action} from '../core/contracts.js' */
/** @import {ContextItem} from '../core/observation.js' */
/** @import {Handoff} from './handoff.js' */
/** @import {SkillInstructions} from '../core/ports.js' */

/**
 * A conservative identity of the effective delegate input, not a workspace
 * fingerprint. Transient attempt IDs and retry metadata are deliberately
 * excluded because the provider key explicitly refers to the earlier attempt.
 * Context facts, selected evidence, role/skill instructions and execution
 * constraints are included: when any of them changes, the old key is unsafe.
 *
 * @param {{handoff: Handoff, action: Action, context: readonly ContextItem[],
 *   instructions: readonly string[], skillInstructions: readonly SkillInstructions[],
 *   attachments: Handoff['attachments'], requiredCapabilities: readonly string[]}} input
 */
export function workerRequestHash({handoff, action, context, instructions, skillInstructions, attachments, requiredCapabilities}) {
  const {actionId, retryOf, retryBasis, ...semanticAction} = action;
  const payload = {
    // Earlier hashes covered loaded skill text that the built-in renderer did
    // not send. Do not reuse that historical idempotency key for corrected input.
    ...(skillInstructions.length ? {skillDelivery: 'structured-v1'} : {}),
    semanticAction, objective: handoff.objective, expectedResult: handoff.expectedResult,
    continuationReference: handoff.continuationReference, instructions, skillInstructions,
    context, userConstraints: handoff.userConstraints, workspaceContext: handoff.workspaceContext,
    attachments, requiredCapabilities: [...requiredCapabilities].sort(),
    authorityRef: handoff.authorityRef, profileId: handoff.profile.profileId,
    providerId: handoff.profile.providerId, model: handoff.profile.model,
  };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

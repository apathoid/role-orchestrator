import { createHash } from 'node:crypto';
import { decodeDecision } from '../core/contracts.js';
import { decodeControllerIntent } from '../core/controller-intent.js';

/** @typedef {{operationId: string, attemptId: string, contextCursor: number, profileId: string}} ControllerBinding */

/**
 * Bind only trusted invocation facts and inert empty defaults to a complete,
 * model-owned ControllerIntent. The existing Decision decoder/admission remain
 * authoritative; this does not inspect strategy or infer evidence truth.
 * @param {unknown} intent
 * @param {ControllerBinding} binding
 * @returns {ReturnType<typeof decodeDecision>}
 */
export function materializeControllerIntent(intent, binding) {
  const parsed = decodeControllerIntent(intent);
  if (parsed.kind === 'rejected') return { kind: 'rejected', reason: parsed.reason };
  const value = parsed.value;
  // Same invocation + same fully decoded model content => stable identity.
  // This alone is NOT a durable receipt or proof of idempotent native effects.
  const decisionId = 'controller:' + createHash('sha256').update(JSON.stringify([
    binding.operationId, binding.attemptId, value,
  ])).digest('hex');
  return decodeDecision({
    schemaVersion: 1, decisionId, operationId: binding.operationId, contextCursor: binding.contextCursor,
    additions: value.additions, cancellations: value.cancellations, acceptedActionIds: value.acceptedActionIds,
    waitPolicy: value.waitPolicy, clarification: value.clarification, nextController: value.nextController,
    finalAssessment: value.finalAssessment && { ...value.finalAssessment, author: binding.profileId },
    findings: value.findings?.map(item => ({ ...item, author: binding.profileId })),
  });
}

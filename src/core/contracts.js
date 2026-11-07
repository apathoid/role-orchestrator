import { arrayOf, count, decode, id, invalid, measurement, nullable, oneOf, optional, record, text } from './decode.js';

/**
 * All ids are opaque strings scoped by their owning record.
 * @typedef {string} OperationId
 * @typedef {string} ActionId
 * @typedef {string} AttemptId
 * @typedef {string} DecisionId
 * @typedef {string} RequestId
 */

const version = oneOf(1);
const ids = arrayOf(id);
const request = record({
  schemaVersion: version, requestId: id, text,
  attachments: arrayOf(record({ ref: id, mediaType: id })),
  workspaceContext: optional(record({ cwd: optional(id) })),
  userConstraints: arrayOf(text), configurationRef: id,
});

const action = record({
  actionId: id, kind: oneOf('delegate'), objective: text, profileId: id,
  roleId: optional(id), skills: optional(ids), contextRefs: ids, requiredCapabilities: optional(ids),
  dependsOn: arrayOf(record({ actionId: id, kind: oneOf('after_terminal', 'after_model_acceptance') })),
  expectedResult: text, continuationReference: optional(id),
});

const assessment = record({
  author: id, overall: oneOf('complete', 'partial', 'unresolved'),
  requirements: arrayOf(record({
    requirementId: id, status: oneOf('fulfilled', 'partial', 'unverified', 'unavailable'),
    observationRefs: ids, findingRefs: ids,
  })),
  observationRefs: ids, findingRefs: ids, unresolvedQuestions: arrayOf(text), answer: text,
});

const proposal = record({
  schemaVersion: version, decisionId: id, operationId: id, contextCursor: count,
  additions: arrayOf(action), cancellations: ids, acceptedActionIds: optional(ids),
  waitPolicy: optional(record({
    kind: oneOf('all_requested', 'next_completion'),
    targets: arrayOf(record({ kind: oneOf('action', 'attempt'), id })),
  })),
  clarification: optional(record({ question: id })),
  finalAssessment: optional(assessment),
});

/** @typedef {ReturnType<typeof request>} Request */
/** @typedef {ReturnType<typeof action>} Action */
/** @typedef {ReturnType<typeof assessment>} Assessment */
/** @typedef {ReturnType<typeof proposal>} Decision */

export const reasonCode = oneOf(
  'INVALID_PROPOSAL', 'IDENTITY_CONFLICT', 'CAPABILITY_UNAVAILABLE', 'PERMISSION_DENIED',
  'REVOKED', 'RESOURCE_LIMIT', 'PROVIDER_START_FAILED', 'PROTOCOL_ERROR', 'PROVIDER_DISCONNECTED',
  'DEADLINE_EXCEEDED', 'STORE_CONFLICT', 'STORE_UNAVAILABLE', 'CANCELLED',
);
const usage = record({ inputTokens: nullable(count), outputTokens: nullable(count), cost: nullable(measurement) });
const outputRef = record({
  ref: id, source: oneOf('host_observed', 'provider_reported', 'model_claim'),
  kind: oneOf('output', 'agent_exit', 'tool_exit', 'observation', 'finding'),
});
const outcome = record({
  schemaVersion: version, attemptId: id,
  terminal: oneOf('completed', 'failed', 'cancelled', 'unknown'),
  effect: oneOf('none', 'possible', 'confirmed', 'unknown'),
  diagnostics: arrayOf(record({ code: reasonCode, ref: optional(id) })),
  outputRefs: arrayOf(outputRef), usage,
});

/** @typedef {ReturnType<typeof usage>} Usage */
/** @typedef {ReturnType<typeof outcome>} Outcome */
/** @typedef {ReturnType<typeof reasonCode>} ReasonCode */
/** @typedef {'client' | 'user' | 'shutdown' | 'superseded' | 'provider'} CancellationSource */

/** @param {unknown} input */
export const decodeRequest = input => decode(request, input);

/** @param {unknown} input */
export const decodeDecision = input => decode((value, path) => {
  const decision = proposal(value, path);
  if (decision.waitPolicy?.targets.length === 0) invalid(path + '.waitPolicy.targets', 'at least one target');
  if (decision.finalAssessment && (decision.clarification || decision.additions.length)) {
    invalid(path + '.finalAssessment', 'a final assessment without clarification or additions');
  }
  if (!(decision.clarification || decision.finalAssessment || decision.waitPolicy ||
      decision.additions.length || decision.cancellations.length)) {
    invalid(path, 'a decision with an action, wait policy, question or assessment');
  }
  return decision;
}, input);

/** @param {unknown} input */
export const decodeOutcome = input => decode(outcome, input);

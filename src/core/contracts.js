import { findings } from './finding.js';
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
const workspaceContext = optional(record({ cwd: optional(id) }));
export const request = record({
  schemaVersion: version, requestId: id, text,
  attachments: arrayOf(record({ ref: id, mediaType: id })),
  workspaceContext,
  userConstraints: arrayOf(text), configurationRef: id,
});

const actionFields = record({
  actionId: id, kind: oneOf('delegate'), objective: text, profileId: id,
  roleId: optional(id), reasoningLevel: optional(id), skills: optional(ids), contextRefs: ids, requiredCapabilities: optional(ids),
  dependsOn: arrayOf(record({ actionId: id, kind: oneOf('after_terminal', 'after_model_acceptance') })),
  expectedResult: text, continuationReference: optional(id),
  retryOf: optional(id), retryBasis: optional(oneOf('no_effect', 'provider_idempotency', 'user_approval')),
});

/** @type {import('./decode.js').Decoder<ReturnType<typeof actionFields>>} */
export const action = (input, path) => {
  const value = actionFields(input, path);
  if (value.retryOf && !value.retryBasis) invalid(path + '.retryBasis', 'a retry basis');
  if (value.retryBasis && !value.retryOf) invalid(path + '.retryOf', 'the original attempt id');
  return value;
};

export const assessment = record({
  author: id, overall: oneOf('complete', 'partial', 'unresolved'),
  requirements: arrayOf(record({
    requirementId: id, status: oneOf('fulfilled', 'partial', 'unverified', 'unavailable'),
    observationRefs: ids, findingRefs: ids, reason: optional(id),
  })),
  observationRefs: ids, findingRefs: ids, unresolvedQuestions: arrayOf(text), answer: text,
});

export const followup = record({ requestId: id, text, questionId: optional(id), workspaceContext });
/** A Controller continuation is an instruction for the next invocation, not a new Action kind. */
/** @param {unknown} input @param {string} path */
const contextPosition = record({ revision: count, index: count });
/** A history reference is the same identity used by ContextPort.fetch. */
/** @param {unknown} input @param {string} path */
export const contextReference = (input, path) => typeof input === 'string'
  ? id(input, path) : contextPosition(input, path);
const contextReferences = arrayOf(contextReference);
const contextRequest = (input, path) => {
  const value = record({ refs: optional(contextReferences), cursor: optional(count), workCursor: optional(count) })(input, path);
  if ((!value.refs || value.refs.length === 0) && value.cursor === undefined && value.workCursor === undefined) {
    invalid(path, 'nonempty refs and/or cursor');
  }
  if (value.refs && new Set(value.refs.map(ref => JSON.stringify(ref))).size !== value.refs.length) {
    invalid(path + '.refs', 'unique references');
  }
  return value;
};
/** @param {unknown} input @param {string} path */
const nextController = (input, path) => {
  const value = record({ reasoningLevel: optional(id), continue: optional((value, at) =>
    value === true ? true : invalid(at, 'true')), contextRequest: optional(contextRequest) })(input, path);
  if (!value.continue && value.contextRequest) invalid(path + '.continue', 'true for a context request');
  if (!value.continue && !value.reasoningLevel) invalid(path, 'a reasoningLevel or continue: true');
  return value;
};
const proposal = record({
  schemaVersion: version, decisionId: id, operationId: id, contextCursor: count,
  additions: arrayOf(action), cancellations: ids, acceptedActionIds: optional(ids),
  waitPolicy: optional(record({
    kind: oneOf('all_requested', 'next_completion'),
    targets: arrayOf(record({ kind: oneOf('action', 'attempt'), id })),
  })),
  clarification: optional(record({ question: id })), nextController: optional(nextController),
  finalAssessment: optional(assessment), findings: optional(findings),
});

/** @typedef {ReturnType<typeof request>} Request */
/** @typedef {ReturnType<typeof action>} Action */
/** @typedef {ReturnType<typeof assessment>} Assessment */
/** @typedef {ReturnType<typeof proposal>} Decision */

export const reasonCode = oneOf(
  'INVALID_PROPOSAL', 'IDENTITY_CONFLICT', 'CAPABILITY_UNAVAILABLE', 'PERMISSION_DENIED',
  'REVOKED', 'PROVIDER_REFUSED', 'RESOURCE_LIMIT', 'PROVIDER_START_FAILED', 'PROTOCOL_ERROR', 'PROVIDER_DISCONNECTED',
  'DEADLINE_EXCEEDED', 'RETRY_NOT_AUTHORIZED', 'STORE_CONFLICT', 'STORE_UNAVAILABLE', 'CANCELLED',
);
const usage = record({ inputTokens: nullable(count), outputTokens: nullable(count), cost: nullable(measurement) });
const outputRef = record({
  ref: id, providerRef: optional(id), source: oneOf('host_observed', 'provider_reported', 'model_claim'),
  kind: oneOf('output', 'agent_exit', 'tool_exit', 'observation', 'finding'),
});
export const outcome = record({
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
export const decodeDecision = input => decode(decision, input);

/** @type {import('./decode.js').Decoder<Decision>} */
export const decision = (value, path) => {
  const decision = proposal(value, path);
  if (decision.waitPolicy?.targets.length === 0) invalid(path + '.waitPolicy.targets', 'at least one target');
  if (decision.nextController && (decision.finalAssessment || decision.clarification)) {
    invalid(path + '.nextController', 'no continuation after a final assessment or clarification');
  }
  if (decision.nextController?.continue && decision.waitPolicy) {
    invalid(path + '.nextController.continue', 'no simultaneous wait policy');
  }
  if (decision.nextController?.reasoningLevel && !decision.nextController.continue &&
      !decision.additions.length && !decision.cancellations.length && !decision.waitPolicy) {
    invalid(path + '.nextController.continue', 'true or a separate reason for the next Controller turn');
  }
  if (decision.finalAssessment && (decision.clarification || decision.additions.length)) {
    invalid(path + '.finalAssessment', 'a final assessment without clarification or additions');
  }
  if (!(decision.clarification || decision.finalAssessment || decision.waitPolicy ||
      decision.additions.length || decision.cancellations.length || decision.nextController?.continue)) {
    invalid(path, 'a decision with an action, wait policy, question or assessment');
  }
  return decision;
};

/** @param {unknown} input */
export const decodeOutcome = input => decode(outcome, input);

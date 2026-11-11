/** @import {Invocation} from '../core/ports.js' */

const decisionFormat = `Return exactly one JSON object as the final message, with no Markdown fences.
Decision v1 (fields marked ? are optional and should be omitted when absent):
  schemaVersion: 1, decisionId: new string id, operationId: invocation.operationId,
  contextCursor: host:invocation-context.value.contextCursor, additions: Action[], cancellations: string[],
  acceptedActionIds?: string[], waitPolicy?: {kind: "all_requested" | "next_completion", targets: {kind: "action" | "attempt", id: string}[]},
  clarification?: {question: string}, finalAssessment?: Assessment, findings?: Finding[],
  nextController?: {reasoningLevel?: string, continue?: true}
Action: {actionId: string, kind: "delegate", objective: string, profileId: string, contextRefs: string[],
  dependsOn: {actionId: string, kind: "after_terminal" | "after_model_acceptance"}[], expectedResult: string,
  roleId?: string, reasoningLevel?: string, skills?: string[], requiredCapabilities?: string[], continuationReference?: string,
  retryOf?: string, retryBasis?: "no_effect" | "provider_idempotency" | "user_approval"}
Assessment: {author: invocation.profileId, overall: "complete" | "partial" | "unresolved",
  requirements: {requirementId: string, status: "fulfilled" | "partial" | "unverified" | "unavailable",
    observationRefs: string[], findingRefs: string[], reason?: string}[],
  observationRefs: string[], findingRefs: string[], unresolvedQuestions: string[], answer: string}
Finding: {findingId: string, author: invocation.profileId, claim: string, subject: string,
  supports: string[], uncertainties: string[], supersedes?: string}
Use only the named fields. Include an assessment, clarification, wait policy, addition, cancellation, or nextController.continue:true.
Reasoning levels are identifiers provided by the trusted catalog; omit for native/default. Different models are not equivalently intelligent at the same level.
For an independent new Controller turn use nextController:{continue:true,reasoningLevel?:string}. No worker or new event is required.
Additions with continue:true are allowed; otherwise specify a wait policy for additions. Do not combine continue:true with waitPolicy.
Do not combine nextController with finalAssessment or clarification. Assessment cannot accompany new actions or clarification.`;

/** @param {Invocation} request @param {string} transportDetail */
export function renderInvocationPrompt(request, transportDetail) {
  const { kind, operationId, attemptId, actionId, profile: { profileId }, objective,
    instructions, skillInstructions, userConstraints, context, expectedResult, continuationReference } = request;
  const output = kind === 'controller' ? decisionFormat :
    'Return the requested result in your final message. Plain text or the structured text specified by the task is accepted.';
  return output + '\n' + transportDetail + '\n\nInvocation (JSON):\n' + JSON.stringify({
    kind, operationId, attemptId, actionId, profileId, objective, instructions, skillInstructions,
    userConstraints, context, expectedResult, continuationReference,
  });
}

/** @param {string} message @returns {unknown} */
export function parseDecisionText(message) {
  try {
    /** @type {unknown} */
    const value = JSON.parse(message);
    // A v1 Decision is shallow. Preserve excessively nested input as text so
    // it can be recorded without recursive admission of arbitrary JSON.
    return withinDecisionDepth(value, 16) ? value : message;
  } catch {
    return message;
  }
}

/** @param {unknown} value @param {number} remaining @returns {boolean} */
function withinDecisionDepth(value, remaining) {
  return value === null || typeof value !== 'object' ||
    (remaining > 0 && Object.values(value).every(item => withinDecisionDepth(item, remaining - 1)));
}

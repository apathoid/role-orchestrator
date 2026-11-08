/** @import {Invocation} from '../../core/ports.js' */

const decisionFormat = `Return exactly one JSON object as the final message, with no Markdown fences.
Decision v1 (fields marked ? are optional and should be omitted when absent):
  schemaVersion: 1, decisionId: new string id, operationId: invocation.operationId,
  contextCursor: host:invocation-context.value.contextCursor, additions: Action[], cancellations: string[],
  acceptedActionIds?: string[], waitPolicy?: {kind: "all_requested" | "next_completion", targets: {kind: "action" | "attempt", id: string}[]},
  clarification?: {question: string}, finalAssessment?: Assessment, findings?: Finding[]
Action: {actionId: string, kind: "delegate", objective: string, profileId: string, contextRefs: string[],
  dependsOn: {actionId: string, kind: "after_terminal" | "after_model_acceptance"}[], expectedResult: string,
  roleId?: string, skills?: string[], requiredCapabilities?: string[], continuationReference?: string,
  retryOf?: string, retryBasis?: "no_effect" | "provider_idempotency" | "user_approval"}
Assessment: {author: invocation.profileId, overall: "complete" | "partial" | "unresolved",
  requirements: {requirementId: string, status: "fulfilled" | "partial" | "unverified" | "unavailable",
    observationRefs: string[], findingRefs: string[], reason?: string}[],
  observationRefs: string[], findingRefs: string[], unresolvedQuestions: string[], answer: string}
Finding: {findingId: string, author: invocation.profileId, claim: string, subject: string,
  supports: string[], uncertainties: string[], supersedes?: string}
Use only the named fields. Include an assessment, clarification, wait policy, addition, or cancellation.
When adding actions, specify a wait policy. Assessment cannot accompany new actions or clarification.`;

/** @param {Invocation} request @param {string} approvalDetail */
export function renderCodexPrompt(request, approvalDetail) {
  const { kind, operationId, attemptId, actionId, profile: { profileId }, objective,
    instructions, userConstraints, context, expectedResult, continuationReference } = request;
  const output = kind === 'controller' ? decisionFormat :
    'Return the requested result in your final message. Plain text or the structured text specified by the task is accepted.';
  return output + '\n' + approvalDetail +
    '\nContext retrieval is unavailable in this transport. Use the supplied context and report missing evidence explicitly.' +
    '\n\nInvocation (JSON):\n' + JSON.stringify({
    kind, operationId, attemptId, actionId, profileId, objective, instructions,
    userConstraints, context, expectedResult, continuationReference,
  });
}

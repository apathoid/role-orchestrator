// Model-facing reference for Decision v1. The core decoder and admission
// remain authoritative; this is documentation, not a second schema/validator.
export const decisionExample = '{"schemaVersion":1,"decisionId":"example-decision","operationId":"example-operation","contextCursor":0,"additions":[],"cancellations":[],"finalAssessment":{"author":"example-profile","overall":"partial","requirements":[{"requirementId":"example-requirement","status":"unverified","observationRefs":[],"findingRefs":[],"reason":"Not checked"}],"observationRefs":[],"findingRefs":[],"unresolvedQuestions":[],"answer":"Example answer"}}';

export const decisionContract = `Decision v1 (fields marked ? are optional; omit when absent):
  schemaVersion: 1, decisionId: fresh string id, operationId: invocation.operationId,
  contextCursor: host:invocation-context.value.contextCursor (number), additions: Action[], cancellations: string[],
  acceptedActionIds?: string[], waitPolicy?: {kind: "all_requested" | "next_completion", targets: {kind: "action" | "attempt", id: string}[]},
  clarification?: {question: string}, finalAssessment?: Assessment, findings?: Finding[],
  nextController?: {reasoningLevel?: string, continue?: true, contextRequest?: {refs?: (string|{revision:number,index:number}|{ref:string|{revision:number,index:number},offset:number})[], cursor?:0|{revision:number,index:number}, workCursor?:0|{revision:number,index:number}}}
Action: {actionId: string, kind: "delegate", objective: string, profileId: string, contextRefs: string[],
  dependsOn: {actionId: string, kind: "after_terminal" | "after_model_acceptance"}[], expectedResult: string,
  roleId?: string, reasoningLevel?: string, skills?: string[], requiredCapabilities?: string[], continuationReference?: string,
  retryOf?: string, retryBasis?: "no_effect" | "provider_idempotency" | "user_approval"}
Assessment: {author: current profileId, overall: "complete" | "partial" | "unresolved",
  requirements: {requirementId: string, status: "fulfilled" | "partial" | "unverified" | "unavailable",
    observationRefs: string[], findingRefs: string[], reason?: string}[],
  observationRefs: string[], findingRefs: string[], unresolvedQuestions: string[], answer: string}
Finding: {findingId: string, author: current profileId, claim: string, subject: string,
  supports: string[], uncertainties: string[], supersedes?: string}
Each finalAssessment.requirements[] entry needs its own observationRefs and findingRefs arrays, even when the Assessment-level arrays are present; use empty arrays when there are no corresponding refs. Omit absent optional fields; null is allowed only for explicitly nullable types. requirements[].reason is an optional string, not null.
Use only the named fields. Include a finalAssessment, clarification, wait policy, addition, cancellation, or nextController.continue:true.
Additions require a wait policy or continue:true. Wait targets must be nonempty; no waitPolicy with continue:true or clarification.
Do not combine nextController with finalAssessment or clarification. finalAssessment cannot accompany new additions or clarification.
A retryOf and retryBasis must appear together. Use fresh action ids and available references; acceptedActionIds refer to terminal actions.
A contextRequest requires continue:true and at least one ref or a cursor/workCursor; refs must be unique. History cursor and workCursor are independent: 0 starts a new traversal; copy that directory/map's nextCursor exactly. Nonzero numeric offsets are not valid continuation cursors. For saved byte chunks copy nextOffset into offset; positional refs are distinct from page cursors. Decision.contextCursor is the observed numeric Decision revision, not a page cursor. ReasoningLevel alone needs another reason for a next turn.
Decision is submitted through the Controller invocation's declared result contract. Ordinary tool results and files do not submit it. Model messages do not submit on arrival; only the declared result at invocation completion does. A text adapter may select an earlier message if no later message is supplied. Additions propose Host-managed Actions: admission may accept or reject a proposal; accepted work may be deferred and is not necessarily dispatched. Dispatch is not completion or proof of success; the Host reports its actual lifecycle. Wait targets refer to specified Actions/Attempts; continue:true is an alternative to waiting. Use the native structured output contract if supplied; otherwise return one JSON object without fences as the final Controller message. Decision is a transport envelope, not the user's requested output format. Put the user's result in finalAssessment.answer as a string, retaining its requested content and formatting (including Markdown or JSON text). Worker results follow their own task/provider contract.
Example of shape only (not a suggested strategy, status or choice of empty/nonempty arrays; use actual invocation operationId and profileId (profile.profileId on ProviderPort) and observed contextCursor, not these placeholders):
${decisionExample}`;

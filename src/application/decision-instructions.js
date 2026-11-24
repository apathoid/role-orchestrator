// Model-facing transport reference only. src/core/contracts.js and admission
// remain authoritative; this is neither a Host schema nor a strategy template.
export const decisionExample = '{"schemaVersion":1,"decisionId":"example-decision","operationId":"example-operation","contextCursor":0,"additions":[],"cancellations":[],"finalAssessment":{"author":"example-profile","overall":"complete","requirements":[],"observationRefs":[],"findingRefs":[],"unresolvedQuestions":[],"answer":"Example answer"}}';

export const assessmentAnswerGuidance = `The final user-facing response is the exact finalAssessment.answer string, including requested Markdown, Unicode,
or JSON text.
Provide the requested result directly, including its applicable content and formatting requirements,
rather than merely reporting that it has been prepared. When the request is for an action or an external artifact,
provide the appropriate outcome, artifact references and material limitations.`;

export const decisionContract = `Decision v1 — declared result of a completed Controller invocation, not a format for native thoughts, plans, tools, progress, Worker results or the user's answer.
Required fields: {schemaVersion: 1, decisionId: fresh non-empty string, operationId: invocation.operationId,
  contextCursor: observed host:invocation-context.value.contextCursor (number), additions: Action[], cancellations: string[]}.
Optional fields (omit when absent; do not use null): acceptedActionIds: string[],
  waitPolicy: {kind: "all_requested" | "next_completion", targets: {kind: "action" | "attempt", id: string}[]},
  clarification: {question: non-empty string}, finalAssessment: Assessment, findings: Finding[],
  nextController: {reasoningLevel?: string, continue?: true,
    contextRequest?: {refs?: (string|{revision:number,index:number}|{ref:string|{revision:number,index:number},offset:number})[],
      cursor?:0|{revision:number,index:number}, workCursor?:0|{revision:number,index:number}}}.
Action: {actionId: fresh string, kind: "delegate", objective: string, profileId: string,
  contextRefs: string[], dependsOn: {actionId: string, kind: "after_terminal" | "after_model_acceptance"}[],
  expectedResult: string, roleId?: string, reasoningLevel?: string, skills?: string[],
  requiredCapabilities?: string[], continuationReference?: string,
  retryOf?: string, retryBasis?: "no_effect" | "provider_idempotency" | "user_approval"}.
Assessment: {author: current profileId, overall: "complete" | "partial" | "unresolved",
  requirements: {requirementId: string, status: "fulfilled" | "partial" | "unverified" | "unavailable",
    observationRefs: string[], findingRefs: string[], reason?: non-empty string}[],
  observationRefs: string[], findingRefs: string[], unresolvedQuestions: string[], answer: string}.
Finding: {findingId: string, author: current profileId, claim: string, subject: string,
  supports: string[], uncertainties: string[], supersedes?: string}.

Decision fields describe transport, not an obligatory workflow: a direct finalAssessment, optional delegation,
wait for accepted Actions, clarification, cancellation, findings or explicit nextController.continue are all valid.
Include at least one effective action: finalAssessment, clarification, waitPolicy, additions with waitPolicy/continue,
cancellations or nextController.continue:true. No clarification with waitPolicy.
Do not combine finalAssessment with additions, clarification or nextController. No nextController with clarification.
Wait targets must be nonempty. acceptedActionIds must name terminal Actions.
retryOf and retryBasis appear together; a new Action uses a fresh actionId.
contextRequest needs continue:true plus a ref or cursor/workCursor. Requested refs must be unique;
0 starts a traversal; a subsequent page uses the returned {revision,index}, not a numeric offset.
Decision.contextCursor is the observed Decision revision, not a history/page cursor.
Assessment requirements each have their own observationRefs and findingRefs, even when empty; reason, if present,
must be a non-empty string. Use actual observed refs; never invent tool/observation evidence.

${assessmentAnswerGuidance} A text adapter returns a single JSON object without Markdown fences as the final Controller message;
the native structured result contract may be used where available. Ordinary tool results, files, intermediate
messages and native subagents do not submit a Decision. Admission may reject proposed Host Actions; accepted work
is not necessarily dispatched or completed. Host Catalog skills are distinct from provider-native tools/skills.

Shape-only JSON example below: not a suggested task strategy, status, refusal to delegate, or advice to ignore
user requirements. Replace ids, author, contextCursor and content with actual invocation data:
${decisionExample}`;

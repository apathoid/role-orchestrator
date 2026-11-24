// Model-facing model-owned ControllerIntent, not an alternative admission
// schema. The full canonical Decision v1 decoder remains authoritative.
import { assessmentAnswerGuidance } from './decision-instructions.js';

export const controllerIntentExample = '{"finalAssessment":{"overall":"complete","answer":"Example answer"}}';

export const controllerIntentContract = `ControllerIntent — the model-owned declaration for this Controller invocation. The Host binds
schemaVersion:1, decisionId, operationId, the actual observed contextCursor and
the selected Controller profile as author on findings and Assessment. Do NOT
include any of those technical fields, including nested author.
Model-owned top-level fields (omit optional absent fields; never send null):
  additions: Action[], cancellations: string[], acceptedActionIds?: string[],
  waitPolicy?: {kind:"all_requested"|"next_completion",targets:{kind:"action"|"attempt",id:string}[]},
  clarification?: {question:string},
  nextController?: {reasoningLevel?:string,continue?:true,
    contextRequest?:{refs?:(string|{revision:number,index:number}|{ref:string|{revision:number,index:number},offset:number})[],
      cursor?:0|{revision:number,index:number},workCursor?:0|{revision:number,index:number}}},
  finalAssessment?: Assessment, findings?: Finding[].
Action: {actionId:string,kind:"delegate",profileId:string,objective:string,expectedResult:string,
  roleId?:string,reasoningLevel?:string,skills?:string[],requiredCapabilities?:string[],
  contextRefs?:string[],dependsOn?:{actionId:string,kind:"after_terminal"|"after_model_acceptance"}[],
  continuationReference?:string,retryOf?:string,retryBasis?:"no_effect"|"provider_idempotency"|"user_approval"}.
Assessment: {overall:"complete"|"partial"|"unresolved",answer:string,
  requirements?:{requirementId:string,status:"fulfilled"|"partial"|"unverified"|"unavailable",
    observationRefs?:string[],findingRefs?:string[],reason?:string}[],
  observationRefs?:string[],findingRefs?:string[],unresolvedQuestions?:string[]}.
Finding: {findingId:string,claim:string,subject:string,supports?:string[],
  uncertainties?:string[],supersedes?:string}.
Empty additions/cancellations, Action contextRefs/dependsOn, Finding supports/uncertainties,
Assessment requirements/observationRefs/findingRefs/unresolvedQuestions and
Requirement observationRefs/findingRefs default only to empty arrays when omitted.
Explicit null is invalid. The model owns all IDs, action semantics, references,
overall/status/answer, uncertainty, dependencies and continuation. The Host does
not invent a semantic default, resolve evidence relevance or choose a strategy.
All existing Decision v1 combinations and admission/reference checks apply:
direct answer, delegation, wait, clarification, cancellation, findings,
partial/unresolved and optional continuation are all legitimate.
Do not combine finalAssessment with additions or clarification; actions require
an explicit waitPolicy or continue:true. Wait targets must be nonempty.
Role Orchestrator records observations with scoped references and source provenance.
When citing observations in Findings or Assessment, use available references
from the orchestration context or optional observation discovery/retrieval
capabilities. Retrieve details when useful and independently evaluate relevance,
sufficiency and uncertainty. Retrieval is optional; do not invent unavailable
references. History cursor 0 starts a traversal; a returned {revision,index}
continues that traversal, not a numeric offset.

${assessmentAnswerGuidance}

In text mode send ONLY one JSON ControllerIntent object as final Controller
message (no Markdown fences). In MCP mode submit_decision({intent,replaces?})
registers only a proposed result: it never dispatches Actions, completes the
turn or disables native tools, skills, reading or reasoning. Its proposalRef
can be used by a later correction in this SAME native invocation only (not across invocations); explicit
same-lineage competing replacements use registration-order last-wins.
Unrelated proposals without replaces conflict until corrected; errors can
be corrected without a new Controller invocation. After the trusted native
turn ends, at most one final validated intent enters existing admission.
The native final message may be ordinary text or empty in MCP mode. No
extra finalize call is required.

Shape example ONLY (not task strategy):
${controllerIntentExample}`;

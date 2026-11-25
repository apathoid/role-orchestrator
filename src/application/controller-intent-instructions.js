// Model-facing model-owned ControllerIntent, not an alternative admission
// schema. The full canonical Decision v1 decoder remains authoritative.
import { assessmentAnswerGuidance, decisionCoordinationContract } from './decision-instructions.js';

export const controllerIntentExample = '{"finalAssessment":{"overall":"complete","answer":"Example answer"}}';

export const controllerIntentInputDescription = `ControllerIntent — the model-owned declaration for this Controller invocation. The Host binds
schemaVersion:1, decisionId, operationId, the actual observed contextCursor and
the selected Controller profile as author on findings and Assessment. Do NOT
include any of those technical fields, including nested author.
Model-owned top-level fields (omit optional absent fields; never send null):
  additions?: Action[], cancellations?: string[], acceptedActionIds?: string[],
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
Explicit null is invalid. The model owns Action, Finding and requirement IDs, action semantics, references,
overall/status/answer, uncertainty, dependencies and continuation. The Host does
not invent a semantic default, resolve evidence relevance or choose a strategy.`;

export const controllerIntentContract = `${controllerIntentInputDescription}
${decisionCoordinationContract}

${assessmentAnswerGuidance}

Shape example ONLY (not task strategy):
${controllerIntentExample}`;

// Only the MCP delivery path advertises this native-turn contract.
export const controllerIntentMcpDelivery = `Use the invocation-scoped MCP submit_decision({intent,replaces?}) to register a model-owned ControllerIntent proposal.
A received proposal never dispatches Actions, completes the native turn or disables native tools, skills, reading or reasoning.
A receipt with registered:true identifies a known proposalRef in this native invocation only, not a guarantee of replacement eligibility. registered:false means the allocated ref never entered the lineage registry; it is not a replacement target. Explicit same-lineage competing replacements use registration-order last-wins.
Unrelated proposals without replaces conflict until corrected; errors can be corrected without a new Controller invocation.
After the trusted native turn ends, at most one final validated intent enters existing admission.
When ending the turn, you do not need to repeat the submitted answer.
The native final message may be ordinary text or empty. No extra finalize call is required.`;

// Deterministic audit: no model calls, no prompts persisted, no provider-specific assumptions.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createUsageAccumulator } from '../../src/efficiency/usage-observations.mjs';
import { createEfficiencyRun } from '../../src/efficiency/analytics.mjs';
import { profileRolePrompt, profileProviderPrompt, normalizeContextProfile } from '../../src/efficiency/profiling.mjs';
import { normalizeEfficiencyRuns, saveSession, loadSession } from '../../src/session-store.mjs';

const secret = 'NEVER-PERSIST-SECRET-REASONING-CODE';
const known = { userTask: `Fix UI ${secret}`, plan: 'plan: step A', verification: 'test suite stdout' };
const taskBody = `USER TASK:\n${known.userTask}\n\nPLAN:\n${known.plan}\n\nVERIFICATION:\n${known.verification}`;
const sections = ['ROLE CONTRACT: safe', 'CONTEXT: prior facts', '', taskBody, 'checkpoint'];
const text = sections.filter(Boolean).join('\n\n');
const profile = profileRolePrompt({ sections, prompt:text, taskBodySources:[
  {kind:'user_task',value:known.userTask}, {kind:'plan',value:known.plan},
  {kind:'verification',value:known.verification},
]});
assert.equal(profile.taskBody.sourceCoverage,3);
assert.equal(profile.taskBody.sections.reduce((n,x)=>n+x.characters,0),taskBody.length);
assert.equal(profile.taskBody.sections.find(x=>x.kind==='plan').characters,known.plan.length);
assert.equal(profile.taskBody.sections.find(x=>x.kind==='other').characters,taskBody.length-known.userTask.length-known.plan.length-known.verification.length);
assert(!JSON.stringify(profile).includes(secret));
assert.deepEqual(normalizeContextProfile(profile),profile);
assert.equal(normalizeContextProfile({...profile,taskBody:{...profile.taskBody,sections:profile.taskBody.sections.map(x=>({...x,characters:x.characters+1}))}}),null);
assert.deepEqual(profileProviderPrompt('😀',3),{scope:'provider_adapter_prepared_only',characters:2,utf8Bytes:4,textBlocks:1,supplementalBlocks:3});

const accum = createUsageAccumulator();
accum.observe({scope:'request',scopeId:'req-A',semantics:'final',inputTokens:50,outputTokens:10});
accum.observe({scope:'request',scopeId:'req-A',semantics:'final',inputTokens:50,outputTokens:10});
accum.observe({scope:'request',scopeId:'req-B',semantics:'final',inputTokens:40,outputTokens:4});
assert.deepEqual([accum.summary().usage.inputTokens,accum.summary().usage.outputTokens],[90,14]);
assert.equal(accum.summary().completeness,'complete');
const partial=createUsageAccumulator();
partial.observe({scope:'request',scopeId:'A',semantics:'final',inputTokens:100,outputTokens:20});
partial.observe({scope:'request',scopeId:'B',semantics:'final',inputTokens:null,outputTokens:40});
assert.equal(partial.summary().usage.inputTokens,null,'missing request input is not zero');
assert.equal(partial.summary().usage.outputTokens,60);
assert.equal(partial.summary().completeness,'partial');
const delta=createUsageAccumulator();
delta.observe({scope:'generation',scopeId:'g1',semantics:'delta',observationId:'d1',inputTokens:25});
delta.observe({scope:'generation',scopeId:'g1',semantics:'delta',observationId:'d1',inputTokens:25});
delta.observe({scope:'generation',scopeId:'g1',semantics:'delta',observationId:'d2',inputTokens:5});
assert.equal(delta.summary().usage.inputTokens,30,'duplicate delta IDs must not count twice');
const mixed=createUsageAccumulator();
mixed.observe({scope:'turn',semantics:'cumulative',inputTokens:200});
mixed.observe({scope:'request',scopeId:'req',semantics:'final',inputTokens:100});
assert.equal(mixed.summary().usage.inputTokens,null,'nested counters must not be added together');
assert.equal(mixed.summary().ambiguous,true);
const incomplete=createUsageAccumulator();
incomplete.observe({scope:'request',semantics:'final',inputTokens:999});
assert.equal(incomplete.summary().usage.inputTokens,null,'unidentified request must not contribute to total');
const occupancy=createUsageAccumulator();
occupancy.observe({semantics:'occupancy',contextUsedTokens:3000,contextWindow:32000});
assert.equal(occupancy.summary().scopeCount,0,'occupancy is not billed usage');

const run=createEfficiencyRun('telemetry-run');
run.onEvent({type:'fix_round',round:2});
run.onEvent({type:'role_start',invocationId:'fix',role:'coderMedium',executionScope:{phase:'fix',fixRound:2}});
run.onEvent({type:'role_thought_chunk',invocationId:'fix',text:secret});
run.onEvent({type:'role_activity',invocationId:'fix',activity:'answer'});
run.onEvent({type:'role_provider_prompt_profile',invocationId:'fix',profile:profileProviderPrompt('private '+secret,0)});
for(let i=0;i<100;i++) run.onEvent({type:'role_usage',invocationId:'fix',usage:{contextUsedTokens:100+i*5,contextWindow:1000}});
run.onEvent({type:'role_tool_event',invocationId:'fix',update:{sessionUpdate:'tool_call',toolCallId:'opaque-tool-123',title:secret}});
run.onEvent({type:'role_tool_event',invocationId:'fix',update:{sessionUpdate:'tool_call_update',toolCallId:'opaque-tool-123',raw:secret}});
run.onEvent({type:'role_done',invocationId:'fix',elapsedMs:100});
run.onEvent({type:'role_start',invocationId:'responder',role:'responderLow',executionScope:{phase:'response'}});
run.onEvent({type:'role_done',invocationId:'responder',elapsedMs:5});
const record=run.finish({status:'completed'});
const row=record.invocations[0];
assert.equal(row.fixRound,2);
assert.equal(record.invocations[1].fixRound,null,'responder cannot inherit fix round');
assert.equal(row.firstReasoningElapsedMs!==null,true);
assert.equal(row.firstAnswerElapsedMs!==null,true);
assert.equal(row.toolCalls,1);
assert.equal(row.contextOccupancy.peak,595);
assert(row.contextTimeline.samples.length<=40,'bounded samples');
assert(row.contextTimeline.truncated);
assert(row.contextTimeline.samples.some(p=>p.usedTokens===100));
assert(row.contextTimeline.samples.some(p=>p.usedTokens===595));
assert(!JSON.stringify(record).includes(secret));
assert(!JSON.stringify(record).includes('opaque-tool-123'));
const persisted=normalizeEfficiencyRuns([record])[0].invocations[0];
assert.equal(persisted.firstAnswerElapsedMs,row.firstAnswerElapsedMs);
assert.equal(persisted.contextTimeline.samples.length,row.contextTimeline.samples.length);
assert.equal(persisted.providerPromptProfile.characters,'private '.length+secret.length);
assert.equal(normalizeEfficiencyRuns([{...record, invocations:[{...row, providerPromptProfile:{...row.providerPromptProfile,text:secret},contextTimeline:{...row.contextTimeline,samples:[{elapsedMs:0,usedTokens:1,raw:secret}]}}]}])[0].invocations[0].contextTimeline.samples[0].raw,undefined);

const previous=process.env.AGENT_STATE_DIR;
const temp=await mkdtemp(join(tmpdir(),'monitor-hardening-'));
process.env.AGENT_STATE_DIR=temp;
try {
  // Many repeated independent runs must not grow persisted telemetry without bound.
  const repeated=Array.from({length:70},(_,i)=>({...record,runId:`run-${i}`,invocations:Array.from({length:70},(_,j)=>({...row,invocationId:`inv-${i}-${j}`}))}));
  await saveSession('s', {cwd:temp, efficiencyRuns:repeated});
  const data=await readFile(join(temp,'sessions','s.json'),'utf8');
  assert(Buffer.byteLength(data,'utf8')<20_000_000);
  assert(!data.includes(secret));
  const loaded=await loadSession('s');
  assert(loaded.efficiencyTelemetryTruncated,'optional metrics cap must be explicit');
  assert(loaded.efficiencyRuns.length<70);
} finally {
  if(previous===undefined) delete process.env.AGENT_STATE_DIR;
  else process.env.AGENT_STATE_DIR=previous;
  await rm(temp,{recursive:true,force:true});
}
console.log('evaluation/p3-monitoring-hardening: PASS');

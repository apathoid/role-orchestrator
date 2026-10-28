import assert from 'node:assert/strict';
import { normalizeAcpToolObservation, safeNormalizeAcpToolObservation, acpObservationVersion } from '../../src/providers/acp/tool-events.mjs';
import { createToolMetricsAccumulator } from '../../src/efficiency/tool-metrics.mjs';
import { createEfficiencyRun } from '../../src/efficiency/analytics.mjs';
import { normalizeEfficiencyRuns } from '../../src/session-store.mjs';
import { efficiencyReadiness } from '../../src/efficiency/readiness.mjs';
import { profileRolePrompt, normalizeContextProfile } from '../../src/efficiency/profiling.mjs';
import { normalizeAgentEvent } from '../../src/providers/events.mjs';

const canary='SECRET_TOOL_OUTPUT_🔒';
const upd=(toolCallId,rest={})=>({sessionUpdate:'tool_call_update',toolCallId,...rest});
const text=s=>({type:'content',content:{type:'text',text:s}});
const normalize=(u,v='v2')=>normalizeAcpToolObservation(u,{version:v});

assert.equal(safeNormalizeAcpToolObservation({sessionUpdate:'tool_call',toolCallId:'x',get content(){throw Error('untrusted');}})?.content ?? null,null);
assert.equal(acpObservationVersion(2,upd('x')),'v2');
assert.equal(acpObservationVersion(1,upd('x')),'v1');
assert.equal(acpObservationVersion('2.1',upd('x')),'v2');
assert.equal(acpObservationVersion(1,{sessionUpdate:'tool_call_content_chunk'}),'v2');

// Upsert creates the tool; status-only updates cannot erase the last kind.
const accumulator=createToolMetricsAccumulator();
accumulator.observe(normalize(upd('A',{kind:'read',status:'in_progress',content:[text('abc')]})),10);
accumulator.observe(normalize(upd('A',{status:'completed'})),30);
accumulator.observe(normalize(upd('A',{status:'completed'})),35);
assert.deepEqual(accumulator.snapshot().kinds,{read:1});
assert.equal(accumulator.snapshot().completed,1);
assert.equal(accumulator.snapshot().contentCharacters,3);
assert.equal(accumulator.snapshot().lifecycleMs,20);
assert.equal(accumulator.snapshot().runningMs,20);
assert.equal(accumulator.snapshot().calls,1);

// Streaming appends individual items, then a snapshot replaces all content.
const inc=createToolMetricsAccumulator();
inc.observe(normalize({sessionUpdate:'tool_call_content_chunk',toolCallId:'B',content:text('a')},'v2'),1);
inc.observe(normalize({sessionUpdate:'tool_call_content_chunk',toolCallId:'B',content:text('é💖')},'v2'),2);
assert.equal(inc.snapshot().contentCharacters,4);
assert.equal(inc.snapshot().contentUtf8Bytes,7);
inc.observe(normalize(upd('B',{kind:'execute',content:[text('xy')]})),3);
assert.equal(inc.snapshot().contentCharacters,2,'snapshot replaces chunks');
inc.observe(normalize({sessionUpdate:'tool_call_content_chunk',toolCallId:'B',content:text('!')}),4);
assert.equal(inc.snapshot().contentCharacters,3);
inc.observe(normalize(upd('B',{content:[]})),5);
assert.equal(inc.snapshot().contentCharacters,0);
inc.observe(normalize(upd('B',{status:'failed'})),6);
assert.equal(inc.snapshot().failed,1);
assert.equal(inc.snapshot().kinds.execute,1);

// Non-text (image / terminal) is unknown, not an invented zero output.
const unknown=createToolMetricsAccumulator();
unknown.observe(normalize(upd('img',{content:[{type:'content',content:{type:'image',data:canary}}]})),0);
assert.equal(unknown.snapshot().contentCharacters,null);
assert.equal(unknown.snapshot().contentCoverage.unknown,1);
unknown.observe(normalize(upd('img',{content:[text('abc'),{type:'terminal',terminalId:'x'}]})),1);
assert.equal(unknown.snapshot().contentCoverage.partial,1);
assert.equal(unknown.snapshot().contentCharacters,3);
unknown.observe(normalize(upd('img',{content:null})),2);
assert.equal(unknown.snapshot().contentCharacters,0);

// Explicit clear (v2) differs from omission; v1 null does not clear status.
const versioned=createToolMetricsAccumulator();
versioned.observe(normalize(upd('k',{kind:'search',status:'in_progress'}),'v2'),1);
versioned.observe(normalize(upd('k',{kind:null,status:null}),'v2'),2);
assert.equal(versioned.snapshot().kinds.unknown,1);
assert.equal(versioned.snapshot().incomplete,1);
const v1=createToolMetricsAccumulator();
v1.observe(normalize({sessionUpdate:'tool_call',toolCallId:'k',kind:'read',status:'in_progress'},'v1'),0);
v1.observe(normalize(upd('k',{kind:null,status:null}),'v1'),1);
assert.equal(v1.snapshot().kinds.read,1);

// Late kind, deduplication and a terminal-only first event.
const late=createToolMetricsAccumulator();
late.observe(normalize(upd('c',{status:'completed'})),1);
late.observe(normalize(upd('c',{kind:'delete'})),3);
assert.equal(late.snapshot().completed,1);
assert.equal(late.snapshot().lifecycleCoverage,0);
assert.equal(late.snapshot().kinds.delete,1);
assert.equal(late.snapshot().contentCoverage.notObserved,1);
late.observe(normalize(upd('d',{status:'cancelled',kind:'move'})),4);
assert.equal(late.snapshot().cancelled,1);
assert.equal(late.snapshot().incomplete,0);

// Aggressive privacy boundary: no tool content, names or IDs persisted.
const run=createEfficiencyRun('tool-audit-run');
run.onEvent({type:'role_start',invocationId:'role',role:'explorer',model:'fake'});
for (const [i,update] of [
  upd('secret-id',{kind:'read',status:'in_progress',content:[text(canary)]}),
  upd('secret-id',{status:'completed'}),
  upd('two',{kind:'execute',status:'failed',content:[{type:'terminal',terminalId:'secret-terminal'}]}),
].entries()) run.onEvent({type:'role_tool_event',invocationId:'role',update,toolObservation:normalize(update)});
run.onEvent({type:'role_done',invocationId:'role',elapsedMs:100});
const raw=run.finish({status:'completed'});
assert.equal(raw.invocations[0].toolCalls,2);
assert.equal(raw.invocations[0].toolMetrics.completed,1);
assert.equal(raw.invocations[0].toolMetrics.failed,1);
assert.equal(raw.invocations[0].toolMetrics.contentCharacters,null);
assert.equal(raw.invocations[0].toolCategories.execute,1);
assert(!JSON.stringify(raw).includes(canary));
assert(!JSON.stringify(raw).includes('secret-id'));
const roundtrip=normalizeEfficiencyRuns(JSON.parse(JSON.stringify([raw])))[0];
assert.deepEqual(roundtrip.invocations[0].toolMetrics.kinds,{read:1,execute:1});
assert.equal(roundtrip.invocations[0].toolMetrics.contentCharacters,null);
assert.equal(efficiencyReadiness([roundtrip]).coverage.toolsObserved,1);
const poisoned=structuredClone(raw);
poisoned.invocations[0].toolMetrics.rawOutput=canary;
poisoned.invocations[0].toolMetrics.kinds={'read':1,'execute':1,[canary]:42};
poisoned.invocations[0].toolMetrics.contentCoverage.secret=canary;
assert(!JSON.stringify(normalizeEfficiencyRuns([poisoned])).includes(canary));

// Reference scopes are validated and do not change actual prompt construction.
const profile=profileRolePrompt({prompt:'x',sections:['','','','', ''],instructionSources:[
  {scope:'project-reference',body:'rule text'},
  {scope:'global-orchestrator-reference',body:'global text'},
  {scope:'active-skill',body:'skill'},
]});
assert.equal(profile.instructionSources.length,3);
const actualScopeSamples=[
  ...Array.from({length:14},()=>({scope:'project-reference',body:'canonical'})),
  {scope:'project',body:'AGENTS'},{scope:'global-orchestrator',body:'ORCHESTRATOR'}
];
const projectProfile=profileRolePrompt({prompt:'unchanged',sections:['','','','', ''],instructionSources:actualScopeSamples});
assert.equal(projectProfile.instructionSources.length,16, 'all inventory documents are attributed');
assert.equal(projectProfile.promptCharacters,9, 'profiling must not rewrite prompts');
assert.equal(normalizeContextProfile(projectProfile).instructionSources.length,16);
const badContent=normalize({sessionUpdate:'tool_call_update',toolCallId:'huge',content:Array.from({length:2049},()=>text('x'))});
assert.equal(badContent.content.coverage,'partial', 'bounded measurement explicitly reports partial');
const future=createToolMetricsAccumulator();
future.observe(normalize(upd('future',{kind:'_custom_tool'})),1);
assert.equal(future.snapshot().kinds.unknown,1);
assert.equal(future.snapshot().kindCoverage.unknown,1);
const cap=createToolMetricsAccumulator();
for(let i=0;i<2050;i++) cap.observe(normalize(upd(`cap-${i}`,{kind:'read'})),i);
assert.equal(cap.snapshot().calls,2048);
assert.equal(cap.snapshot().truncated,true);
const oldRun=structuredClone(raw);
delete oldRun.invocations[0].toolMetrics;
const normalizedOld=normalizeEfficiencyRuns([oldRun])[0].invocations[0];
assert.equal(normalizedOld.toolMetrics,null, 'old ledgers remain readable');
assert.equal(normalizedOld.toolCalls,2);

assert.equal(normalizeContextProfile(profile).instructionSources.length,3);
assert.equal(normalizeAgentEvent({type:'tool_event',update:{toolCallId:'x'},observation:{type:'tool_observation'}}).observation.type,'tool_observation');
console.log('evaluation/p3-tool-events: PASS (ACP upsert, chunk, patch, counters, scopes, persistence and privacy)');

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { acpActivity, acpExecutionInline, acpExecutionNotices, formatAcpExecution, acpFindingText, formatActivity, formatExecution, formatRecordedFindings, scopedNativeId, terminalText, createTerminalSanitizer, factLabel, formatOperation } from '../../src/hosts/presentation.js';

const native = (kind, payload, extra = {}) => ({kind,payload, operationId:'op',attemptId:'a',profileId:'reviewer',providerId:'provider',sequence:1,source:'provider_activity',...extra});
test('presentation preserves actual chunks and distinguishes tool, finding, lifecycle and gaps', () => {
  const thought = native('reasoning',{sessionUpdate:'agent_thought_chunk',content:{type:'text',text:'hello\x1b[2J\x1b]52;c;secret\x07\nworld'}},{nativeKind:'agent_thought_chunk'});
  assert.equal(formatActivity(thought,'compact'),'[reviewer/a] Thinking: hello\nworld');
  assert.equal(thought.payload.content.text.includes('\x1b'),true);
  assert.equal(terminalText('a\r\x00b'),'ab');
  const tool = native('tool',{sessionUpdate:'tool_call',toolCallId:'t',title:'Read',status:'in_progress'});
  assert.equal(formatActivity(tool,'compact'),'[reviewer/a] Tool Read · in_progress');
  assert.equal(formatActivity(tool,'detailed'),'[reviewer/a] Tool Read · in_progress');
  assert.equal(formatActivity(native('finding',{claim:'A model claim'}),'compact'),'[reviewer/a] Reported finding: A model claim');
  assert.equal(formatActivity({kind:'gap',operationId:'op',droppedCount:5,reason:'overflow'},'compact'),'[Activity gap] 5 notices dropped');
  assert.equal(formatExecution({eventName:'attempt.dispatched',attemptId:'a',actionId:'a',reasonCode:'DISPATCH_STARTED'},'compact'),
    '[Controller a] Invocation dispatched');
  assert.equal(formatExecution({eventName:'context.materialized',reasonCode:'DELIVERED'},'compact'),undefined);
  assert.match(formatRecordedFindings({kind:'attempt.outcome',findings:[{findingId:'f',author:'reviewer',claim:'Observed issue',subject:'file',supports:['obs'],uncertainties:['unknown']}]},'detailed')[0].text,/Observed issue.*file[\s\S]*Uncertainty: unknown[\s\S]*Supports: obs/);
});
test('ACP mapping uses actual native standard fields and scoped IDs without synthetic events', () => {
  const tool = native('tool',{sessionUpdate:'tool_call',toolCallId:'shared',title:'Read',status:'pending'});
  const update = native('tool',{sessionUpdate:'tool_call_update',toolCallId:'shared',status:'completed'});
  assert.equal(acpActivity(tool,'compact',false).toolCallId,scopedNativeId('a','shared'));
  assert.equal(acpActivity(update,'detailed',false).toolCallId,acpActivity(tool,'compact',false).toolCallId);
  assert.notEqual(acpActivity({...tool,attemptId:'b'},'compact',false).toolCallId,acpActivity(tool,'compact',false).toolCallId);
  const plan = native('plan',{sessionUpdate:'plan',entries:[{content:'Native plan',priority:'medium',status:'pending'}]});
  assert.equal(acpActivity(plan,'detailed',false),undefined);
  for(const mode of ['compact','detailed','debug']){
    const nativePlan=acpActivity(plan,mode,true);
    assert.deepEqual(nativePlan.entries,plan.payload.entries);
    assert.deepEqual(nativePlan._meta.roleOrchestratorSource,{operationId:'op',attemptId:'a',
      profileId:'reviewer',providerId:'provider',sequence:1,source:'provider_activity'});
    assert.equal(nativePlan.messageId,undefined);
    assert.notEqual(nativePlan.entries,undefined);
  }
  assert.deepEqual(plan.payload.entries,[{content:'Native plan',priority:'medium',status:'pending'}]);
  const thought = native('reasoning',{sessionUpdate:'agent_thought_chunk',content:{type:'text',text:'original'}});
  assert.deepEqual(acpActivity(thought,'compact',false).content,thought.payload.content);
  assert.equal(acpActivity(native('reasoning',{type:'item.updated',item:{type:'reasoning',text:'snapshot'}},{nativeKind:'item.updated'}),'compact',true),undefined);
  assert.equal(acpActivity(native('reasoning',{type:'item.completed',item:{type:'reasoning',text:'summary'}},{nativeKind:'item.completed'}),'compact',true).content.text,'summary');
  assert.equal(acpActivity(native('finding',{claim:'model claim'}),'debug',true),undefined);
  assert.equal(acpActivity({kind:'gap',operationId:'op',droppedCount:1,reason:'overflow'},'debug',true),undefined);
});

test('C14R.1 anonymous ACP thought keeps trusted attempt metadata without inventing message boundaries',()=>{
  const chunk={sessionUpdate:'agent_thought_chunk',content:{type:'text',text:'fragment'},_meta:{native:'unchanged',roleOrchestratorSource:{attemptId:'forged'}}};
  const a=native('reasoning',chunk), b={...a,attemptId:'b'};
  const mapped=[a,b,a].map(x=>acpActivity(x,'compact',false));
  assert.deepEqual(mapped.map(x=>x._meta.roleOrchestratorSource.attemptId),['a','b','a']);
  assert.ok(mapped.every(x=>x.messageId===undefined&&x._meta.native==='unchanged'));
  assert.equal(chunk._meta.roleOrchestratorSource.attemptId,'forged');
  const identified={...a,payload:{...chunk,messageId:'shared'},nativeId:'shared'};
  assert.equal(acpActivity(identified,'compact',false).messageId,scopedNativeId('a','shared'));
  assert.equal(acpActivity({...identified,attemptId:'b'},'compact',false).messageId,scopedNativeId('b','shared'));
  const codex=native('reasoning',{type:'item.completed',item:{id:'item',type:'reasoning',text:'summary'}},{nativeId:'item',nativeKind:'item.completed'});
  assert.equal(acpActivity(codex,'compact',false).messageId,scopedNativeId('a','item'));
  assert.equal(acpActivity(codex,'compact',false)._meta.roleOrchestratorSource.nativeId,'item');
});

test('C15.2 split terminal controls are removed without buffering reasoning',()=>{
  const sanitizer=createTerminalSanitizer();
  assert.equal(sanitizer.push('first\x1b]52;c;'),'first');
  assert.equal(sanitizer.push('SECRET\x1b'),'');
  assert.equal(sanitizer.push('\\ second\x1b['),' second');
  assert.equal(sanitizer.push('2J third\u202e'),' third');
  assert.equal(sanitizer.push(' end'),' end');
  sanitizer.reset();
  assert.equal(sanitizer.push('new source'),'new source');
});


test('C15.6 labels keep historical attempt identity and do not allow line injection',()=>{
  const label=factLabel({invocationKind:'delegate',roleId:'role\n'+ 'x'.repeat(400),attemptOrdinal:7,profileId:'p\tfake'});
  assert.match(label,/#7 · p fake$/);
  assert.doesNotMatch(label,/[\n\t]/);
});


test('C15.6 late and conflicting outcome reports never imply accepted terminal state; invalid field is addressable',()=>{
  const event={eventName:'attempt.outcome_discrepancy',attemptId:'a',actionId:'a',reasonCode:'IDENTITY_CONFLICT',level:'warn'};
  const fact={kind:'attempt.outcome',attemptId:'a',invocationKind:'controller',attemptOrdinal:1,terminal:'completed',effect:'confirmed'};
  assert.match(formatExecution(event,'compact',fact),/Outcome discrepancy · reported terminal=completed · reported effect=confirmed/);
  assert.match(formatExecution({...event,eventName:'attempt.late_outcome',level:'info'},'compact',{...fact,late:true}),/Late outcome recorded.*late report/);
  assert.match(formatExecution({...event,eventName:'controller.invalid_proposal',reasonCode:'INVALID_PROPOSAL'},'compact',
    {...fact,kind:'controller.invalid_proposal',invalidPath:'/additions/0/profileId',expected:'a non-empty string'}),/\/additions\/0\/profileId expected a non-empty string/);
});


test('C15R.3 summary distinguishes attempts, distinct actions, dispatch and charged budget',()=>{
  const usage={inputTokens:null,outputTokens:null,cost:null};
  const state={operationId:'op',status:'finished',assessment:{overall:'partial',unresolvedQuestions:['q']},limits:{maxInvocations:5},events:[],
    attempts:[{attemptId:'a',actionId:'a',status:'terminal',dispatchedAt:1,dispatchCertainty:'sent',outcome:{terminal:'completed',effect:'none',usage}},
      {attemptId:'b1',actionId:'b',status:'terminal',dispatchedAt:2,dispatchCertainty:'unknown',outcome:{terminal:'unknown',effect:'unknown',usage}},
      {attemptId:'b2',actionId:'b',status:'terminal',dispatchCertainty:'not_sent',outcome:{terminal:'cancelled',effect:'none',usage}}]};
  const compact=formatOperation(state,'compact'),detail=formatOperation(state,'detailed');
  assert.match(compact,/Operation partial/);assert.match(compact,/1 Controller attempt · 2 Worker attempts \(1 distinct Action\)/);
  assert.match(compact,/Unknown effects\/outcomes remain/);assert.match(detail,/dispatch records 2\/3 · budget charged 2\/5/);
  assert.doesNotMatch(compact,/invocations 3/);
});

test('A116 native Controller plan remains opaque across modes and attempts, never constructed from text',()=>{
  const entries=[{content:'Model-authored **step**',priority:'high',status:'in_progress'},
    {content:'Retry when model decides',priority:'low',status:'pending'}];
  const plan=native('plan',{sessionUpdate:'plan',entries,_meta:{providerTrace:'kept'}},
    {attemptId:'controller-1',invocationKind:'controller',nativeKind:'plan'});
  const retry={...plan,attemptId:'controller-2',sequence:7};
  for(const mode of ['compact','detailed','debug']){
    const first=acpActivity(plan,mode,true), second=acpActivity(retry,mode,true);
    assert.deepEqual(first.entries,entries);
    assert.deepEqual(second.entries,entries);
    assert.equal(first._meta.providerTrace,'kept');
    assert.equal(first._meta.roleOrchestratorSource.attemptId,'controller-1');
    assert.equal(second._meta.roleOrchestratorSource.attemptId,'controller-2');
    assert.equal(acpActivity(plan,mode,false),undefined);
    assert.equal(acpActivity({...plan,kind:'reasoning',payload:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'## Plan'}}},mode,true),undefined);
    assert.equal(acpActivity({...plan,payload:{sessionUpdate:'plan',entries:[]}},mode,true).entries.length,0);
    assert.equal(acpActivity({...plan,payload:{sessionUpdate:'plan'}},mode,true).entries,undefined);
  }
  assert.deepEqual(plan.payload.entries,entries);
});

test('A117 factual compact ACP source, outcome, invalid proposal and independent attempts',()=>{
  const base={schemaVersion:1,operationId:'op',eventId:'event-1',sequence:2,receivedAt:1,
    component:'core',level:'info',reasonCode:'DISPATCH_STARTED',eventName:'attempt.dispatched'};
  const fact={journalEventId:'event-1',kind:'attempt.dispatched',attemptId:'a',actionId:'a',attemptOrdinal:2,
    invocationKind:'delegate',roleId:'arbitrary-role',profileId:'profile-one',objective:'Review the actual repository',
    modelSelector:'requested-model',reasoning:{mode:'selectable',level:'high'}};
  const text=formatAcpExecution(base,'compact',fact);
  assert.match(text,/arbitrary-role #2 · profile-one/);
  assert.match(text,/Dispatched · Review the actual repository/);
  assert.doesNotMatch(text,/DISPATCH_STARTED|requested-model|event-1/);
  assert.match(formatAcpExecution(base,'detailed',fact),/selected model=requested-model.*selected effort=high/);
  const rendered=acpExecutionInline(base,[],'compact',fact);
  assert.equal(rendered.length,1);
  assert.equal(rendered[0]._meta.roleOrchestratorSource.roleId,'arbitrary-role');
  assert.equal(rendered[0]._meta.roleOrchestratorSource.attemptOrdinal,2);
  assert.equal(rendered[0]._meta.roleOrchestratorSource.profileId,'profile-one');
  assert.equal(rendered[0]._meta.roleOrchestratorSource.invocationKind,'delegate');
  assert.equal(rendered[0]._meta.roleOrchestratorSource.source,'journal');
  assert.equal(formatAcpExecution({...base,eventName:'operation.accepted'},'compact'),undefined);
  assert.equal(formatAcpExecution({...base,eventName:'interaction.resolved'},'compact'),undefined);
  const second={...fact,journalEventId:'event-2',attemptId:'b',attemptOrdinal:3};
  assert.notEqual(acpExecutionInline({...base,eventId:'event-2'},[],'compact',second)[0].messageId,rendered[0].messageId);
  assert.match(formatAcpExecution({...base,eventName:'attempt.outcome',reasonCode:'COMPLETED'},'compact',
    {...fact,terminal:'completed',effect:'unknown'}),/Attempt outcome reported · terminal=completed · effect=unknown/);
  assert.match(formatAcpExecution({...base,eventName:'attempt.late_outcome',level:'warn'},'compact',
    {...fact,terminal:'unknown',effect:'unknown',late:true}),/Late outcome report/);
  assert.match(formatAcpExecution({...base,eventName:'controller.invalid_proposal',level:'warn'},'compact',
    {...fact,invalidPath:'$.actions[0].profile',expected:'known profile'}),/Invalid model proposal.*known profile/);
  assert.match(formatAcpExecution({...base,eventName:'operation.finished'},'compact',
    {kind:'operation.finished',assessmentOverall:'complete'}),/Model assessment recorded · overall=complete/);
  assert.match(formatAcpExecution({...base,eventName:'attempt.outcome_discrepancy',level:'warn'},'compact',
    {...fact,terminal:'completed',effect:'unknown'}),/Outcome discrepancy/);
  assert.match(formatAcpExecution({...base,eventName:'attempt.historical_outcome_report'},'compact',
    {...fact,terminal:'unknown',effect:'unknown'}),/classification not recorded/);
  assert.match(acpExecutionNotices(base,[],'compact',fact)[0].title,/Dispatched/);
  assert.ok(acpExecutionInline(base,[],'debug',fact)[0].content.text.includes('event-1'));
});

test('A118/A119 RO-owned escaped finding displays only recorded claims, no semantic verdict',()=>{
  const finding={findingId:'f-1',author:'profile-not-role',claim:'### forged\\n<script>alert(1)</script> **bold** [link](https://example.test)',
    subject:'src/file.js',supports:['obs:1'],uncertainties:['Not established'],supersedes:'f-old'};
  const event={schemaVersion:1,operationId:'op',eventId:'commit-f',eventName:'attempt.outcome',sequence:1,
    receivedAt:1,level:'info',reasonCode:'OUTCOME_RECORDED'};
  const own=acpExecutionInline(event,[finding],'compact',{kind:'attempt.outcome',journalEventId:'commit-f'});
  const msg=own.find(x=>x._meta.roleOrchestratorSource.findingId==='f-1');
  assert.ok(msg);
  assert.match(msg.content.text,/Finding · profile-not-role/);
  assert.match(msg.content.text,/Not established/);
  assert.match(msg.content.text,/obs:1/);
  assert.doesNotMatch(msg.content.text,/verified|confidence|severity|Reviewer role/i);
  assert.equal(msg._meta.roleOrchestratorSource.author,'profile-not-role');
  assert.equal(msg._meta.roleOrchestratorSource.eventId,'commit-f');
  assert.ok(!msg.content.text.includes('<script>'));
  assert.ok(!msg.content.text.includes('[link]('));
  assert.match(acpFindingText(finding,'debug'),/id=f-1/);
  assert.equal(acpExecutionNotices(event,[finding],'compact')[0].severity,'info');
  const notices=acpExecutionNotices(event,[finding],'compact');
  assert.equal(notices.find(x=>x._meta.roleOrchestratorSource.findingId==='f-1').title,'Finding · profile-not-role');
  assert.ok(notices.find(x=>x._meta.roleOrchestratorSource.findingId==='f-1').description.includes('Uncertainties: Not established'));
  const unchanged={...finding,uncertainties:[]};
  assert.doesNotMatch(acpFindingText(unchanged,'compact'),/verified|confirmed/);
});

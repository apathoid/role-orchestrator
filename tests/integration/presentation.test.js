import assert from 'node:assert/strict';
import { test } from 'node:test';
import { acpActivity, formatActivity, formatExecution, formatRecordedFindings, scopedNativeId, terminalText } from '../../src/hosts/presentation.js';

const native = (kind, payload, extra = {}) => ({kind,payload, operationId:'op',attemptId:'a',profileId:'reviewer',providerId:'provider',sequence:1,source:'provider_activity',...extra});
test('presentation preserves actual chunks and distinguishes tool, finding, lifecycle and gaps', () => {
  const thought = native('reasoning',{sessionUpdate:'agent_thought_chunk',content:{type:'text',text:'hello\x1b[2J\x1b]52;c;secret\x07\nworld'}},{nativeKind:'agent_thought_chunk'});
  assert.equal(formatActivity(thought,'compact'),'[reviewer/a] Thinking: hello\nworld');
  assert.equal(thought.payload.content.text.includes('\x1b'),true);
  assert.equal(terminalText('a\r\x00b'),'ab');
  const tool = native('tool',{sessionUpdate:'tool_call',toolCallId:'t',title:'Read',status:'in_progress'});
  assert.equal(formatActivity(tool,'compact'),undefined);
  assert.equal(formatActivity(tool,'detailed'),'[reviewer/a] Tool Read · in_progress');
  assert.equal(formatActivity(native('finding',{claim:'A model claim'}),'compact'),'[reviewer/a] Reported finding: A model claim');
  assert.equal(formatActivity({kind:'gap',operationId:'op',droppedCount:5,reason:'overflow'},'compact'),'[Activity gap] 5 notices dropped');
  assert.equal(formatExecution({eventName:'attempt.dispatched',attemptId:'a',actionId:'a',reasonCode:'DISPATCH_STARTED'},'compact'),
    '[Controller a] attempt.dispatched · DISPATCH_STARTED');
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
  assert.equal(acpActivity(plan,'compact',true),undefined);
  assert.deepEqual(acpActivity(plan,'detailed',true).entries,plan.payload.entries);
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

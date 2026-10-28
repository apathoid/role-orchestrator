import assert from 'node:assert/strict';
import {captureAcpSessionUpdate} from '../src/providers/acp/notification-state.mjs';
import {parseStructuredStateOrText} from '../src/structured-output.mjs';
import {emptyTaskSpec} from '../src/routing/task-spec.mjs';

const response=JSON.stringify({mode:'change',writeIntent:'explicit',complexity:'medium',risk:'normal',reason:'fixture',
  task:{...emptyTaskSpec('change','explicit'),target:{kind:'git',selector:{type:'recent_commits',count:6}}}});
const final=(text,phase='final_answer')=>({sessionUpdate:'agent_message_chunk',content:{type:'text',text},_meta:{codex:{phase}}});
const thought=text=>({sessionUpdate:'agent_thought_chunk',content:{type:'text',text}});
const state=()=>({notificationsReceived:0,finalChunksReceived:0,finalText:'',unphasedText:'',usage:null,toolEvents:[]});
const stream=updates=>{
  const s=state();
  for(const update of updates) captureAcpSessionUpdate(s,update,{phaseOf:e=>e?._meta?.codex?.phase??null});
  return {state:s,parsed:parseStructuredStateOrText(s,'routing')};
};
const mid=Math.floor(response.length/3);
const valid=stream([thought('reasoning {secret}'),final('Preview {"mode":"review"}','commentary'),
  final(response.slice(0,mid)),final(response.slice(mid,mid*2)),final(response.slice(mid*2))]);
assert.equal(valid.parsed.format,'structured');
assert.equal(valid.parsed.data.task.target.selector.count,6);
assert.equal(valid.state.finalChunksReceived,3);
assert.equal(valid.state.unphasedText,'');
assert.equal(stream([final('Thinking...','commentary'),final(response)]).parsed.format,'structured');
assert.equal(stream([final('prefix {"mode":"review"}','commentary'),final(response)]).parsed.format,'structured');
assert.equal(stream([final(response,'unknown')]).parsed.format,'structured');
assert.equal(stream([final(response,'unknown'),final('discardable commentary','commentary'),final(response)]).parsed.format,'structured');
assert.equal(stream([final(response.slice(0,mid))]).parsed.diagnostics.code,'ROUTER_OUTPUT_INCOMPLETE');
assert.equal(stream([thought('reasoning'),final('plain answer','commentary')]).parsed.diagnostics.code,'ROUTER_OUTPUT_UNSTRUCTURED');
assert.equal(stream([final('{oops}')]).parsed.diagnostics.code,'ROUTER_OUTPUT_MALFORMED');
assert.equal(stream([final(response),final(response)]).parsed.diagnostics.code,'ROUTER_OUTPUT_AMBIGUOUS');
const noFinal=stream([thought('private reasoning')]);
assert.equal(noFinal.parsed.diagnostics.code,'ROUTER_OUTPUT_UNSTRUCTURED');
// These events never carry execution permission; cancellation/timeouts/crashes
// are provider failures at the invocation boundary, not a replacement JSON.
for(const stopReason of ['cancelled','timeout','crash']){
  const incomplete=stream([final(response.slice(0,mid)),thought(stopReason)]);
  assert.notEqual(incomplete.parsed.format,'structured');
}
console.log('acp-router-response: PASS (chunks, phases, commentary, absent final, ambiguous, incomplete)');

import assert from 'node:assert/strict';
import {
  agentMessageChunk,
  agentThoughtChunk,
  sanitizeToolUpdateForUi,
  userFacingRoleUpdate,
} from '../src/acp-presentation.mjs';

assert.deepEqual(agentThoughtChunk('П'), {
  sessionUpdate: 'agent_thought_chunk',
  content: { type: 'text', text: 'П' },
});
assert.deepEqual(agentMessageChunk('foo '), {
  sessionUpdate: 'agent_message_chunk',
  content: { type: 'text', text: 'foo ' },
});
assert.equal(
  [agentThoughtChunk('П'), agentThoughtChunk('ровер'), agentThoughtChunk('яю')]
    .map((update) => update.content.text)
    .join(''),
  'Проверяю',
);

// Codex commentary is progress telemetry, never final-answer text.
for (const role of ['router', 'explorer', 'investigator', 'coderMedium', 'reviewerHigh', 'responderMedium']) {
  assert.equal(userFacingRoleUpdate({ type: 'role_commentary_chunk', role, text: 'Проверю файлы…' }), null);
}
assert.deepEqual(userFacingRoleUpdate({ type: 'role_thought_chunk', role: 'investigator', text: 'Inspecting ' }), agentThoughtChunk('Inspecting '));
assert.equal(userFacingRoleUpdate({ type: 'role_thought_chunk', text: '' }), null);
const finalNative = {
  sessionUpdate: 'agent_message_chunk',
  content: { type: 'text', text: '# Result\n\n**Complete.**' },
  _meta: { codex: { phase: 'final_answer' } },
};
assert.equal(userFacingRoleUpdate({ type: 'role_native_update', role: 'investigator', update: finalNative }), finalNative);
assert.equal(userFacingRoleUpdate({ type: 'role_native_update', role: 'responderHigh', update: finalNative }), finalNative);
assert.deepEqual(userFacingRoleUpdate({
  type: 'role_native_update',
  update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'provider-normalized answer' } },
}), { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'provider-normalized answer' } }, 'presentation trusts normalized provider data-plane updates');
for (const update of [
  { sessionUpdate: 'agent_message_chunk', content: { type: 'image', mimeType: 'image/png', data: 'YQ==' } },
  { sessionUpdate: 'agent_message_chunk', content: { type: 'resource_link', uri: 'file:///readme.md', name: 'readme' } },
  { sessionUpdate: 'tool_call_update', toolCallId: 'file-1', status: 'completed' },
]) {
  assert.equal(userFacingRoleUpdate({ type: 'role_native_update', update }), update, 'native media/tool updates preserved');
}
assert.equal(userFacingRoleUpdate({ type: 'role_start', role: 'investigator' }), null);

const toolKinds = new Map();
const executeStart = sanitizeToolUpdateForUi({
  sessionUpdate: 'tool_call',
  toolCallId: 'exec-1',
  kind: 'execute',
  status: 'in_progress',
  title: 'Analyze architecture and docs',
  rawInput: { command: 'npm run analyze' },
}, { toolKinds });
assert.equal(executeStart, null);

const executeDone = sanitizeToolUpdateForUi({
  sessionUpdate: 'tool_call_update',
  toolCallId: 'exec-1',
  status: 'completed',
  content: [
    { type: 'content', content: { type: 'text', text: 'very verbose report' } },
    { type: 'diff', path: '/repo/a.ts', oldText: 'a\n', newText: 'b\n' },
  ],
  rawOutput: { stdout: 'very verbose report', exitCode: 0 },
}, { toolKinds });
assert.equal(executeDone, null);

// Command cards can be restored explicitly. In that mode successful command
// output is still hidden by default while the card/status remains visible.
const visibleToolKinds = new Map();
const visibleExecuteStart = sanitizeToolUpdateForUi({
  sessionUpdate: 'tool_call',
  toolCallId: 'exec-visible',
  kind: 'execute',
  status: 'in_progress',
  title: 'Analyze architecture and docs',
  rawInput: { command: 'npm run analyze' },
}, { toolKinds: visibleToolKinds, showCommandToolCalls: true });
assert.equal(visibleExecuteStart.title, 'Analyze architecture and docs');
const visibleExecuteDone = sanitizeToolUpdateForUi({
  sessionUpdate: 'tool_call_update',
  toolCallId: 'exec-visible',
  status: 'completed',
  content: [
    { type: 'content', content: { type: 'text', text: 'very verbose report' } },
  ],
  rawOutput: { stdout: 'very verbose report', exitCode: 0 },
}, { toolKinds: visibleToolKinds, showCommandToolCalls: true });
assert.deepEqual(visibleExecuteDone.content, []);
assert.equal('rawOutput' in visibleExecuteDone, false);

const failedExecute = sanitizeToolUpdateForUi({
  sessionUpdate: 'tool_call_update',
  toolCallId: 'exec-visible',
  status: 'failed',
  content: [{ type: 'content', content: { type: 'text', text: 'failure details' } }],
  rawOutput: { stderr: 'failure details', exitCode: 1 },
}, { toolKinds: visibleToolKinds, showCommandToolCalls: true });
assert.equal(failedExecute.content[0].content.text, 'failure details');
assert.equal(failedExecute.rawOutput.stderr, 'failure details');

const editDone = sanitizeToolUpdateForUi({
  sessionUpdate: 'tool_call_update',
  toolCallId: 'edit-1',
  kind: 'edit',
  status: 'completed',
  content: [{ type: 'diff', path: '/repo/a.ts', oldText: 'a\n', newText: 'b\n' }],
}, { toolKinds });
assert.equal(editDone.content[0].type, 'diff');

console.log('acp-presentation: passed');

// Exercise the actual smoke-test ACP subprocess (without substituting a mock
// for the production SDK). In addition to the schema check, this catches
// fixture drift that would silently prevent a legitimate Change smoke run.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateTaskSpec } from '../src/routing/task-spec.mjs';
import { validateRouteConsistency } from '../src/routing/consistency.mjs';

const fake = fileURLToPath(new URL('./fake-codex-acp.mjs', import.meta.url));
const child = spawn(process.execPath, [fake], { cwd: join(fileURLToPath(new URL('..', import.meta.url))),
  stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, FAKE_CODEX_LOG: '' } });
const pending = new Map();
const updates = [];
let sequence = 0;
let errorText = '';
child.stderr.setEncoding('utf8');
child.stderr.on('data', text => { errorText += text; });
child.on('error', error => { for (const p of pending.values()) p.reject(error); pending.clear(); });
child.on('exit', code => {
  if (pending.size) {
    for (const p of pending.values()) p.reject(new Error(`fixture process exited ${code}: ${errorText}`));
    pending.clear();
  }
});
const lines = createInterface({ input: child.stdout });
lines.on('line', line => {
  const item = JSON.parse(line);
  if (item.method === 'session/update') updates.push(item.params?.update);
  if (item.id !== undefined && pending.has(item.id)) {
    const p = pending.get(item.id);
    pending.delete(item.id);
    if (item.error) p.reject(new Error(JSON.stringify(item.error)));
    else p.resolve(item.result);
  }
});
async function request(method, params) {
  const id = ++sequence;
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 5000);
    pending.set(id, {
      resolve: result => { clearTimeout(timer); resolve(result); },
      reject: error => { clearTimeout(timer); reject(error); },
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
async function route(task) {
  const { sessionId } = await request('session/new', { cwd: process.cwd(), mcpServers: [] });
  const start = updates.length;
  await request('session/prompt', { sessionId, prompt: [{ type: 'text', text: `ORCHESTRATOR ROLE: router\nUSER TASK:\n${task}` }] });
  const finals = updates.slice(start).filter(item => item?.sessionUpdate === 'agent_message_chunk' && item?._meta?.codex?.phase === 'final_answer');
  assert.equal(finals.length, 1, `expected exactly one final Router response for ${task}`);
  return finals[0].content.text;
}
try {
  await request('initialize', { protocolVersion: 1, clientCapabilities: {} });
  for (const [task, operation, writeIntent] of [
    ['Change the greeting.', 'change', 'explicit'],
    ['NEEDS_FIX Change the greeting.', 'change', 'explicit'],
    ['HIGH_RISK Change the greeting.', 'change', 'explicit'],
    ['REVIEW_FINDING Review my code.', 'review', 'not_requested'],
    ['INVESTIGATE_ONLY Explain the greeting implementation.', 'investigate', 'not_requested'],
  ]) {
    const output = JSON.parse(await route(task));
    assert.equal(output.mode, operation);
    assert.equal(output.writeIntent, writeIntent);
    assert.equal(output.task.operation, operation);
    assert.equal(output.task.writeIntent, writeIntent);
    validateTaskSpec(output.task);
    assert.equal(validateRouteConsistency(output, { taskSpec: output.task }).status, 'accepted');
  }
  const commit = 'a'.repeat(40);
  const specific = JSON.parse(await route(`Review commit ${commit}.\nREVIEW_FINDING`));
  assert.deepEqual(specific.task.target, { kind: 'git', selector: { type: 'commit', ref: commit } });
  validateTaskSpec(specific.task);
  const malformed = await route('MALFORMED_ROUTER Explain the greeting implementation.');
  assert.throws(() => JSON.parse(malformed));
  console.log('fake-router-contract: PASS (Change, Review, Investigate, commit target, malformed output)');
} finally {
  child.stdin.end();
  child.kill();
}

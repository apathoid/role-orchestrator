import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCodexProvider } from '../../../../src/main/index.js';
import { setup } from '../../fixtures/application.js';
import { request } from '../../fixtures/core.js';

const linux = { skip: process.platform !== 'linux', timeout: 12_000 };
const profile = { profileId: 'primary', providerId: 'codex', model: 'fixture-model' };

function codexSetup(body) {
  const source = `
    import assert from 'node:assert/strict';
    import { readFileSync } from 'node:fs';
    const prompt = readFileSync(0, 'utf8');
    const separator = ${JSON.stringify('\n\nInvocation (JSON):\n')};
    const boundary = prompt.indexOf(separator);
    assert.notEqual(boundary, -1);
    const invocation = JSON.parse(prompt.slice(boundary + separator.length));
    const host = invocation.context.find(item => item.ref === 'host:invocation-context')?.value;
    const emit = (type, fields = {}) => console.log(JSON.stringify({type, ...fields}));
    const message = (text, id = 'msg') => emit('item.completed', {item: {type: 'agent_message', id, text}});
    const decision = (fields = {}) => ({schemaVersion: 1, decisionId: invocation.attemptId + '-decision',
      operationId: invocation.operationId, contextCursor: host.contextCursor, additions: [], cancellations: [], ...fields});
    const assessment = (fields = {}) => ({author: invocation.profileId, overall: 'partial', requirements: [],
      observationRefs: [], findingRefs: [], unresolvedQuestions: [], answer: 'Partial result', ...fields});
    const complete = () => emit('turn.completed', {usage: {input_tokens: 12, output_tokens: 0}});
    emit('thread.started', {thread_id: 'fixture-thread'});
    emit('turn.started');
    ${body}
  `;
  const provider = createCodexProvider({
    providerId: profile.providerId,
    configuration: { adapter: 'codex-cli', launch: { command: process.execPath, args: ['--input-type=module', '-e', source, '--'] } },
  });
  return { provider, ...setup({ profile, provider }) };
}

test('Codex Controller delegates to a real child Worker and uses separate model, tool and agent facts', linux, async () => {
  const task = '  Проверь 🧪\n';
  const { api } = codexSetup(`
    assert.equal(invocation.profileId, 'primary');
    assert.ok(!Object.hasOwn(invocation, 'authorityRef'));
    assert.deepEqual(invocation.userConstraints, ['Keep the original task']);
    if (invocation.kind === 'delegate') {
      assert.equal(invocation.expectedResult, 'Report command outcome');
      emit('item.completed', {item: {type: 'command_execution', id: 'command-1',
        command: 'npm test', aggregated_output: 'fixture failed', status: 'failed', exit_code: 9}});
      message('Build failed');
    } else if (host.outcomes.length === 0) {
      assert.equal(invocation.objective, ${JSON.stringify(task)});
      assert.ok(prompt.startsWith('Return exactly one JSON object'));
      message('I will delegate.', 'progress');
      message(JSON.stringify(decision({
        additions: [{actionId: 'worker', kind: 'delegate', objective: 'Run check', profileId: 'primary',
          contextRefs: [], dependsOn: [], expectedResult: 'Report command outcome'}],
        waitPolicy: {kind: 'all_requested', targets: [{kind: 'action', id: 'worker'}]},
      })));
    } else {
      const tool = invocation.context.find(item => item.provenance?.exit?.kind === 'tool_exit');
      assert.equal(tool.provenance.exit.code, 9);
      assert.ok(invocation.context.some(item => item.value === 'Build failed' && item.source === 'model_claim'));
      message(JSON.stringify(decision({finalAssessment: assessment({answer: 'The check failed', observationRefs: [tool.ref]})})));
    }
    complete();
  `);
  const state = await (await api.submit(request({ text: task, userConstraints: ['Keep the original task'] }))).completion;
  assert.equal(state.status, 'finished');
  assert.equal(state.assessment.overall, 'partial');
  assert.equal(state.assessment.answer, 'The check failed');
  assert.equal(state.attempts.length, 3);
  const worker = state.events.find(event => event.kind === 'attempt.outcome' &&
    state.attempts.find(attempt => attempt.attemptId === event.outcome.attemptId)?.actionId === 'worker');
  assert.equal(worker.outcome.terminal, 'completed');
  assert.equal(worker.outcome.effect, 'unknown');
  assert.deepEqual(worker.outcome.usage, { inputTokens: 12, outputTokens: 0, cost: null });
  assert.deepEqual(worker.observations.filter(item => item.provenance?.exit).map(item =>
    [item.source, item.provenance.exit.kind, item.provenance.exit.code]), [
    ['provider_reported', 'tool_exit', 9], ['host_observed', 'agent_exit', 0],
  ]);
  assert.deepEqual(state.assessment.observationRefs, [worker.observations.find(item => item.provenance?.exit?.kind === 'tool_exit').ref]);
});

test('Worker can return structured text without implicit Decision parsing', linux, async () => {
  const { provider } = codexSetup(`
    assert.equal(invocation.kind, 'delegate');
    message('{"result":"failed"}');
    complete();
  `);
  const signal = new AbortController().signal;
  const session = await provider.open(profile, signal);
  try {
    const result = await provider.invoke(session, {
      attemptId: 'worker-attempt', operationId: 'worker-operation', actionId: 'worker-action',
      kind: 'delegate', objective: 'Report in JSON', profile, instructions: [], context: [],
      userConstraints: [], authorityRef: 'fixture-authority', timeoutMs: 3_000, signal,
    }, item => item.ref);
    assert.equal(result.output, '{"result":"failed"}');
    assert.equal(result.outcome.terminal, 'completed');
    assert.equal(result.outcome.effect, 'unknown');
  } finally {
    await provider.close(session);
  }
});

test('malformed Controller JSON and invalid Decision reach the existing correction path', linux, async () => {
  const { api } = codexSetup(`
    const correction = invocation.context.find(item => item.ref === 'host:decision-error');
    if (!correction) {
      const answer = JSON.stringify(decision({finalAssessment: assessment()}));
      message('~~~json' + String.fromCharCode(10) + answer + String.fromCharCode(10) + '~~~');
    } else if (correction.value.path === '$') {
      message(JSON.stringify(decision({schemaVersion: 2, finalAssessment: assessment()})));
    } else {
      assert.equal(correction.value.path, '$.schemaVersion');
      message(JSON.stringify(decision({finalAssessment: assessment()})));
    }
    complete();
  `);
  const state = await (await api.submit(request())).completion;
  assert.equal(state.status, 'finished');
  assert.equal(state.attempts.length, 3);
  assert.equal(state.events.filter(event => event.kind === 'controller.responded').length, 1);
  assert.equal(state.assessment.answer, 'Partial result');
});

for (const [label, end, code, exit] of [
  ['nonzero exit after a complete turn', "complete(); process.stderr.write('transport lost'); process.exitCode = 17;", 'PROVIDER_DISCONNECTED', 17],
  ['zero exit with turn.failed', "emit('turn.failed', {error: {message: 'model turn failed'}});", 'PROVIDER_DISCONNECTED', 0],
  ['zero exit with an incomplete frame', "process.stdout.write('{\"type\":');", 'PROTOCOL_ERROR', 0],
  ['zero exit with a malformed later message', "message(12, 'bad'); complete();", 'PROTOCOL_ERROR', 0],
]) {
  test('partial output stays evidence on ' + label, linux, async () => {
    const { api } = codexSetup(`
      message(JSON.stringify(decision({finalAssessment: assessment({overall: 'complete', answer: 'Premature claim'})})));
      ${end}
    `);
    const state = await (await api.submit(request())).completion;
    assert.equal(state.status, 'waiting');
    assert.equal(state.waiting.reason.code, code);
    assert.equal(state.assessment, undefined);
    assert.equal(state.events.some(event => event.kind === 'controller.responded'), false);
    assert.equal(state.attempts.length, 1);
    assert.equal(state.attempts[0].dispatchCertainty, 'sent');
    assert.equal(state.attempts[0].outcome.effect, 'unknown');
    assert.equal(state.attempts[0].outcome.terminal, label.includes('turn.failed') ? 'failed' : 'unknown');
    const { observations } = state.events.find(event => event.kind === 'attempt.outcome');
    assert.ok(observations.some(item => item.source === 'model_claim' && item.value.includes('Premature claim')));
    assert.equal(observations.find(item => item.provenance?.exit?.kind === 'agent_exit').provenance.exit.code, exit);
    const stdout = observations.find(item => item.providerRef === 'codex-stdout');
    assert.ok(stdout.value.text.includes('Premature claim'));
    if (label.includes('incomplete')) assert.equal(stdout.completeness, 'truncated');
    if (exit === 17) assert.equal(observations.find(item => item.providerRef === 'codex-stderr').value.text, 'transport lost');
  });
}

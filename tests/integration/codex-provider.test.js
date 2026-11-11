import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeSnapshot, encodeSnapshot } from '../../src/core/snapshot.js';
import { createCodexProvider } from '../../src/main/index.js';
import { setup } from '../fixtures/application.js';
import { request } from '../fixtures/core.js';

const linux = { skip: process.platform !== 'linux', timeout: 12_000 };
const profile = { profileId: 'primary', providerId: 'codex', model: 'fixture-model' };

function codexSetup(body, { nativeSettings, ...options } = {}) {
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
    configuration: { adapter: 'codex-cli', launch: { command: process.execPath, args: ['--input-type=module', '-e', source, '--'] }, nativeSettings },
  });
  return { provider, ...setup({ profile, provider, ...options }) };
}

test('Codex Controller delegates to a real child Worker and uses separate model, tool and agent facts', linux, async () => {
  const task = '  Проверь 🧪\n';
  const { api } = codexSetup(`
    assert.equal(invocation.profileId, 'primary');
    assert.ok(!Object.hasOwn(invocation, 'authorityRef'));
    assert.deepEqual(invocation.userConstraints, ['Keep the original task']);
    if (invocation.kind === 'delegate') {
      assert.equal(invocation.expectedResult, 'Report command outcome');
      assert.deepEqual(invocation.skillInstructions, [{id:'checks',version:'v1',status:'complete',instructions:'Selected CLI skill'}]);
      assert.ok(!invocation.instructions.includes('Selected CLI skill'));
      emit('item.completed', {item: {type: 'command_execution', id: 'command-1',
        command: 'npm test', aggregated_output: 'fixture failed', status: 'failed', exit_code: 9}});
      message('Build failed');
    } else if (host.outcomes.length === 0) {
      assert.equal(invocation.objective, ${JSON.stringify(task)});
      assert.ok(prompt.startsWith('Return exactly one JSON object'));
      assert.ok(!Object.hasOwn(invocation,'skillInstructions'));
      assert.ok(!Object.hasOwn(host.catalog.find(item => item.kind === 'skill').value,'instructions'));
      message('I will delegate.', 'progress');
      message(JSON.stringify(decision({
        additions: [{actionId: 'worker', kind: 'delegate', objective: 'Run check', profileId: 'primary',
          contextRefs: [], dependsOn: [], skills:['checks'], expectedResult: 'Report command outcome'}],
        waitPolicy: {kind: 'all_requested', targets: [{kind: 'action', id: 'worker'}]},
      })));
    } else {
      const tool = invocation.context.find(item => item.provenance?.exit?.kind === 'tool_exit');
      assert.equal(tool.provenance.exit.code, 9);
      assert.equal(invocation.context.filter(item => item.value === 'Build failed' && item.source === 'model_claim').length, 1);
      assert.ok(!invocation.context.some(item => item.ref.startsWith('attempt-output:')));
      message(JSON.stringify(decision({finalAssessment: assessment({answer: 'The check failed', observationRefs: [tool.ref]})})));
    }
    complete();
  `, {extraCatalog:[{kind:'skill',value:{id:'checks',version:'v1',instructions:'Selected CLI skill'}}]});
  const state = await (await api.submit(request({ text: task, userConstraints: ['Keep the original task'] }))).completion;
  assert.equal(state.status, 'finished');
  assert.equal(state.assessment.overall, 'partial');
  assert.equal(state.assessment.answer, 'The check failed');
  assert.equal(state.attempts.length, 3);
  const worker = state.events.find(event => event.kind === 'attempt.outcome' &&
    state.attempts.find(attempt => attempt.attemptId === event.outcome.attemptId)?.actionId === 'worker');
  assert.equal(worker.outcome.terminal, 'completed');
  assert.equal(worker.outcome.effect, 'unknown');
  assert.deepEqual(worker.outcome.diagnostics, []);
  assert.deepEqual(worker.outcome.usage, { inputTokens: 12, outputTokens: 0, cost: null });
  assert.deepEqual(worker.observations.filter(item => item.provenance?.exit).map(item =>
    [item.source, item.provenance.exit.kind, item.provenance.exit.code]), [
    ['provider_reported', 'tool_exit', 9], ['host_observed', 'agent_exit', 0],
  ]);
  assert.deepEqual(state.assessment.observationRefs, [worker.observations.find(item => item.provenance?.exit?.kind === 'tool_exit').ref]);
  assert.equal(worker.observations.filter(item => item.value === 'Build failed').length, 1);
  assert.equal(worker.observations.filter(item => item.ref.startsWith('attempt-output:')).length, 0);
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


test('Codex describes headless capability limits and rejects a required approval or tool bridge before launch', async () => {
  const provider = createCodexProvider({ providerId: 'codex', configuration: { adapter: 'codex-cli' } });
  const first = await provider.describe();
  assert.equal(first.capabilities['permissions.interactive'].support, 'unsupported');
  assert.equal(first.capabilities['tools.bridge'].source, 'configured');
  assert.equal(first.capabilities['context.retrieval'].support, 'unsupported');
  assert.equal(first.capabilities['tools.visibility'].support, 'unknown');
  assert.equal(first.capabilities['attempt.status'].support, 'unsupported');
  first.capabilities['permissions.interactive'].support = 'supported';
  assert.equal((await provider.describe()).capabilities['permissions.interactive'].support, 'unsupported');

  const signal = new AbortController().signal;
  const session = await provider.open(profile, signal);
  const observations = [];
  let permissionRequests = 0;
  try {
    const result = await provider.invoke(session, {
      attemptId: 'attempt', operationId: 'operation', actionId: 'action', kind: 'delegate',
      objective: 'Use a host approval', profile, instructions: [], userConstraints: [],
      context: [], authorityRef: 'test-grant', timeoutMs: 3000, signal,
      requiredCapabilities: ['permissions.interactive', 'tools.bridge'],
      permissions: { request() { permissionRequests++; return { kind: 'unavailable' }; } },
    }, item => { observations.push(item); return item.ref; });
    assert.equal(result.dispatchCertainty, 'not_sent');
    assert.equal(result.outcome.effect, 'none');
    assert.equal(permissionRequests, 0);
    assert.deepEqual(result.outcome.diagnostics, [{ code: 'CAPABILITY_UNAVAILABLE', ref: observations[0].ref }]);
    assert.deepEqual(observations[0].value.missing.map(item => [item.key, item.support]), [
      ['permissions.interactive', 'unsupported'], ['tools.bridge', 'unsupported'],
    ]);
    assert.match(observations[0].value.missing[0].detail, /headless.*interactive approval/);
  } finally {
    await provider.close(session);
  }
});

test('an unavailable approval requirement is observable to the Controller without launching a Worker', linux, async () => {
  const { api } = codexSetup(`
    assert.equal(invocation.kind, 'controller');
    if (host.outcomes.length === 0) {
      message(JSON.stringify(decision({
        additions: [{actionId: 'interactive', kind: 'delegate', objective: 'Use the approval channel',
          profileId: 'primary', contextRefs: [], dependsOn: [], expectedResult: 'Report',
          requiredCapabilities: ['permissions.interactive']}],
        waitPolicy: {kind: 'all_requested', targets: [{kind: 'action', id: 'interactive'}]},
      })));
    } else {
      const observation = invocation.context.find(item => item.ref.startsWith('host:capability:'));
      assert.equal(observation.value.missing[0].key, 'permissions.interactive');
      assert.match(observation.value.missing[0].detail, /headless.*interactive approval/);
      message(JSON.stringify(decision({finalAssessment: assessment({answer: 'Approval channel unavailable',
        observationRefs: [observation.ref]})})));
    }
    complete();
  `);
  const state = await (await api.submit(request())).completion;
  assert.equal(state.status, 'finished');
  assert.equal(state.assessment.answer, 'Approval channel unavailable');
  const worker = state.attempts.find(attempt => attempt.actionId === 'interactive');
  assert.equal(worker.dispatchCertainty, 'not_sent');
  assert.equal(worker.outcome.effect, 'none');
  assert.equal(worker.outcome.diagnostics[0].code, 'CAPABILITY_UNAVAILABLE');
  assert.equal(worker.outcome.diagnostics[0].ref, state.assessment.observationRefs[0]);
  assert.equal(state.events.some(event => event.kind === 'attempt.dispatched' && event.attemptId === worker.attemptId), false);
  assert.equal(decodeSnapshot(encodeSnapshot(state)).kind, 'accepted');
});

for (const declined of [false, true]) {
  test('the operator profile controls a Reviewer command with ' + (declined ? 'native denial' : 'standing native allowance'), linux, async () => {
    let permissionRequests = 0;
    const { api } = codexSetup(`
      assert.deepEqual(process.argv.slice(1), [
        'exec', '--json', '--skip-git-repo-check', '--model=fixture-model', '--profile=operator-profile', '-',
      ]);
      if (invocation.kind === 'delegate') {
        assert.deepEqual(invocation.instructions, ['Review and follow operator settings']);
        emit('item.completed', {item: {type: 'command_execution', id: 'check', command: 'git status',
          status: ${declined ? "'declined'" : "'completed'"}, exit_code: ${declined ? 'null' : '0'}}});
        message('Review result');
      } else if (host.outcomes.length === 0) {
        message(JSON.stringify(decision({
          additions: [{actionId: 'review', kind: 'delegate', objective: 'Review output', roleId: 'reviewer',
            profileId: 'primary', contextRefs: [], dependsOn: [], expectedResult: 'Report command outcome'}],
          waitPolicy: {kind: 'all_requested', targets: [{kind: 'action', id: 'review'}]},
        })));
      } else {
        message(JSON.stringify(decision({finalAssessment: assessment()})));
      }
      complete();
    `, {
      nativeSettings: { profile: 'operator-profile' },
      extraCatalog: [{ kind: 'role', value: { id: 'reviewer', instructions: 'Review and follow operator settings' } }],
      permissions: { bind: () => ({ close() {}, async request() { permissionRequests++; return { kind: 'denied' }; } }) },
    });
    const state = await (await api.submit(request())).completion;
    assert.equal(state.status, 'finished');
    assert.equal(state.attempts.length, 3);
    assert.equal(permissionRequests, 0);
    const worker = state.attempts.find(attempt => attempt.actionId === 'review');
    const report = state.events.find(event => event.kind === 'attempt.outcome' && event.outcome.attemptId === worker.attemptId);
    const tool = report.observations.find(item => item.provenance?.kind === 'provider_tool');
    assert.equal(worker.outcome.terminal, 'completed');
    assert.equal(worker.outcome.effect, 'unknown');
    assert.equal(tool.value.status, declined ? 'declined' : 'completed');
    assert.deepEqual(tool.provenance.exit, declined ? undefined : { kind: 'tool_exit', code: 0 });
    assert.deepEqual(worker.outcome.diagnostics, declined ? [{ code: 'PERMISSION_DENIED', ref: tool.ref }] : []);
  });
}

test('Codex preserves a non-fatal provider warning in a successful turn', linux, async () => {
  const warning = 'Model rerouted by provider';
  const { api } = codexSetup(`
    assert.match(prompt, /Context retrieval is unavailable/);
    emit('item.completed', {item: {type: 'error', id: 'native-warning', message: ${JSON.stringify(warning)}}});
    message(JSON.stringify(decision({finalAssessment: assessment({answer: 'Answer'})})));
    complete();
  `);
  const state = await (await api.submit(request())).completion;
  assert.equal(state.status, 'finished');
  assert.equal(state.assessment.answer, 'Answer');
  const receipt = state.events.find(event => event.kind === 'attempt.outcome');
  assert.equal(receipt.outcome.terminal, 'completed');
  assert.deepEqual(receipt.outcome.diagnostics, []);
  const restored = decodeSnapshot(encodeSnapshot(state));
  assert.equal(restored.kind, 'accepted');
  const persisted = restored.value.events.find(event => event.kind === 'attempt.outcome');
  const report = persisted.observations.find(item => item.provenance?.sourceId === 'native-warning');
  assert.equal(report?.source, 'provider_reported');
  assert.deepEqual(report.value, { type: 'error', message: warning });
  assert.ok(persisted.outcome.outputRefs.some(item => item.ref === report.ref));
});

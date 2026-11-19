import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setup, final } from '../fixtures/application.js';
import { request } from '../fixtures/core.js';

const hostOf = invocation => invocation.context.find(item => item.ref === 'host:invocation-context')?.value;
const userOf = (invocation, ref) => invocation.context.find(item => item.ref === ref);

test('C16.0 RED: A→B after finished retains initial objective and identifies latest accepted user turn', async () => {
  const seen = [];
  const { api, respondErrors } = setup({ maxInvocations: 3, respond(invocation) {
    seen.push(invocation);
    return final(invocation);
  } });
  try {
    const first = await (await api.submit(request({ text: 'Investigate the latest commit' }))).completion;
    assert.equal(first.status, 'finished');
    const second = await (await api.resume(first.operationId, {
      requestId: 'undo-redo-focus', text: 'Investigate an unrelated Undo/Redo focus defect',
    })).completion;
    assert.equal(second.status, 'finished', respondErrors.map(String).join('\n'));
    assert.equal(seen.length, 2);
    assert.equal(seen[1].objective, 'Investigate the latest commit');
    assert.equal(userOf(seen[1], 'request-1')?.value, 'Investigate the latest commit');
    assert.equal(userOf(seen[1], 'undo-redo-focus')?.value, 'Investigate an unrelated Undo/Redo focus defect');
    assert.deepEqual(hostOf(seen[1]).userTurns.initial, {
      ref: 'request-1', receivedSequence: { revision: 0, index: 0 },
    });
    assert.deepEqual(hostOf(seen[1]).userTurns.latest, {
      ref: 'undo-redo-focus', receivedSequence: userOf(seen[1], 'undo-redo-focus').receivedSequence,
    });
  } finally { await api.close(); }
});

test('C16.0 RED: after a question, a correlated new user turn stays a literal message, not a Host-classified answer', async () => {
  const seen = [];
  const { api } = setup({ maxInvocations: 3, respond(invocation) {
    seen.push(invocation);
    return seen.length === 1
      ? final(invocation, { finalAssessment: undefined, clarification: { question: 'Which branch?' } })
      : final(invocation);
  } });
  try {
    const first = await (await api.submit(request())).completion;
    assert.equal(first.status, 'waiting');
    const second = await (await api.resume(first.operationId, {
      requestId: 'changed-task', questionId: first.waiting.questionId,
      text: 'Do not inspect the branch. Investigate Undo/Redo focus instead.',
    })).completion;
    assert.equal(second.status, 'finished');
    assert.equal(userOf(seen[1], 'changed-task')?.provenance.kind, 'user');
    assert.equal(hostOf(seen[1]).userTurns.latest.ref, 'changed-task');
    assert.equal(hostOf(seen[1]).userTurns.initial.ref, 'request-1');
  } finally { await api.close(); }
});

test('C16.0 RED: five identical rejected Controller Decisions enter technical waiting without a sixth reservation', async () => {
  const { api, invocations } = setup({ maxInvocations: 15, respond(invocation) {
    const host = hostOf(invocation);
    if (invocations.length > 1) {
      const correction = invocation.context.find(item => item.ref === 'host:decision-error')?.value;
      assert.equal(correction.category, 'invalid_json');
      assert.equal(correction.attemptId, invocations.at(-2).attemptId);
      assert.equal(correction.totalRejected, invocations.length - 1);
      assert.equal(correction.consecutiveIdentical, invocations.length - 1);
      assert.equal(host.decisionRecovery.totalRejected, invocations.length - 1);
    }
    return { ...final(invocation), output: '{', decisionTextError: 'invalid_json' };
  } });
  try {
    const state = await (await api.submit(request())).completion;
    assert.equal(invocations.length, 5);
    assert.equal(state.events.filter(item => item.kind === 'controller.invalid_proposal').length, 5);
    assert.equal(state.status, 'waiting');
    assert.equal(state.waiting.kind, 'technical');
    assert.equal(state.waiting.reason.code, 'INVALID_PROPOSAL');
    assert.equal(state.waiting.reason.resource, 'controller_decision_recovery');
    assert.equal(state.waiting.reason.attemptId, invocations[4].attemptId);
    assert.equal(state.waiting.reason.actionId, invocations[4].attemptId);
  } finally { await api.close(); }
});

test('C16.0 RED: ten alternating rejections count per user turn, not by shared error text', async () => {
  const { api, invocations } = setup({ maxInvocations: 15, respond(invocation) {
    const current = invocations.length;
    const reply = final(invocation);
    return current % 2 === 0
      ? { ...reply, output: { ...reply.output, schemaVersion: 2 } }
      : { ...reply, output: 'invalid json', decisionTextError: 'invalid_json' };
  } });
  try {
    const state = await (await api.submit(request())).completion;
    assert.equal(state.status, 'waiting');
    assert.equal(invocations.length, 10);
    assert.equal(state.events.filter(item => item.kind === 'controller.invalid_proposal').length, 10);
    assert.equal(state.waiting.reason.code, 'INVALID_PROPOSAL');
  } finally { await api.close(); }
});

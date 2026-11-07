import assert from 'node:assert/strict';
import { test } from 'node:test';
import { final, setup } from '../../fixtures/application.js';
import { outcome, request } from '../../fixtures/core.js';

const delegate = (actionId, objective, overrides) => ({
  actionId, kind: 'delegate', objective, expectedResult: 'Outcome', profileId: 'primary',
  contextRefs: ['request-1'], dependsOn: [], ...overrides,
});

function propose(invocation, ...actions) {
  return final(invocation, {
    contextCursor: invocation.context[1].value.contextCursor,
    finalAssessment: undefined, additions: actions,
    waitPolicy: { kind: 'all_requested', targets: actions.map(action => ({ kind: 'action', id: action.actionId })) },
  });
}

async function scenario({ supportsIdempotency, approveRetry, basis, originalEffect = 'unknown' }) {
  const effects = [];
  const knownKeys = new Map();
  const objective = 'Apply one effect';
  const env = setup({
    supportsIdempotency, approveRetry, maxInvocations: 8, maxConcurrentInvocations: 2,
    // A configured flag is insufficient to authorize use of a provider key.
    capabilities: { 'attempt.idempotency': { support: 'supported', source: 'configured' } },
    respond(invocation) {
      if (invocation.kind === 'delegate') {
        if (invocation.objective === objective) {
          const previous = knownKeys.get(invocation.idempotencyKey);
          if (previous) assert.equal(invocation.objective, previous);
          else if (originalEffect === 'unknown' || invocation.actionId !== 'original') {
            effects.push(invocation.actionId);
            if (invocation.idempotencyKey) knownKeys.set(invocation.idempotencyKey, invocation.objective);
          }
          if (invocation.actionId === 'original' && originalEffect === 'unknown') throw Error('Disconnected');
        }
        return { outcome: outcome(invocation.attemptId, { effect: originalEffect === 'none' && invocation.actionId === 'original'
          ? 'none' : invocation.objective === objective ? 'confirmed' : 'none' }), dispatchCertainty: 'sent' };
      }

      const context = invocation.context[1].value;
      const prior = context.outcomes.find(item => item.actionId === 'original');
      if (!prior) return propose(invocation, delegate('original', objective));
      if (!invocation.context.some(item => item.ref === 'continue')) {
        return final(invocation, { finalAssessment: undefined, clarification: { question: 'Continue?' } });
      }
      if (!context.outcomes.some(item => item.actionId === 'read')) {
        return propose(invocation, delegate('replacement', objective, { retryOf: prior.attemptId, retryBasis: basis }),
          delegate('read', 'Read independent facts'));
      }
      return final(invocation);
    },
  });
  const waiting = await (await env.api.submit(request())).completion;
  const finished = await (await env.api.resume(waiting.operationId, {
    requestId: 'continue', questionId: waiting.waiting.questionId, text: 'Continue',
  })).completion;
  assert.equal(finished.status, 'finished');
  return { ...env, effects, finished, first: waiting.attempts.find(item => item.actionId === 'original') };
}

for (const basis of ['no_effect', 'user_approval', 'provider_idempotency']) {
  test('an unsupported retry basis does not block independent work: ' + basis, async () => {
    const { invocations, effects, finished, first } = await scenario({ basis });
    assert.deepEqual(effects, ['original']);
    assert.equal(first.outcome.effect, 'unknown');
    assert.equal(finished.attempts.find(item => item.actionId === 'replacement').outcome.diagnostics[0].code, 'RETRY_NOT_AUTHORIZED');
    assert.deepEqual(invocations.filter(item => item.kind === 'delegate').map(item => item.actionId), ['original', 'read']);
  });
}

test('provider idempotency reuses the recorded key on the original route', async () => {
  const { effects, first, finished, invocations } = await scenario({
    basis: 'provider_idempotency', supportsIdempotency: true,
  });
  assert.deepEqual(effects, ['original']);
  const retry = invocations.find(item => item.actionId === 'replacement');
  assert.equal(retry.idempotencyKey, first.attemptId);
  assert.notEqual(retry.attemptId, first.attemptId);
  assert.equal(finished.attempts.find(item => item.actionId === 'replacement').outcome.effect, 'confirmed');
  assert.equal(finished.attempts.find(item => item.actionId === 'original').outcome.effect, 'unknown');
});

test('trusted informed approval is scoped to one original attempt, replacement and profile', async () => {
  const approvals = [];
  const { effects, first, finished } = await scenario({
    basis: 'user_approval',
    approveRetry(input) { approvals.push(input); return input.actionId === 'replacement' && input.profileId === 'primary'; },
  });
  assert.deepEqual(effects, ['original', 'replacement']);
  assert.ok(approvals.length > 0);
  assert.ok(approvals.every(input => input.attemptId === first.attemptId && input.operationId === finished.operationId));
});

test('a known no-effect outcome allows an explicit retry on the same operation', async () => {
  const { effects, finished } = await scenario({ basis: 'no_effect', originalEffect: 'none' });
  assert.deepEqual(effects, ['replacement']);
  assert.equal(finished.attempts.find(item => item.actionId === 'original').outcome.effect, 'none');
});

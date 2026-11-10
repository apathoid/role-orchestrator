import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeOutcome } from '../../src/core/contracts.js';
import { receiveProviderObservation } from '../../src/core/observation.js';

const unknownUsage = { inputTokens: null, outputTokens: null, cost: null };

/**
 * Transport-neutral assertions. A fixture supplies controlled progress,
 * completion and failure and an out-of-band readiness signal for cancellation.
 */
export function providerContract(name, withFixture, { skip = false } = {}) {
  const check = (title, run) => test(name + ' · ' + title, { skip, timeout: 15_000 },
    () => withFixture(run));

  check('correlates ordered observations before a terminal result and keeps missing usage unknown', async fixture => {
    const description = await fixture.provider.describe();
    assert.equal(description.providerId, fixture.profile.providerId);
    await using call = await invocation(fixture, 'attempt-alpha', 'success');
    const response = await call.response;
    await call.close();
    assert.equal(response.outcome.terminal, 'completed');
    assert.equal(response.dispatchCertainty, 'sent');
    assert.equal(response.output, 'result attempt-alpha');
    assert.deepEqual(response.outcome.usage, unknownUsage);
    assert.deepEqual(call.modelMessages(), ['progress attempt-alpha', 'result attempt-alpha']);
    assert.equal(call.timeline.filter(item => item.kind === 'terminal').length, 1);
    assert.equal(call.timeline.at(-1).kind, 'terminal');
    assertReferences(response, call);
  });

  check('preserves attributed progress on terminal failure', async fixture => {
    await using call = await invocation(fixture, 'attempt-failed', 'failure');
    const response = await call.response;
    assert.equal(response.outcome.terminal, 'failed');
    assert.equal(response.dispatchCertainty, 'sent');
    assert.equal(response.outcome.effect, 'unknown');
    assert.equal(response.output, undefined);
    assert.deepEqual(response.outcome.usage, unknownUsage);
    assert.deepEqual(call.modelMessages(), ['progress attempt-failed']);
    assertReferences(response, call);
  });

  check('isolates two calls and correlates explicit cancellation by session and attempt', async fixture => {
    await using cancelled = await invocation(fixture, 'attempt-cancelled', 'hold');
    await using survivor = await invocation(fixture, 'attempt-survivor', 'hold');
    await Promise.all([fixture.ready(cancelled.id), fixture.ready(survivor.id)]);
    await cancelled.cancel(survivor.id);
    await survivor.cancel(cancelled.id);
    await cancelled.cancel(cancelled.id);
    await fixture.release(survivor.id);

    const stopped = await cancelled.response;
    assertCancelled(stopped);
    assert.deepEqual(cancelled.modelMessages(), ['progress attempt-cancelled']);
    const other = await survivor.response;
    assert.equal(other.outcome.terminal, 'completed');
    assert.equal(other.output, 'result attempt-survivor');
    assert.deepEqual(survivor.modelMessages(), ['progress attempt-survivor', 'result attempt-survivor']);
    assertReferences(stopped, cancelled);
    assertReferences(other, survivor);
  });

  check('observes signal cancellation and confirms close after the last callback', async fixture => {
    await using call = await invocation(fixture, 'attempt-abort', 'hold');
    await fixture.ready(call.id);
    call.abort();
    const close = call.close().then(() => call.timeline.push({ kind: 'closed' }));
    const response = await call.response;
    await close;
    assertCancelled(response);
    assert.deepEqual(call.modelMessages(), ['progress attempt-abort']);
    assert.deepEqual(call.timeline.slice(-2).map(item => item.kind), ['terminal', 'closed']);
    assertReferences(response, call);
  });

  check('closes a live session and supports a fresh call without a native continuation', async fixture => {
    await using first = await invocation(fixture, 'attempt-close', 'hold');
    await fixture.ready(first.id);
    await first.close();
    assertCancelled(await first.response);
    assert.deepEqual(first.modelMessages(), ['progress attempt-close']);

    await using next = await invocation(fixture, 'attempt-next', 'known-usage');
    const response = await next.response;
    assert.equal(response.outcome.terminal, 'completed');
    assert.equal(response.output, 'result attempt-next');
    assert.deepEqual(response.outcome.usage, fixture.knownUsage ?? { inputTokens: 0, outputTokens: 4, cost: null });
    assertReferences(response, next);
  });
}

async function invocation(fixture, id, objective) {
  const { provider, profile, workspaceContext } = fixture;
  const controller = new AbortController();
  const session = await provider.open(profile, controller.signal);
  assert.equal(typeof session.sessionId, 'string');
  assert.ok(session.sessionId.length > 0);
  const timeline = [];
  const localRefs = new Set();
  const response = provider.invoke(session, {
    attemptId: id, operationId: 'operation', actionId: 'action', kind: 'delegate', profile, workspaceContext,
    objective, instructions: [], userConstraints: [], context: [], authorityRef: 'grant',
    signal: controller.signal, timeoutMs: 8_000,
  }, item => {
    assert.equal(localRefs.has(item.ref), false, 'observation reference repeated in one invocation');
    localRefs.add(item.ref);
    const observation = receiveProviderObservation(item, 1);
    assert.ok(observation, 'invalid observation');
    const ref = 'assigned:' + id + ':' + item.ref;
    timeline.push({ kind: 'observation', ref, observation });
    return ref;
  }).then(result => {
    const decoded = decodeOutcome(result.outcome);
    assert.equal(decoded.kind, 'accepted');
    assert.equal(decoded.value.attemptId, id);
    timeline.push({ kind: 'terminal' });
    return result;
  });
  // The caller may be synchronizing with another session before awaiting this result.
  void response.catch(() => {});
  const close = () => provider.close(session);
  return {
    id, response, timeline, close,
    cancel: attemptId => provider.cancel(session, attemptId),
    abort: () => controller.abort(),
    modelMessages: () => timeline.flatMap(item => item.observation?.source === 'model_claim' ? [item.observation.value] : []),
    [Symbol.asyncDispose]: close,
  };
}

function assertCancelled(result) {
  assert.ok(['cancelled', 'unknown'].includes(result.outcome.terminal));
  assert.notEqual(result.outcome.effect, 'none');
  assert.notEqual(result.dispatchCertainty, 'not_sent');
  assert.equal(result.outcome.diagnostics[0]?.code, 'CANCELLED');
  assert.equal(result.output, undefined);
}

function assertReferences(result, call) {
  const emitted = new Set(call.timeline.flatMap(item => item.ref === undefined ? [] : [item.ref]));
  assert.ok(result.outcome.outputRefs.length > 0);
  for (const { ref } of result.outcome.outputRefs) assert.ok(emitted.has(ref), ref);
}

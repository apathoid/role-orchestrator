import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { encodeSnapshot } from '../../src/core/snapshot.js';
import { resourceSnapshot } from '../../src/main/index.js';
import { durableRequest, openDurableCodex } from '../fixtures/codex-durable-host.js';
import { withOwnedRun } from '../../scripts/owned-run.mjs';

function durableTest(title, run) {
  test(title, { skip: process.platform !== 'linux', timeout: 20_000 }, () =>
    withOwnedRun('C07-durable-codex', async directory => {
      const cwd = join(directory, 'workspace');
      const state = join(directory, 'state');
      await mkdir(cwd);
      await mkdir(state);
      await writeFile(join(cwd, 'target.txt'), 'before');
      await assert.rejects(access(join(cwd, '.git')), { code: 'ENOENT' });
      await run({ cwd, state });
    }));
}

async function readInvocations(cwd) {
  return (await readFile(join(cwd, 'invocations.jsonl'), 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line));
}

async function ready(cwd) {
  const deadline = performance.now() + 5_000;
  while (performance.now() < deadline) {
    try {
      return JSON.parse(await readFile(join(cwd, 'ready.json'), 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await sleep(10);
  }
  assert.fail('CLI child did not reach readiness');
}

async function closeService({ api, durable }, submission) {
  try {
    if (submission) {
      const operation = await api.inspect(submission.operation.operationId);
      if (operation.status === 'active') await api.cancel(operation.operationId);
      await submission.completion.catch(() => {});
    }
  } finally {
    await durable.close();
  }
}

durableTest('Codex CLI persists a result after an in-flight change in a non-Git workspace', async ({ cwd, state }) => {
  const input = durableRequest(cwd, 'mutable-workspace');
  const { api, durable } = await openDurableCodex(state);
  let completed;
  let submission;
  try {
    submission = await api.submit(input);
    const { attemptId } = await ready(cwd);
    await writeFile(join(cwd, 'target.txt'), 'after');
    await writeFile(join(cwd, 'unrelated'), 'created during invocation');
    await writeFile(join(cwd, 'release'), '');
    completed = await submission.completion;
    assert.equal(completed.status, 'finished');
    assert.equal(completed.assessment.answer, 'current target: after');
    assert.equal(resourceSnapshot(completed).charged, 1);
    const receipt = completed.events.find(event => event.kind === 'attempt.outcome');
    assert.equal(receipt.outcome.attemptId, attemptId);
    assert.ok(receipt.observations.some(item => item.source === 'model_claim' && item.value === 'target before release: before'));
    assert.deepEqual(await readInvocations(cwd), [{ kind: 'controller', attemptId, cwd }]);
  } finally {
    await closeService({ api, durable }, submission);
  }

  const reopened = await openDurableCodex(state, { idPrefix: 'restart-' });
  try {
    const replayed = await (await reopened.api.submit(input)).completion;
    assert.deepEqual(replayed, await reopened.durable.load(completed.operationId));
    assert.equal(replayed.revision, completed.revision);
    assert.equal(replayed.assessment.answer, completed.assessment.answer);
    assert.equal((await readInvocations(cwd)).length, 1);
  } finally {
    await reopened.durable.close();
  }
});

durableTest('Codex CLI Worker effect remains unknown after host crash and is not replayed on resume', async ({ cwd, state }) => {
  const fixture = new URL('../fixtures/codex-durable-host.js', import.meta.url);
  const child = fork(fixture, [state, cwd], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  const exited = once(child, 'exit');
  let checkpoint;
  try {
    checkpoint = await Promise.race([
      once(child, 'message', { signal: AbortSignal.timeout(8_000) }).then(([message]) => message),
      exited.then(() => assert.fail('Host exited before the Worker outcome boundary')),
    ]);
    child.kill('SIGKILL');
    assert.deepEqual(await exited, [null, 'SIGKILL']);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  }
  const { operationId, workerAttemptId } = checkpoint;
  const before = await readInvocations(cwd);
  assert.deepEqual(before.map(call => call.kind), ['controller', 'delegate']);
  assert.equal(before[1].attemptId, workerAttemptId);
  assert.equal(await readFile(join(cwd, 'effects.log'), 'utf8'), workerAttemptId + '\n');
  await writeFile(join(cwd, 'target.txt'), 'changed after crash');

  const { api, durable } = await openDurableCodex(state, { idPrefix: 'restart-' });
  try {
    const original = await durable.load(operationId);
    const worker = original.attempts.find(attempt => attempt.attemptId === workerAttemptId);
    assert.equal(worker.status, 'dispatched');
    assert.equal(worker.dispatchCertainty, 'unknown');
    assert.equal(resourceSnapshot(original).charged, 2);
    const duplicate = await (await api.submit(durableRequest(cwd, 'recover-worker'))).completion;
    assert.equal(duplicate.operationId, operationId);
    assert.deepEqual(await readInvocations(cwd), before);

    const recovered = await (await api.resume(operationId)).completion;
    assert.equal(recovered.status, 'finished');
    assert.equal(recovered.assessment.overall, 'partial');
    assert.equal(recovered.assessment.answer, 'unknown Worker effect; current target: changed after crash');
    const outcome = recovered.attempts.find(attempt => attempt.attemptId === workerAttemptId);
    assert.equal(outcome.outcome.terminal, 'unknown');
    assert.equal(outcome.outcome.effect, 'unknown');
    assert.equal(outcome.dispatchCertainty, 'unknown');
    assert.equal(resourceSnapshot(recovered).charged, 3);
    const after = await readInvocations(cwd);
    assert.deepEqual(after.slice(0, 2), before);
    assert.deepEqual(after.slice(2), [{ kind: 'controller', attemptId: recovered.attempts.at(-1).attemptId, cwd }]);
    assert.equal(await readFile(join(cwd, 'effects.log'), 'utf8'), workerAttemptId + '\n');
    assert.equal((await durable.load(operationId)).revision, recovered.revision);
  } finally {
    await durable.close();
  }
});

durableTest('service cancellation closes the live CLI child and persists its partial observations', async ({ cwd, state }) => {
  const input = durableRequest(cwd, 'cancel-live');
  const { api, durable } = await openDurableCodex(state);
  let completed;
  let submission;
  try {
    submission = await api.submit(input);
    const { pid, attemptId } = await ready(cwd);
    await api.cancel(submission.operation.operationId, 'client');
    completed = await submission.completion;
    assert.equal(completed.status, 'cancelled');
    assert.equal(completed.cancellation, 'client');
    assert.equal(completed.assessment, undefined);
    assert.equal(completed.events.some(event => event.kind === 'controller.responded'), false);
    const receipts = completed.events.filter(event => event.kind === 'attempt.outcome' && event.outcome.attemptId === attemptId);
    assert.ok(receipts.some(event => event.outcome.diagnostics.some(item => item.code === 'CANCELLED')));
    const observations = receipts.flatMap(event => event.observations ?? []);
    assert.ok(observations.some(item => item.source === 'model_claim' && item.value === 'target before release: before'));
    assert.ok(observations.some(item => item.source === 'host_observed' && item.value?.signal === 'SIGKILL'));
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  } finally {
    await closeService({ api, durable }, submission);
  }

  const reopened = await openDurableCodex(state, { idPrefix: 'restart-' });
  try {
    const replayed = await (await reopened.api.submit(input)).completion;
    assert.equal(replayed.status, 'cancelled');
    assert.equal(replayed.revision, completed.revision);
    assert.equal(encodeSnapshot(replayed), encodeSnapshot(completed));
    assert.equal((await readInvocations(cwd)).length, 1);
  } finally {
    await reopened.durable.close();
  }
});

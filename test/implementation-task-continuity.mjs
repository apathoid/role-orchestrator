import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createSessionLifecycle } from '../src/session-lifecycle.mjs';
import { createExecutionService } from '../src/execution-service.mjs';
import { implementationTaskSummaries } from '../src/implementation-tasks.mjs';
import { planDigest } from '../src/implementation-stages.mjs';

const scratch = await mkdtemp(join(tmpdir(), 'orchestrator-task-continuity-'));
const oldState = process.env.AGENT_STATE_DIR;
process.env.AGENT_STATE_DIR = join(scratch, 'state');
const repo = join(scratch, 'repo');
await mkdir(repo);
assert.equal(spawnSync('git', ['init', '-q'], { cwd: repo }).status, 0);
const config = { roles: {}, profiles: {}, providers: {} };
const artifact = (id) => {
  const plan = { goal: id, steps: Array.from({ length: 4 }, (_, i) => `${id} step ${i + 1}`), acceptanceCriteria: ['check the implementation'] };
  return { version: 1, repoRoot: repo, planId: planDigest(plan), plan };
};
const cp = (id, status = 'interrupted') => ({ version: 1, planId: id, status, interruptedStage: 'I2', completedStages: ['I1'], records: [{ id: 'S1', status: 'implemented' }] });
const seen = [];
const attachments = {
  persistTurnAttachments: async () => ({ attachments: [], commitSucceeded: async () => {}, commitFailed: async () => {} }),
  buildHistoricalAttachmentBlocks: async () => ({ blocks: [] }), cleanupSessionAttachments: async () => {},
};
try {
  const lifecycle = createSessionLifecycle({ getConfig: async () => config });
  const { sessionId, session } = await lifecycle.create({ cwd: repo });
  let firstId = null;
  let nextPlan = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const execution = createExecutionService({
    getConfig: async () => config, persist: lifecycle.persist, attachments,
    createRegistry: async () => ({ close: async () => {} }),
    workflow: async (args) => {
      // The mocked Router supplies a typed continuation decision to the same
      // callback used by production, rather than relying on lexical service parsing.
      const selection = args.task === 'Реализуй предыдущий план'
        ? {mode:'saved_implementation'}
        : args.task === 'Продолжай'
          ? {mode:'current_implementation'}
          : args.task === `Продолжи реализацию плана ${first}` || args.task === `Продолжи реализацию плана ${firstId}`
            ? {mode:'saved_implementation',operationId:firstId} : null;
      const selected=selection ? await args.onSelectSavedImplementation(selection) : null;
      seen.push({ task: args.task, selected: selected?.plan?.planId ?? null,
        checkpoint: selected?.checkpoint?.planId ?? null });
      if (args.task === 'Внеси необходимые изменения и закончи реализацию задачи') {
        assert.equal(args.authoritativePlan, null, 'new Change after an audit must not attach a saved Plan');
        assert.equal(args.implementationCheckpoint, null);
        const newPlan = artifact('eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee');
        await args.onImplementationPlan(newPlan);
        await args.onImplementationCheckpoint(cp(newPlan.planId));
        return { status: 'implementation_incomplete', responseText: 'Partial Change saved' };
      }
      if (args.task.startsWith('Make independent change')) {
        assert.equal(args.authoritativePlan, null);
        assert.equal(args.implementationCheckpoint, null, 'old I2 must not poison an independent implementation');
        // Equivalent to the production workflow: persist Plan before coder,
        // then persist an interrupted checkpoint with partial edits preserved.
        await args.onImplementationPlan(artifact(nextPlan));
        const saved = await lifecycle.restore({ sessionId, cwd: repo });
        assert.equal(saved.implementationPlan.planId, artifact(nextPlan).planId, 'Plan durable BEFORE the first stage begins');
        assert.equal(saved.implementationCheckpoint, null);
        await args.onImplementationCheckpoint(cp(artifact(nextPlan).planId));
        return { status: 'implementation_incomplete', responseText: 'I2 interrupted, edits preserved.' };
      }
      if (args.planOnly) return { status: 'planned', planArtifact: artifact(nextPlan), responseText: 'Plan saved' };
      if (args.task === 'Реализуй предыдущий план') {
        assert.equal(selected, null, 'ambiguous selection must not attach a Plan');
        return {status:'implementation_incomplete',responseText:'Multiple saved Plans require an explicit target'};
      }
      if (selected?.plan) {
        assert.equal(selected.checkpoint?.planId, selected.plan.planId);
        assert.equal(selected.checkpoint?.interruptedStage, 'I2');
        return { status: 'changed', responseText: 'Resumed without restarting I1' };
      }
      return { status: 'investigated', responseText: 'Question answered read-only' };
    },
  });
  let otherSessionId;
  const run = (sess, task, opts = {}) => execution.execute({
    sessionId, session: sess, invocation: { task, modeOverride: opts.modeOverride ?? null },
    rawText: task, controls: { planOnly: opts.planOnly ?? false },
  });
  const first = artifact(nextPlan).planId;
  await run(session, 'Make independent change alpha');
  assert.equal(session.implementationCheckpoint.planId, first);
  firstId = session.activeImplementationTaskId;
  nextPlan = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  await run(session, 'Что уже сделано по старому плану?');
  assert.equal(seen.at(-1).selected, null);
  assert.equal(seen.at(-1).checkpoint, null);
  await run(session, 'Make independent change beta');
  assert.equal(session.implementationCheckpoint.planId, artifact(nextPlan).planId);
  assert.equal(session.implementationTasks.length, 2);
  assert.equal(session.implementationTasks[0].checkpoint.planId, first);
  assert.equal(session.implementationTasks[1].checkpoint.planId, artifact(nextPlan).planId);
  assert.notEqual(session.activeImplementationTaskId, firstId);
  assert.equal((await run(session, 'Реализуй предыдущий план')).result.status, 'implementation_incomplete');
  assert.equal(session.implementationCheckpoint.planId, artifact(nextPlan).planId, 'ambiguous reference must not change active task');

  const restored = await createSessionLifecycle({ getConfig: async () => config }).restore({ sessionId, cwd: repo });
  assert.equal(restored.implementationTasks.length, 2, 'archive survives restart');
  await run(restored, `Продолжи реализацию плана ${first}`);
  assert.equal(seen.at(-1).selected, first);
  assert.equal(seen.at(-1).checkpoint, first);
  assert.equal(restored.activeImplementationTaskId, firstId);
  assert.equal(restored.implementationCheckpoint.planId, first);
  assert.equal(restored.implementationTasks[1].checkpoint.planId, artifact(nextPlan).planId);
  await run(restored, 'Что делает этот метод?');
  assert.equal(seen.at(-1).selected, null);
  await run(restored, 'Продолжай');
  assert.equal(seen.at(-1).selected, first);
  // A completed coder with incomplete integration/approval must be resumable
  // from an explicit bare continuation; unrelated questions remain read-only.
  restored.implementationCheckpoint.status = 'integration_incomplete';
  const selectedTask = restored.implementationTasks.find((t) => t.taskId === firstId);
  selectedTask.checkpoint.status = 'integration_incomplete';
  await run(restored, 'Продолжай');
  assert.equal(seen.at(-1).selected, first, 'approval/review continuation must find the saved Plan');
  await run(restored, 'Что делает этот метод?');
  assert.equal(seen.at(-1).selected, null, 'a question must not resume incomplete integration');

  // Creating a new Plan in Plan mode must archive the previous unfinished
  // implementation instead of resetting its checkpoint or orphaning I1.
  nextPlan = 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd';
  await run(restored, 'Plan another independent feature', { planOnly: true });
  assert.equal(restored.implementationTasks.length, 3);
  assert.equal(restored.implementationPlan.planId, artifact(nextPlan).planId);
  assert.equal(restored.implementationCheckpoint, null);
  assert.equal(restored.implementationTasks.find((t) => t.taskId === firstId).checkpoint.planId, first);
  await run(restored, `Продолжи реализацию плана ${firstId}`);
  assert.equal(restored.implementationCheckpoint.planId, first);
  assert.equal(restored.implementationTasks.find((t) => t.plan?.planId === artifact(nextPlan).planId).checkpoint, null);

  // Regression: a read-only audit creates a textual recommendation, not a
  // structured Plan. The subsequent ordinary implementation must start its
  // own durable Change instead of failing with 'No structured Plan saved'.
  const audited = await lifecycle.create({ cwd: repo });
  otherSessionId = audited.sessionId;
  const audit = await execution.execute({ sessionId: otherSessionId, session: audited.session,
    invocation: { task: 'Проведи read-only аудит оставшейся работы', modeOverride: 'investigate' },
    rawText: 'Проведи read-only аудит оставшейся работы' });
  assert.equal(audit.result.status, 'investigated');
  assert.equal(audited.session.implementationPlan ?? null, null);
  await execution.execute({ sessionId: otherSessionId, session: audited.session,
    invocation: { task: 'Внеси необходимые изменения и закончи реализацию задачи' },
    rawText: 'Внеси необходимые изменения и закончи реализацию задачи' });
  const newChange = await lifecycle.restore({ sessionId: otherSessionId, cwd: repo });
  assert.equal(newChange.implementationTasks.length, 1);
  assert.equal(newChange.implementationCheckpoint.interruptedStage, 'I2');
  assert.equal(newChange.implementationPlan.planId, newChange.implementationCheckpoint.planId);
  // The same plain-language command with an unrelated active Plan must also
  // start fresh rather than resuming the old checkpoint.
  nextPlan = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
  await run(restored, 'Внеси необходимые изменения и закончи реализацию задачи');
  assert.equal(seen.at(-1).selected, null);
  assert.equal(seen.at(-1).checkpoint, null);
  assert.equal(restored.implementationPlan.planId, artifact('eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee').planId);
  assert.equal(restored.implementationTasks.find((t) => t.taskId === firstId).checkpoint.planId, first);

  // An existing v1 orphan checkpoint must not be assigned to a new Plan.
  const orphanSession = { cwd: repo, implementationPlan: null, implementationCheckpoint: cp('orphan'),
    implementationReconciliation: null, history: [], transcript: [] };
  const orphanSummary = implementationTaskSummaries(orphanSession);
  assert.equal(orphanSummary.length, 1);
  assert.equal(orphanSummary[0].status, 'interrupted');
  assert.equal(orphanSummary[0].origin, 'legacy_orphan');
  assert.equal(orphanSummary[0].goal, null);

  // Rollback of a failed durable save restores registry and legacy aliases.
  const badExecution = createExecutionService({ getConfig: async () => config,
    persist: async () => { throw new Error('disk unavailable'); }, attachments,
    createRegistry: async () => ({ close: async () => {} }),
    workflow: async (args) => { await args.onImplementationPlan(artifact('cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc')); },
  });
  const beforeCount = restored.implementationTasks.length;
  const previousId = restored.activeImplementationTaskId;
  const previousCheckpointPlanId = restored.implementationCheckpoint.planId;
  await assert.rejects(() => badExecution.execute({ sessionId, session: restored, invocation: { task: 'Make independent change gamma' } }), /disk unavailable/);
  assert.equal(restored.implementationTasks.length, beforeCount);
  assert.equal(restored.activeImplementationTaskId, previousId);
  assert.equal(restored.implementationCheckpoint.planId, previousCheckpointPlanId);
  console.log('implementation-task-continuity: passed (isolated tasks, early durable Plans, restart, historical resume, orphan retention, rollback)');
} finally {
  if (oldState === undefined) delete process.env.AGENT_STATE_DIR;
  else process.env.AGENT_STATE_DIR = oldState;
  await rm(scratch, { recursive: true, force: true });
}

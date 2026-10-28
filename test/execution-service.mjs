import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createSessionLifecycle } from '../src/session-lifecycle.mjs';
import { createExecutionService } from '../src/execution-service.mjs';
import { createTurnCoordinator } from '../src/turn-coordinator.mjs';
import { CANCELLATION_REASONS } from '../src/cancellation.mjs';
import { planDigest } from '../src/implementation-stages.mjs';

const scratch = await mkdtemp(join(tmpdir(), 'orchestrator-execution-host-'));
const repo = join(scratch, 'repo');
const oldState = process.env.AGENT_STATE_DIR;
const config = {
  roles: { router: 'balanced' },
  profiles: { balanced: { provider: 'mock', model: 'mock-1' } },
  providers: { mock: { type: 'mock' } },
};
process.env.AGENT_STATE_DIR = join(scratch, 'state');
await mkdir(repo, { recursive: true });
assert.equal(spawnSync('git', ['init', '-q'], { cwd: repo }).status, 0);
const calls = [];
const planData = { goal: 'test', steps: ['S1'], acceptanceCriteria: ['test passes'] };
const artifact = { version: 1, repoRoot: repo, planId: planDigest(planData), plan: planData };
const checkpoint = { version: 1, planId: artifact.planId, status: 'in_progress', completedStages: ['I1'] };
const reviewed = { version: 1, scopeKey: 'review-key', status: 'completed', checked: ['A1'] };
let failure = false;
const fakeAttachments = {
  persistTurnAttachments: async (_id, media) => ({ attachments: media.map((x) => ({ id: 'att_123456789', type: x.type, persisted: false, reason: 'test-fixture' })),
    commitSucceeded: async () => { calls.push('commit'); },
    commitFailed: async () => { calls.push('rollback'); },
  }),
  buildHistoricalAttachmentBlocks: async (_id, transcript) => ({ blocks: transcript.length ? [{ type: 'text', text: 'historical attachment reference' }] : [] }),
  cleanupSessionAttachments: async () => { calls.push('cleanup'); },
};
try {
  const lifecycle = createSessionLifecycle({ getConfig: async () => config });
  const { sessionId, session } = await lifecycle.create({ cwd: repo });
  const execution = createExecutionService({
    getConfig: async () => config,
    persist: lifecycle.persist,
    attachments: fakeAttachments,
    createRegistry: async (_config, bridge) => {
      assert.equal(bridge.fakeClient, 'headless');
      return { close: async () => calls.push('registry-close') };
    },
    workflow: async (args) => {
      calls.push({ task: args.task, plan: args.authoritativePlan, implementationCheckpoint: args.implementationCheckpoint,
        reviewCheckpoint: args.reviewCheckpoint, modeOverride: args.modeOverride, sessionContextText: args.sessionContextText,
        promptBlocks: args.promptBlocks });
      assert.equal(args.repoStart, repo);
      if (args.task === 'Plan changes') {
        assert.equal(args.planOnly, true);
        return { status: 'planned', planArtifact: artifact, responseText: 'Plan completed' };
      }
      if (args.task === 'Implement saved plan') {
        const selected=await args.onSelectSavedImplementation({mode:'current_implementation'});
        if (!selected?.plan) throw new Error('No structured implementation plan');
        assert.equal(selected.plan.planId, artifact.planId);
        assert.equal(selected.checkpoint, null);
        await args.onImplementationCheckpoint(checkpoint);
        return { status: 'changed', responseText: 'Stage completed' };
      }
      if (args.task === 'continue') {
        const selected=await args.onSelectSavedImplementation({mode:'current_implementation'});
        assert.equal(selected?.plan?.planId, artifact.planId);
        assert.deepEqual(selected.checkpoint, checkpoint);
        await args.onImplementationReconciliation({ plan: artifact, checkpoint, proposal: { version: 1, planId: artifact.planId, status: 'approved' } });
        await args.onReviewCheckpoint(reviewed);
        return { status: 'changed', responseText: 'Resumed' };
      }
      if (args.task === 'продолжай') {
        if (args.modeOverride && args.modeOverride !== 'change') return { status: 'investigated', responseText: 'Read-only override' };
        const selected=await args.onSelectSavedImplementation({mode:'current_implementation'});
        if (!selected?.plan) return { status: 'investigated', responseText: 'No saved plan selected' };
        assert.equal(selected.plan.planId, artifact.planId);
        assert.ok(['interrupted', 'review_interrupted'].includes(selected.checkpoint.status));
        return { status: 'investigated', responseText: 'Interrupted stage resumed explicitly' };
      }
      if (args.task === 'Проверь по плану') {
        assert.equal(args.authoritativePlan, null, 'review-like request cannot trigger writing');
        return { status: 'investigated', responseText: 'Read-only request' };
      }
      if (args.task === 'Review changes') {
        assert.deepEqual(args.reviewCheckpoint, reviewed);
        return { status: 'review_passed', responseText: 'Reviewed' };
      }
      if (failure) throw new Error('fake workflow failure');
      return { status: 'investigated', responseText: 'Investigation complete' };
    },
  });
  let currentSession = session;
  const headless = async (task, opts = {}) => execution.execute({
    sessionId, session: currentSession, invocation: { task, modeOverride: opts.modeOverride ?? null }, rawText: task,
    reporter: { event: async () => {} }, mediaBlocks: opts.mediaBlocks ?? [],
    providerBridge: { fakeClient: 'headless' },
    controls: { planOnly: opts.planOnly ?? false, streamFinalResponse: opts.streamFinalResponse ?? false },
  });
  await assert.rejects(() => headless('Implement saved plan'), /No structured implementation plan/);
  assert.equal(calls.filter((entry) => typeof entry === 'object').length, 1, 'injected workflow must resolve and reject a missing Plan through typed selection');
  assert.equal((await headless('Plan changes', { planOnly: true })).assistantText, 'Plan completed');
  assert.equal(session.implementationPlan.planId, artifact.planId);
  assert.equal(session.implementationCheckpoint, null);
  await headless('Implement saved plan', { mediaBlocks: [{ type: 'image', data: 'demo' }] });
  assert.deepEqual(session.implementationCheckpoint, checkpoint);
  assert.equal(session.transcript.length, 2);
  const restoredLifecycle = createSessionLifecycle({ getConfig: async () => config });
  const restored = await restoredLifecycle.restore({ sessionId, cwd: repo });
  assert.equal(restored.implementationPlan.planId, artifact.planId);
  assert.deepEqual(restored.implementationCheckpoint, checkpoint);
  assert.equal(restored.transcript[1].attachments[0].type, 'image');
  const continuation = await execution.execute({
    sessionId, session: restored, invocation: { task: 'continue' }, rawText: 'continue',
    providerBridge: { fakeClient: 'headless' }, reporter: { event: async () => {} },
  });
  assert.equal(continuation.assistantText, 'Resumed');
  assert.deepEqual(restored.reviewCheckpoint, reviewed);
  assert.deepEqual(restored.implementationReconciliation, { version: 1, planId: artifact.planId, status: 'approved' });
  // Once a restored copy has committed newer state, the earlier in-memory
  // session is stale and must not silently overwrite its updated transcript.
  await assert.rejects(() => lifecycle.persist(sessionId, session),
    error => error.code === 'SESSION_REVISION_CONFLICT');
  currentSession = restored;
  await execution.execute({
    sessionId, session: restored, invocation: { task: 'Review changes' }, rawText: 'Review changes',
    providerBridge: { fakeClient: 'headless' }, reporter: { event: async () => {} },
  });
  assert.equal(restored.transcript.length, 4);
  assert(calls.some((entry) => typeof entry === 'object' && entry.sessionContextText.includes('Stage completed')));
  const persisted = JSON.parse(await readFile(join(process.env.AGENT_STATE_DIR, 'sessions', `${sessionId}.json`), 'utf8'));
  assert.equal(persisted.implementationPlan.planId, artifact.planId);
  assert.deepEqual(persisted.reviewCheckpoint, reviewed);
  assert.equal(persisted.transcript.length, 4);

  const interruptedCheckpoint = { ...checkpoint, status: 'interrupted' };
  await execution.saveField(sessionId, restored, 'implementationCheckpoint', interruptedCheckpoint);
  const shortContinuation = await execution.execute({
    sessionId, session: restored, invocation: { task: 'продолжай' }, rawText: 'продолжай',
    providerBridge: { fakeClient: 'headless' }, reporter: { event: async () => {} },
  });
  assert.equal(shortContinuation.assistantText, 'Interrupted stage resumed explicitly');
  await execution.saveField(sessionId, restored, 'implementationCheckpoint', { ...checkpoint, status: 'review_interrupted' });
  assert.equal((await execution.execute({
    sessionId, session: restored, invocation: { task: 'продолжай' }, rawText: 'продолжай',
    providerBridge: { fakeClient: 'headless' }, reporter: { event: async () => {} },
  })).assistantText, 'Interrupted stage resumed explicitly',
  'a review interruption must allow bare continuation without selecting a new task');
  assert.equal((await headless('Проверь по плану')).assistantText, 'Read-only request');
  // Independent read-only work in a session with an interrupted implementation
  // must not consume, alter or attach the saved Plan/checkpoint.
  const beforeReadOnlyCheckpoint = restored.implementationCheckpoint;
  const beforeReadOnlyPlan = restored.implementationPlan;
  for (const [task, modeOverride] of [
    ['Можешь объяснить, как продолжить реализацию плана?', null],
    ['Почему «реализуй план» запускает workflow change?', null],
    ['Можно ли продолжить реализацию плана?', null],
    ['Что делает этот метод?', null],
    ['Исправь новую ошибку в другом модуле', null],
    ['Исправь новую ошибку в другом модуле', 'change'],
    ['Продолжи реализацию плана', 'investigate'],
    ['Реализуй предыдущий план', 'review'],
    ['продолжай', 'investigate'],
  ]) {
    await execution.execute({
      sessionId, session: restored, invocation: { task, modeOverride }, rawText: task,
      providerBridge: { fakeClient: 'headless' }, reporter: { event: async () => {} },
    });
    const call = calls.filter((entry) => typeof entry === 'object').at(-1);
    assert.equal(call.plan, null, `saved plan must not attach: ${task}, ${modeOverride}`);
    assert.equal(call.modeOverride, modeOverride, 'explicit host read-only mode must survive');
    assert.strictEqual(restored.implementationCheckpoint, beforeReadOnlyCheckpoint);
    assert.strictEqual(restored.implementationPlan, beforeReadOnlyPlan);
  }

  // Bare continuation does not invent an implementation plan if none exists.
  const savedPlan = restored.implementationPlan;
  const savedTasks = restored.implementationTasks;
  const savedActiveTask = restored.activeImplementationTaskId;
  restored.implementationPlan = null;
  restored.implementationTasks = [];
  restored.activeImplementationTaskId = null;
  restored.implementationCheckpoint = null;
  const noPlan = await execution.execute({
    sessionId, session: restored, invocation: { task: 'продолжай' }, rawText: 'продолжай',
    providerBridge: { fakeClient: 'headless' }, reporter: { event: async () => {} },
  });
  assert.equal(noPlan.result.status, 'investigated');
  restored.implementationPlan = savedPlan;
  restored.implementationTasks = savedTasks;
  restored.activeImplementationTaskId = savedActiveTask;
  restored.implementationCheckpoint = interruptedCheckpoint;

  failure = true;
  const before = restored.transcript;
  await assert.rejects(() => execution.execute({
    sessionId, session: restored, invocation: { task: 'Fail intentionally' }, rawText: 'Fail intentionally',
    providerBridge: { fakeClient: 'headless' }, reporter: { event: async () => {} },
  }), /fake workflow failure/);
  assert.strictEqual(restored.transcript, before, 'failed turn does not add history');
  assert(calls.includes('rollback'));
  assert(calls.includes('cleanup'));

  // Without a repository or ACP host process, turn coordinator retains
  // supersession and session-cancel provenance and serializes async turns.
  const coordinator = createTurnCoordinator();
  const a = new AbortController();
  const first = coordinator.reserve('session-a', a);
  await first.wait;
  first.activate();
  const b = new AbortController();
  const next = coordinator.reserve('session-a', b);
  assert.equal(a.signal.aborted, true);
  const c = new AbortController();
  const other = coordinator.reserve('session-b', c);
  await other.wait;
  other.activate();
  assert.equal(c.signal.aborted, false);
  first.release();
  await next.wait;
  next.activate();
  assert.equal(b.signal.aborted, false);
  coordinator.cancel('session-a');
  assert.equal(b.signal.aborted, true);
  assert.equal(b.signal.reason?.cancellationReason, CANCELLATION_REASONS.SESSION_CANCELLED);
  next.release();
  other.release();
  console.log('execution-service: passed (headless plan/change/resume/review/persistence/cancellation)');
} finally {
  if (oldState === undefined) delete process.env.AGENT_STATE_DIR;
  else process.env.AGENT_STATE_DIR = oldState;
  await rm(scratch, { recursive: true, force: true });
}

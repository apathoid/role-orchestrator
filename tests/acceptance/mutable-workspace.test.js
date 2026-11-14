import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { final, setup } from '../fixtures/application.js';
import { assessment, outcome, request } from '../fixtures/core.js';
import { withOwnedRun } from '../../scripts/owned-run.mjs';

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }, timeout: 10_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test('branch switch and staging during active worker do not force host reconcile or cancellation',
  { timeout: 15_000 }, async t => {
    if (spawnSync('git', ['--version'], { encoding: 'utf8' }).error?.code === 'ENOENT') {
      t.skip('Real Git fixture unavailable; product itself does not require Git');
      return;
    }
    await withOwnedRun('C12-mutable-git', async cwd => {
      git(cwd, 'init', '-q', '-b', 'main');
      const file = join(cwd, 'target.txt');
      await writeFile(file, 'old');
      git(cwd, 'add', 'target.txt');
      git(cwd, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
        'commit', '-qm', 'baseline');

      const workerStarted = Promise.withResolvers();
      const externalMutationDone = Promise.withResolvers();
      let controllerTurns = 0;
      const { api, invocations, events, cancellations } = setup({
        maxInvocations: 3,
        async respond(invocation) {
          assert.equal(invocation.workspaceContext.cwd, cwd);
          if (invocation.actionId === 'worker') {
            workerStarted.resolve();
            await externalMutationDone.promise;
            assert.equal(git(cwd, 'branch', '--show-current'), 'changed-by-user');
            assert.equal(await readFile(file, 'utf8'), 'new');
            return { dispatchCertainty: 'sent', outcome: outcome(invocation.attemptId) };
          }
          if (controllerTurns++ === 0) {
            return final(invocation, {
              additions: [{
                actionId: 'worker', kind: 'delegate', profileId: 'primary',
                objective: 'Inspect current target', expectedResult: 'Result with evidence',
                contextRefs: [], dependsOn: [],
              }],
              finalAssessment: undefined,
              waitPolicy: { kind: 'all_requested', targets: [{ kind: 'action', id: 'worker' }] },
            });
          }
          return final(invocation, { finalAssessment: assessment({
            author: 'primary', overall: 'complete', answer: 'Environment changed; continued',
          }) });
        },
      });
      const submission = await api.submit(request({ workspaceContext: { cwd } }));
      await workerStarted.promise;
      try {
        git(cwd, 'switch', '-q', '-c', 'changed-by-user');
        await writeFile(file, 'new');
        git(cwd, 'add', 'target.txt');
        assert.match(git(cwd, 'status', '--short'), /^M /);
      } finally {
        externalMutationDone.resolve();
      }
      const completed = await submission.completion;
      assert.equal(completed.status, 'finished');
      assert.equal(completed.assessment.answer, 'Environment changed; continued');
      assert.deepEqual(invocations.filter(x => x.actionId === 'worker').map(x => x.actionId), ['worker']);
      assert.equal(events.filter(x => x.eventName === 'attempt.dispatched').length, 3);
      assert.deepEqual(cancellations, []);
    });
  });

import assert from 'node:assert/strict';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { decodeSnapshot, encodeSnapshot } from '../../../../src/core/snapshot.js';
import { final, setup } from '../../fixtures/application.js';
import { assessment, outcome, request } from '../../fixtures/core.js';
import { withOwnedRun } from '../../scripts/owned-run.mjs';

const inspect = (actionId, contextRefs = []) => ({
  actionId, kind: 'delegate', profileId: 'primary', objective: 'Read target.js', expectedResult: 'Observed value',
  contextRefs, dependsOn: [],
});
const delegate = (invocation, action) => final(invocation, {
  additions: [action], finalAssessment: undefined,
  waitPolicy: { kind: 'all_requested', targets: [{ kind: 'action', id: action.actionId }] },
});

for (const [edited, needsRead] of [['other.js', false], ['target.js', true]]) {
  test('model decides whether to re-read after an observed change to ' + edited, { timeout: 5000 }, async () => {
    await withOwnedRun('mutable-context', async cwd => {
      const target = join(cwd, 'target.js');
      const changed = join(cwd, edited);
      await writeFile(target, 'value = 1');
      if (!needsRead) await writeFile(changed, 'other');
      const before = (await stat(changed)).size;
      const read = Promise.withResolvers();
      const editedFile = Promise.withResolvers();
      let controllers = 0;
      let changeRef;
      let originalRef;
      const original = {
        findingId: 'initial', author: 'primary', subject: 'target.js', claim: 'Target was read as value = 1',
        supports: ['original-read'], uncertainties: [],
      };
      const { api, invocations, events, cancellations } = setup({
        maxInvocations: 6,
        async respond(invocation, count, observe) {
          assert.equal(invocation.workspaceContext.cwd, cwd);
          if (invocation.actionId === 'initial') {
            originalRef = observe({
              kind: 'provider_tool', ref: 'original-read', sourceId: 'fixture-read', completeness: 'complete',
              value: await readFile(target, 'utf8'), reportedContext: { location: 'target.js', version: 'original' },
            });
            read.resolve();
            await editedFile.promise;
            const after = (await stat(changed)).size;
            assert.notEqual(after, before);
            changeRef = observe({
              kind: 'provider_tool', ref: 'observed-change', sourceId: 'fixture-stat', completeness: 'complete',
              value: { before, after },
              reportedContext: { location: edited, version: 'size-' + after, reportedAt: 25 },
            });
            return { dispatchCertainty: 'sent', outcome: outcome(invocation.attemptId), findings: [original] };
          }
          if (invocation.actionId === 'targeted-read') {
            assert.deepEqual(invocation.context.map(item => item.ref), ['finding:initial', changeRef]);
            assert.equal(invocation.context[1].reportedContext.location, 'target.js');
            observe({
              kind: 'provider_tool', ref: 'targeted-result', sourceId: 'fixture-read-again', completeness: 'complete',
              value: await readFile(target, 'utf8'), reportedContext: { location: 'target.js', version: 'reread' },
            });
            return { dispatchCertainty: 'sent', outcome: outcome(invocation.attemptId) };
          }
          if (++controllers === 1) return delegate(invocation, inspect('initial'));
          const observation = invocation.context.find(item => item.ref === changeRef);
          assert.equal(observation.source, 'provider_reported');
          assert.equal(observation.provenance.receivedAt, 100);
          assert.equal(observation.reportedContext.reportedAt, 25);
          assert.equal(invocation.context.find(item => item.ref === 'finding:initial').value.claim, original.claim);
          if (controllers === 2 && observation.reportedContext.location === original.subject) {
            return delegate(invocation, inspect('targeted-read', ['finding:initial', changeRef]));
          }
          const latest = invocation.context.find(item => item.providerRef === 'targeted-result');
          return final(invocation, { finalAssessment: assessment({
            answer: latest?.value ?? original.claim,
            findingRefs: ['finding:initial'],
            observationRefs: latest ? [latest.ref] : [originalRef],
          }) });
        },
      });
      const submission = await api.submit(request({ workspaceContext: { cwd } }));
      await read.promise;
      try {
        await writeFile(changed, 'value = 2000');
      } finally {
        editedFile.resolve();
      }
      const finished = await submission.completion;
      assert.equal(finished.status, 'finished');
      assert.equal(finished.assessment.answer, needsRead ? 'value = 2000' : original.claim);
      assert.deepEqual(invocations.filter(item => item.kind === 'delegate').map(item => item.actionId),
        needsRead ? ['initial', 'targeted-read'] : ['initial']);
      const dispatches = events.filter(item => item.eventName === 'attempt.dispatched');
      assert.equal(dispatches.length, needsRead ? 5 : 3);
      assert.deepEqual(dispatches.map(item => item.attemptId), invocations.map(item => item.attemptId));
      assert.deepEqual(cancellations, []);

      const restored = decodeSnapshot(encodeSnapshot(finished));
      assert.equal(restored.kind, 'accepted');
      const receipts = restored.value.events.filter(event => event.kind === 'attempt.outcome');
      assert.deepEqual(receipts.flatMap(event => event.findings ?? []), [{ ...original, supports: [originalRef], supersedes: undefined }]);
      const record = receipts.flatMap(event => event.observations ?? []).find(item => item.ref === changeRef);
      assert.equal(record.reportedContext.location, edited);
      assert.equal(record.reportedContext.version, 'size-12');
      assert.equal(receipts.flatMap(event => event.observations ?? []).find(item => item.ref === originalRef).value, 'value = 1');
    });
  });
}

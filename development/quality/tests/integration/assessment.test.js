import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { decodeSnapshot, encodeSnapshot } from '../../../../src/core/snapshot.js';
import { final, setup } from '../../fixtures/application.js';
import { assessment, outcome, request } from '../../fixtures/core.js';
import { withOwnedRun } from '../../scripts/owned-run.mjs';

test('the model keeps a requested post-change check unverified with only a historical tool exit', async () => {
  await withOwnedRun('required-check', async (cwd, run) => {
    const file = join(cwd, 'target.txt');
    await writeFile(file, 'before');
    const required = 'Run the check after editing target.txt.';
    const edit = {
      kind: 'delegate', actionId: 'edit', profileId: 'primary', objective: 'Update target.txt', expectedResult: 'Change report',
      contextRefs: [], dependsOn: [],
    };
    const { api, invocations, events } = setup({ context: { maxBytes: 512 }, async respond(invocation, count, observe) {
      assert.deepEqual(invocation.userConstraints, [required]);
      if (count === 1) {
        const result = run(process.execPath, ['-e',
          'if (require("node:fs").readFileSync("target.txt", "utf8") !== "before") process.exit(1)'], { cwd });
        assert.ifError(result.error);
        assert.equal(result.status, 0);
        observe({
          kind: 'provider_tool', ref: 'check:before', sourceId: 'test-process', exitCode: result.status, completeness: 'complete',
          reportedContext: { location: 'target.txt', version: 'before' },
        });
        return final(invocation, {
          additions: [edit], finalAssessment: undefined,
          waitPolicy: { kind: 'all_requested', targets: [{ kind: 'action', id: 'edit' }] },
        });
      }
      if (invocation.actionId === 'edit') {
        await writeFile(file, 'after');
        observe({
          kind: 'provider_tool', ref: 'change:after', sourceId: 'write-tool', completeness: 'complete',
          value: 'Edited target.txt', reportedContext: { location: 'target.txt', version: 'after' },
        });
        return { dispatchCertainty: 'sent', outcome: outcome(invocation.attemptId) };
      }
      const check = (await invocation.contextAccess.fetch('check:before')).item;
      const changed = (await invocation.contextAccess.fetch('change:after')).item;
      assert.equal(check.provenance.exit.kind, 'tool_exit');
      assert.equal(check.provenance.exit.code, 0);
      assert.ok(check.receivedSequence.revision < changed.receivedSequence.revision);
      assert.notEqual(check.reportedContext.version, changed.reportedContext.version);
      return final(invocation, { finalAssessment: assessment({
        overall: 'partial', answer: 'Edited target.txt. The post-change check is unverified.',
        requirements: [
          { requirementId: 'edit', status: 'fulfilled', observationRefs: [changed.ref], findingRefs: [] },
          { requirementId: 'check', status: 'unverified', observationRefs: [check.ref, changed.ref], findingRefs: [],
            reason: 'The only tool exit was recorded before the edit.' },
        ],
      }) });
    } });

    const state = await (await api.submit(request({ workspaceContext: { cwd }, userConstraints: [required] }))).completion;
    assert.equal(state.status, 'finished');
    assert.equal(await readFile(file, 'utf8'), 'after');
    assert.equal(state.assessment.overall, 'partial');
    assert.deepEqual(state.assessment.requirements.map(item => item.status), ['fulfilled', 'unverified']);
    assert.equal(state.assessment.requirements[1].reason, 'The only tool exit was recorded before the edit.');
    const records = state.events.flatMap(event => event.observations ?? []);
    assert.deepEqual(records.filter(item => item.provenance?.exit?.kind === 'tool_exit').map(item => item.ref), ['check:before']);
    assert.deepEqual(invocations.map(item => item.kind), ['controller', 'delegate', 'controller']);
    assert.equal(events.filter(item => item.eventName === 'attempt.dispatched').length, 3);
    const wire = JSON.parse(encodeSnapshot(state));
    assert.equal(decodeSnapshot(JSON.stringify(wire)).kind, 'accepted');
    wire.assessment.requirements[1].status = 'fulfilled';
    assert.equal(decodeSnapshot(JSON.stringify(wire)).reason.path, '$.assessment');
  });
});

test('assessment correction validates structure and resumed context keeps unresolved model statuses', async () => {
  const requirement = { requirementId: 'check', status: 'unverified', reason: 'No matching check',
    observationRefs: [], findingRefs: [] };
  const required = 'Run the explicit check.';
  const { api, invocations } = setup({ maxInvocations: 5, context: { maxBytes: 1 }, respond(invocation, count) {
    assert.deepEqual(invocation.userConstraints, [required]);
    if (count === 1) return final(invocation, { finalAssessment: assessment({ author: 'different-profile' }) });
    if (count === 2) return final(invocation, { finalAssessment: assessment({ requirements: [requirement, requirement] }) });
    if (count === 3) return final(invocation, { finalAssessment: assessment({
      requirements: [{ ...requirement, observationRefs: ['foreign-ref'] }],
    }) });
    return final(invocation, { finalAssessment: assessment({ requirements: [requirement] }) });
  } });
  const original = await (await api.submit(request({ userConstraints: [required] }))).completion;
  assert.equal(original.status, 'finished');
  assert.deepEqual(invocations.slice(1).map(item => item.context.at(-1).value.path), [
    '$.finalAssessment.author',
    '$.finalAssessment.requirements[1].requirementId',
    '$.finalAssessment.requirements[0].observationRefs[0]',
  ]);
  const ref = 'assessment:' + original.events.at(-1).eventId;
  const resumed = await api.resume(original.operationId, { requestId: 'follow', text: 'Keep the check visible.' });
  assert.equal((await resumed.completion).status, 'finished');
  const continuation = invocations.at(-1).context;
  assert.equal(continuation.find(item => item.ref === ref), undefined);
  const progress = continuation.find(item => item.ref.startsWith('assessment-progress:'));
  assert.equal(progress.source, 'model_claim');
  assert.equal(progress.provenance.sourceId, 'primary');
  assert.deepEqual(progress.value, { assessmentRef: ref, requirements: [{ requirementId: 'check', status: 'unverified' }] });
  assert.equal(continuation.find(item => item.ref === 'follow').value, 'Keep the check visible.');
});

import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { createLocalStateStore } from '../../src/adapters/state/local-store.js';
import { encodeSnapshot } from '../../src/core/snapshot.js';
import { createAuthorityGrant } from '../../src/main/index.js';
import { final, setup } from '../fixtures/application.js';
import { assessment, outcome, request } from '../fixtures/core.js';
import { withOwnedRun } from '../../scripts/owned-run.mjs';

const subject = 'target.txt';
const action = (actionId, profileId, contextRefs = []) => ({
  actionId, kind: 'delegate', profileId, objective: actionId, expectedResult: 'Report evidence', contextRefs, dependsOn: [],
});
const propose = (invocation, additions) => final(invocation, {
  additions, finalAssessment: undefined,
  waitPolicy: { kind: 'all_requested', targets: additions.map(item => ({ kind: 'action', id: item.actionId })) },
});
const finding = (findingId, author, claim, supports, extra = {}) => ({
  findingId, author, subject, claim, supports, uncertainties: [], ...extra,
});
const worker = (invocation, findings, output) => ({
  dispatchCertainty: 'sent', outcome: outcome(invocation.attemptId), findings, output,
});

test('reopened context supports a targeted check and partial assessment without rerunning investigators', async () => {
  await withOwnedRun('context-quality', async (cwd, run) => {
    const stateDir = join(cwd, 'state');
    const target = join(cwd, subject);
    await mkdir(stateDir);
    await writeFile(target, 'before');
    const store = createLocalStateStore(stateDir);
    await store.open();
    try {
      const required = 'Check the edited target and reconcile the full original output.';
      const privateRef = 'private-ref-sentinel';
      const missingRef = 'missing-ref-sentinel';
      const privateBody = 'private-output-sentinel';
      const profileIds = ['primary', 'left', 'right'];
      const authority = createAuthorityGrant({ reference: 'fixture-authority', origin: 'user', profileIds });
      const extraCatalog = profileIds.slice(1).map(profileId => ({
        kind: 'profile', value: { profileId, providerId: 'fixture', model: 'model-' + profileId },
      }));
      function checkFile(version) {
        const result = run(process.execPath, ['-e',
          'const text = require("node:fs").readFileSync("target.txt", "utf8"); if (text !== process.argv[1]) process.exit(1)',
          version], { cwd });
        assert.ifError(result.error);
        assert.equal(result.status, 0);
        return {
          kind: 'provider_tool', ref: 'check:' + version, sourceId: 'fixture-test-' + version,
          exitCode: result.status, completeness: 'complete', reportedContext: { location: subject, version },
        };
      }
      let originalArtifact;
      let beforeRef;
      let afterRef;
      let largeRef;
      let privateObservation;
      const initial = setup({
        store, authority, extraCatalog, maxInvocations: 8, maxConcurrentInvocations: 2,
        async respond(invocation, count, observe) {
          if (count === 1) return propose(invocation, [action('investigate-left', 'left'), action('investigate-right', 'right')]);
          if (invocation.actionId === 'investigate-left') {
            beforeRef = observe(checkFile('before'));
            observe({ kind: 'agent_exit', ref: 'agent:before', sourceId: 'synthetic-agent-process', exitCode: 0,
              completeness: 'complete' });
            originalArtifact = await invocation.contextAccess.captureArtifact(Buffer.from('original diagnostic output'));
            assert.ok(originalArtifact);
            largeRef = observe({ kind: 'provider_report', ref: 'large-log', sourceId: 'fixture-log', completeness: 'complete',
              value: 'x'.repeat(6500) });
            privateObservation = observe({ kind: 'provider_report', ref: privateRef, sourceId: 'fixture-private', completeness: 'complete',
              value: privateBody });
            return worker(invocation, [finding('left', 'left', 'The original check passed', ['check:before', originalArtifact])],
              'Everything passed');
          }
          if (invocation.actionId === 'investigate-right') {
            observe({ kind: 'provider_report', ref: 'right-report', sourceId: 'fixture-right', completeness: 'complete',
              value: 'The reported original outcome was a failure' });
            return worker(invocation, [finding('right', 'right', 'The original check failed', ['right-report'])]);
          }
          return final(invocation, { finalAssessment: assessment({ findingRefs: ['finding:left', 'finding:right'] }) });
        },
      });
      const original = await (await initial.api.submit(request({ userConstraints: [required], workspaceContext: { cwd } }))).completion;
      assert.equal(original.status, 'finished');
      const journal = encodeSnapshot(original);
      await store.close();
      await store.open({ maxAgeMs: 0 });
      assert.equal(encodeSnapshot(await store.load(original.operationId)), journal);
      const originalChain = await initial.api.inspectFinding(original.operationId, 'finding:left');
      assert.equal(originalChain.find(item => item.ref === originalArtifact).artifactPresence, 'retention');

      await writeFile(target, 'after');
      const selected = ['finding:left', 'finding:right', originalArtifact, missingRef, beforeRef, largeRef];
      const resumed = setup({
        store, authority, extraCatalog, idPrefix: 'quality-resume-', maxInvocations: 8, context: { maxBytes: 4096, handoffMaxBytes: 4096, fetchMaxBytes: 4096 },
        emit(event) {
          if (event.eventName.startsWith('context.')) throw new Error('synthetic sink failure');
        },
        async respond(invocation, count, observe) {
          assert.deepEqual(invocation.userConstraints, [required]);
          if (count === 1) {
            const left = await invocation.contextAccess.fetch('finding:left');
            const right = await invocation.contextAccess.fetch('finding:right');
            assert.equal(left.item.value.author, 'left');
            assert.equal(right.item.value.author, 'right');
            assert.equal(left.item.value.subject, right.item.value.subject);
            assert.equal(left.item.value.claim, 'The original check passed');
            assert.equal(right.item.value.claim, 'The original check failed');
            return propose(invocation, [action('targeted-check', 'right', selected)]);
          }
          if (invocation.actionId === 'targeted-check') {
            assert.deepEqual(invocation.context.map(item => item.ref), selected);
            assert.deepEqual(await invocation.contextAccess.fetch(originalArtifact), { kind: 'unavailable', reason: 'retention' });
            assert.deepEqual(await invocation.contextAccess.fetch(missingRef), { kind: 'unavailable', reason: 'missing' });
            assert.deepEqual(await invocation.contextAccess.fetch(privateObservation), { kind: 'unavailable', reason: 'denied' });
            assert.equal(invocation.context.at(-1).completeness, 'truncated');
            assert.ok(invocation.context.at(-1).excerpt.length < 6500);
            afterRef = observe(checkFile('after'));
            observe({ kind: 'model_summary', text: 'The targeted check passed on both recorded versions.',
              coveredObservationRefs: [beforeRef, 'check:after'] });
            return worker(invocation, [finding('targeted', 'right', 'The edited file passed the targeted check',
              ['finding:right', 'check:after'], { supersedes: 'finding:left' })]);
          }
          const current = await invocation.contextAccess.fetch(afterRef);
          const before = await invocation.contextAccess.fetch(beforeRef);
          assert.equal(current.item.reportedContext.version, 'after');
          assert.ok(before.item.receivedSequence.revision < current.item.receivedSequence.revision);
          return final(invocation, { finalAssessment: assessment({
            overall: 'partial', answer: 'The edited target passed. The complete original output is unavailable.',
            requirements: [
              { requirementId: 'target', status: 'fulfilled', observationRefs: [afterRef], findingRefs: ['finding:targeted'] },
              { requirementId: 'compare', status: 'unverified', observationRefs: [originalArtifact], findingRefs: ['finding:left', 'finding:right'],
                reason: 'Retention removed the original output bytes.' },
            ],
          }) });
        },
      });
      const continuation = await resumed.api.resume(original.operationId, { requestId: 'after-edit', text: 'The file was edited.' });
      const result = await continuation.completion;
      assert.equal(result.status, 'finished');
      assert.equal(result.assessment.overall, 'partial');
      assert.deepEqual(result.assessment.requirements.map(item => item.status), ['fulfilled', 'unverified']);
      assert.deepEqual(initial.invocations.map(item => item.kind).sort(), ['controller', 'controller', 'delegate', 'delegate']);
      assert.deepEqual(resumed.invocations.map(item => item.kind), ['controller', 'delegate', 'controller']);
      assert.equal(resumed.events.filter(event => event.eventName === 'attempt.dispatched').length, 3);

      const raw = result.events.flatMap(event => event.observations ?? []);
      assert.equal(raw.find(item => item.providerRef === 'agent:before').source, 'host_observed');
      assert.equal(raw.find(item => item.providerRef === 'agent:before').provenance.exit.kind, 'agent_exit');
      assert.deepEqual(raw.filter(item => item.provenance?.exit?.kind === 'tool_exit').map(item => item.ref), [beforeRef, afterRef]);
      assert.equal(raw.find(item => item.value === 'Everything passed').source, 'model_claim');
      const summary = raw.find(item => item.summary);
      assert.equal(summary.source, 'model_claim');
      assert.deepEqual(summary.summary.coveredObservationRefs, [beforeRef, afterRef]);
      const history = await resumed.api.inspectFinding(original.operationId, 'finding:targeted');
      assert.equal(history.find(item => item.ref === originalArtifact).artifactPresence, 'retention');
      assert.equal(history.find(item => item.ref === afterRef).recordedOutcome.terminal, 'completed');

      const handoff = resumed.invocations[1];
      const trace = resumed.events.filter(event => event.eventName.startsWith('context.'));
      assert.equal(trace.length, selected.length);
      assert.ok(trace.every(event => event.operationId === original.operationId &&
        event.actionId === handoff.actionId && event.attemptId === handoff.attemptId));
      for (const [index, event] of trace.entries()) {
        const item = handoff.context[index];
        assert.equal(event.details.selectedIndex, index);
        assert.equal(event.details.contextIndex, index);
        assert.equal(event.details.sourceRevision, item.receivedSequence?.revision);
        assert.equal(event.details.sourceIndex, item.receivedSequence?.index);
      }
      assert.equal(trace[2].reasonCode, 'ARTIFACT_REFERENCE');
      assert.equal(trace[3].eventName, 'context.unavailable');
      assert.equal(trace[3].reasonCode, 'MISSING');
      assert.equal(trace.at(-1).eventName, 'context.truncated');
      const log = JSON.stringify(resumed.events);
      for (const text of [privateRef, privateBody, missingRef, required, originalArtifact, beforeRef, afterRef, 'x'.repeat(60)]) {
        assert.ok(!log.includes(text));
      }
    } finally {
      await store.close();
    }
  });
});

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createLocalStateStore } from '../../src/adapters/state/local-store.js';
import { decodeSnapshot, encodeSnapshot } from '../../src/core/snapshot.js';
import { receiveProviderObservation } from '../../src/core/observation.js';
import { bindOutcomeEvidence, providerEvidenceRef } from '../../src/application/evidence-identity.js';
import { final, setup } from '../fixtures/application.js';
import { assessment, outcome, request } from '../fixtures/core.js';

const delegate = (invocation, actionId, contextRefs = []) => final(invocation, {
  finalAssessment: undefined,
  additions: [{ actionId, contextRefs, kind: 'delegate', profileId: 'primary', objective: actionId,
    expectedResult: 'Evidence', dependsOn: [] }],
  waitPolicy: { kind: 'all_requested', targets: [{ kind: 'action', id: actionId }] },
});
const recorded = state => state.events.flatMap(event => event.observations ?? []);

test('provider refs reused by different attempts still identify the correct historical evidence', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'role-evidence-identity-'));
  const store = createLocalStateStore(directory);
  t.after(async () => { await store.close(); await rm(directory, { recursive: true, force: true }); });
  await store.open();
  let controller = 0;
  const alias = 'check-result';
  const refs = new Map();
  const initial = setup({ store, maxInvocations: 6, async respond(invocation, count, observe) {
    if (invocation.kind === 'delegate') {
      const before = invocation.actionId === 'before';
      const report = {
        ref: alias, kind: 'provider_tool', sourceId: 'same-provider', completeness: 'complete',
        value: before ? 'FAIL before change' : 'PASS after change', exitCode: before ? 1 : 0,
      };
      const ref = observe(report);
      assert.equal(observe(report), ref);
      if (ref !== undefined) assert.equal(observe({ ...report, value: 'Conflicting duplicate' }), undefined);
      refs.set(invocation.actionId, ref ?? alias);
      observe({ ref: 'shared-source', sourceId: 'same-provider', completeness: 'complete',
        kind: before ? 'host_transport' : 'provider_tool', value: before ? 'host fact' : 'tool report' });
      return {
        dispatchCertainty: 'sent',
        outcome: outcome(invocation.attemptId, { outputRefs: [{ ref: alias, source: 'provider_reported', kind: 'tool_exit' },
          { ref: 'shared-source', source: 'host_observed', kind: 'output' }] }),
        findings: [{ findingId: invocation.actionId, author: 'primary', claim: report.value,
          subject: 'check', supports: [alias], uncertainties: [] }],
      };
    }
    if (++controller === 1) return delegate(invocation, 'before');
    if (controller === 2) return delegate(invocation, 'after', [refs.get('before')]);
    for (const [id, expected] of [['before', 'FAIL before change'], ['after', 'PASS after change']]) {
      const finding = invocation.context.find(item => item.ref === 'finding:' + id).value;
      const detail = await invocation.contextAccess.fetch(finding.supports[0]);
      assert.equal(detail.item?.value, expected);
      assert.equal(detail.item.ref, refs.get(id));
    }
    assert.deepEqual(await invocation.contextAccess.fetch(alias), { kind: 'unavailable', reason: 'missing' });
    return final(invocation, { finalAssessment: assessment({
      observationRefs: [...refs.values()], findingRefs: ['finding:before', 'finding:after'],
    }) });
  } });
  const operation = await (await initial.api.submit(request())).completion;
  assert.equal(operation.status, 'finished');
  assert.notEqual(refs.get('before'), refs.get('after'));
  assert.equal(recorded(operation).filter(item => item.providerRef === alias).length, 2);
  await store.close();
  await store.open();
  for (const id of ['before', 'after']) {
    const [, item] = await initial.api.inspectFinding(operation.operationId, 'finding:' + id);
    assert.equal(item.item.ref, refs.get(id));
    assert.equal(item.item.providerRef, alias);
    assert.equal(item.attempt.actionId, id);
    assert.equal(item.recordedOutcome.outputRefs[0].ref, item.ref);
    const sourceRef = item.recordedOutcome.outputRefs[1];
    const observed = recorded(operation).find(candidate => candidate.ref === sourceRef.ref);
    assert.equal(sourceRef.ref, providerEvidenceRef(operation.operationId, item.attempt.attemptId, 'shared-source'));
    assert.equal(sourceRef.source, id === 'before' ? 'host_observed' : 'provider_reported');
    assert.equal(sourceRef.source, observed.source);
  }

  const wire = JSON.parse(encodeSnapshot(operation));
  const receipts = wire.events.filter(event => event.observations?.some(item => item.providerRef === alias));
  receipts[1].observations.find(item => item.providerRef === alias).ref = refs.get('before');
  assert.match(decodeSnapshot(JSON.stringify(wire)).reason.path, /\.observations\[\d+\]\.ref$/);
});

test('the model discovers omitted evidence under the default budget and delegates only discovered refs', async () => {
  const location = 'reports/target.log';
  let calls = 0;
  let selectedRef;
  let access;
  const { api, invocations, respondErrors } = setup({ maxInvocations: 5, context: { controllerMaxBytes: 65536 }, async respond(invocation, count, observe) {
    if (invocation.actionId === 'collect') {
      observe({ ref: randomUUID(), kind: 'provider_tool', sourceId: 'fixture', completeness: 'complete',
        value: 'required evidence', reportedContext: { location } });
      for (let index = 0; index < 152; index++) {
        observe({ ref: randomUUID(), kind: 'provider_report', sourceId: 'fixture', completeness: 'complete',
          value: 'large payload '.repeat(200) });
      }
      return { dispatchCertainty: 'sent', outcome: outcome(invocation.attemptId) };
    }
    if (invocation.actionId === 'check') {
      const page = invocation.contextAccess.list();
      assert.deepEqual(page.items.map(item => item.ref), [selectedRef]);
      assert.equal(page.nextCursor, undefined);
      return { dispatchCertainty: 'sent', outcome: outcome(invocation.attemptId) };
    }
    if (++calls === 1) return delegate(invocation, 'collect');
    if (calls === 2) {
      assert.equal(invocation.context[1].value.historyBudget.maxBytes, 65_536);
      assert.ok(invocation.context[1].value.historyBudget.omitted > 0);
      assert.ok(!JSON.stringify(invocation.context).includes(location));
      access = invocation.contextAccess;
      let cursor;
      let pages = 0;
      const seen = new Set();
      do {
        const page = access.list(cursor);
        assert.equal(page.kind, 'available');
        assert.ok(page.items.length <= 32);
        assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 8192);
        assert.ok(!JSON.stringify(page).includes('large payload'));
        for (const item of page.items) {
          assert.ok(!seen.has(item.ref));
          seen.add(item.ref);
          if (item.reportedLocation === location) selectedRef = item.ref;
        }
        cursor = page.nextCursor;
        pages++;
      } while (cursor !== undefined && pages < 10);
      assert.ok(pages > 1 && cursor === undefined);
      assert.equal(typeof selectedRef, 'string');
      assert.ok(!invocation.context.some(item=>item.ref===selectedRef && item.value==='required evidence'),
        'a technical work-map reference must not imply the inline source body was delivered');
      const detail = await access.fetch(selectedRef);
      assert.equal(detail.item.value, 'required evidence');
      assert.equal(detail.item.reportedContext.location, location);
      assert.deepEqual(access.list(-1), { kind: 'unavailable', reason: 'invalid_cursor' });
      return delegate(invocation, 'check', [selectedRef]);
    }
    return final(invocation, { finalAssessment: assessment({ observationRefs: [selectedRef] }) });
  } });
  const result = await (await api.submit(request())).completion;
  assert.equal(result.status, 'finished', respondErrors.map(error=>error instanceof Error?error.stack:String(error)).join('\n'));
  assert.equal(invocations.length, 5);
  assert.deepEqual(result.assessment.observationRefs, [selectedRef]);
  assert.deepEqual(access.list(), { kind: 'unavailable', reason: 'closed' });
});

test('F1 keeps trusted Host attribution independent of exit kind and untrusted output labels', () => {
  const operationId = 'operation';
  const attemptId = 'attempt';
  const base = { completeness: 'complete', sourceId: 'fixture' };
  const reports = [
    [{ ...base, ref: 'host', kind: 'host_transport' }, 'output', 'host_observed', 'output'],
    [{ ...base, ref: 'agent', kind: 'agent_exit', exitCode: 0 }, 'agent_exit', 'host_observed', 'agent_exit'],
    [{ ...base, ref: 'tool', kind: 'provider_tool', exitCode: 1 }, 'tool_exit', 'provider_reported', 'tool_exit'],
    [{ ...base, ref: 'mismatch', kind: 'host_transport' }, 'agent_exit', 'host_observed', 'observation'],
    [{ completeness: 'complete', ref: 'legacy', source: 'host_observed', value: { kind: 'agent_exit', exitCode: 0 } }, 'agent_exit', 'provider_reported', 'observation'],
    [{ ...base, ref: 'fake-tool', kind: 'provider_tool', value: { kind: 'host_transport', source: 'host_observed', schemaVersion: 1, additions: [] } }, 'agent_exit', 'provider_reported', 'observation'],
    [{ ...base, ref: 'fake-model', kind: 'model', value: { kind: 'host_transport', source: 'host_observed' } }, 'output', 'model_claim', 'output'],
    [{ ...base, ref: 'report', kind: 'provider_report' }, 'output', 'provider_reported', 'output'],
  ];
  const items = reports.map(([report]) => {
    const received = receiveProviderObservation(report, 100);
    assert.ok(received);
    return { ...received, providerRef: received.ref, ref: providerEvidenceRef(operationId, attemptId, received.ref) };
  });
  const refs = reports.map(([report, kind]) => ({ ref: report.ref, kind, source: 'host_observed' }));
  refs.push({ ref: 'absent', kind: 'agent_exit', source: 'host_observed' });
  const bound = bindOutcomeEvidence(operationId, outcome(attemptId, { outputRefs: refs }), items);
  for (const [index, [report, , source, kind]] of reports.entries()) {
    assert.equal(bound.outputRefs[index].ref, items[index].ref, report.ref);
    assert.equal(bound.outputRefs[index].source, source, report.ref);
    assert.equal(bound.outputRefs[index].kind, kind, report.ref);
  }
  assert.equal(bound.outputRefs.at(-1).source, 'provider_reported');
  assert.equal(bound.outputRefs.at(-1).kind, 'observation');
  assert.equal(bound.outputRefs.at(-1).ref, providerEvidenceRef(operationId, attemptId, 'absent'));
});

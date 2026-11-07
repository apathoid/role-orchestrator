import { createAuthorityGrant, createOrchestrator } from '../../../src/main/index.js';
import { assessment, decision, outcome } from './core.js';

export function final(invocation, overrides = {}) {
  return {
    dispatchCertainty: 'sent',
    outcome: outcome(invocation.attemptId),
    output: decision({
      operationId: invocation.operationId, decisionId: 'decision-' + invocation.attemptId,
      finalAssessment: assessment({ overall: 'complete', answer: 'Direct answer' }),
      ...overrides,
    }),
  };
}

export function setup({ respond = invocation => final(invocation), open, cancel, close, store: injectedStore, maxInvocations = 3, maxConcurrentInvocations = 1, schedule, extraCatalog = [], capabilities = {}, authority, permissions } = {}) {
  const states = new Map();
  const invocations = [];
  const events = [];
  const closed = [];
  const cancellations = [];
  let sequence = 0;
  let sessionSequence = 0;
  const store = {
    async open() {},
    async close() {},
    async load(id) { return structuredClone(states.get(id)); },
    async list() { return structuredClone([...states.values()]); },
    async commit(id, revision, next) {
      if ((states.get(id)?.revision ?? null) !== revision) return { kind: 'conflict' };
      states.set(id, structuredClone(next));
      return { kind: 'committed' };
    },
  };
  const profile = { profileId: 'primary', providerId: 'fixture', model: 'fake' };
  const api = createOrchestrator({
    store: injectedStore ?? store, profile, authority: authority ?? createAuthorityGrant({
      reference: 'fixture-authority', origin: 'user', profileIds: ['primary'],
    }), configurationRef: 'test-config', permissions,
    diagnostics: { emit(event) { events.push(event); }, flush() {} },
    clock: { now: () => 100, monotonicNow: () => 100 },
    ids: { newId: () => 'id-' + ++sequence },
    limits: { maxInvocations, maxConcurrentInvocations },
    invocationTimeoutMs: 10000, schedule,
    catalog: { async list() { return [{ kind: 'profile', value: profile }, ...extraCatalog]; }, async resolve() {} },
    provider: {
      async describe() { return { providerId: 'fixture', maxConcurrency: maxConcurrentInvocations, capabilities }; },
      async open(profile, signal) {
        if (open) await open(signal);
        return { sessionId: 'session-' + ++sessionSequence };
      },
      async invoke(session, invocation, observe) {
        invocations.push(invocation);
        return respond(invocation, invocations.length, observe);
      },
      async cancel(session, attemptId) { cancellations.push(attemptId); await cancel?.(); },
      async close(session) { closed.push(session.sessionId); await close?.(); },
    },
  });
  return { api, invocations, events, closed, cancellations };
}

export function abortOnly(signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
}

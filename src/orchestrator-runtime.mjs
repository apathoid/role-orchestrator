// The host-neutral entry point for sessions and outer turns. Protocol-specific
// adapters only translate requests, present events and provide permissions.
import { createEfficiencyRun, retainEfficiencyRun, efficiencyView } from './efficiency/analytics.mjs';
import { historicalEfficiency } from './efficiency/history.mjs';
import { normalizeEfficiencyRuns } from './session-store.mjs';
import { createSessionLifecycle } from './session-lifecycle.mjs';
import { createExecutionService } from './execution-service.mjs';
import { createTurnCoordinator } from './turn-coordinator.mjs';
import { createExecutionObserver } from './observability/execution-observer.mjs';
import { routingReport } from './routing/reporting.mjs';
import { activeQuality, assessRecovery } from './quality-state.mjs';
import { executionFailureDiagnostic } from './observability/execution-diagnostics.mjs';
import {
  CANCELLATION_REASONS, abortWithReason, cancellationErrorFromSignal,
} from './cancellation.mjs';

export function createOrchestratorRuntime({ getConfig, observer = createExecutionObserver({
  onError: (error) => console.error(`[observability] ${error?.message ?? error}`),
}), ...executionOptions }) {
  const lifecycle = createSessionLifecycle({ getConfig });
  const coordinator = createTurnCoordinator();
  const observations = new Map();
  const liveEfficiency = new Map();
  const revisionSubscribers = new Map();
  const publishedRevision = new Map();
  // Only committed task state can trigger a quality revision. Failed writes
  // never publish an optimistic update and observability failures do not fail
  // the workflow that has already committed.
  const persist = async (sessionId, session) => {
    await lifecycle.persist(sessionId, session);
    const active = activeQuality(session);
    const key = active ? `${active.task.taskId}:${active.state.revision}` : null;
    if (!key || publishedRevision.get(sessionId) === key) return;
    publishedRevision.set(sessionId, key);
    try { observations.get(sessionId)?.event({ type: 'quality_revision_changed',
      taskId: active.task.taskId, revision: active.state.revision }); } catch { /* optional exporter */ }
    for (const send of revisionSubscribers.get(sessionId) ?? []) {
      try { send(); } catch { /* UI subscription cannot fail persistence */ }
    }
  };
  const execution = createExecutionService({ getConfig, persist, ...executionOptions });

  async function projectCurrentView(sessionId, view) {
    if (!view || view.historicalSnapshot) return view;
    const session = lifecycle.sessions.get(sessionId);
    if (!session) return view;
    const quality = activeQuality(session);
    if (!quality) return view;
    const q = quality.state;
    return { ...view, quality: {
      taskId: quality.task.taskId, revision: q.revision,
      evidenceCount: q.evidence.length,
      openFindings: q.findings.filter((f) => f.lifecycle !== 'resolved').length,
      pendingDecisions: q.decisions.filter((d) => d.status === 'pending').length,
      recovery: await assessRecovery(quality.task, session.repoRoot),
    } };
  }

  function qualityListener(sessionId, listener) {
    let closed = false;
    let tail = Promise.resolve();
    let previous = null;
    const send = (view = null) => {
      tail = tail.catch(() => {}).then(async () => {
        if (closed) return;
        const current = view ?? await observer.getView(sessionId, { session: lifecycle.sessions.get(sessionId) });
        if (!current) return;
        const latest = await observer.getView(sessionId, { session: lifecycle.sessions.get(sessionId) });
        if (!latest || (latest.runId !== current.runId && latest.startedAt > current.startedAt)) return;
        const enriched = await projectCurrentView(sessionId, current);
        const signature = `${current.runId}:${current.lastSequence}:${enriched.quality?.taskId ?? ''}:${enriched.quality?.revision ?? ''}`;
        if (signature === previous || closed) return;
        previous = signature;
        listener(enriched);
      }).catch(() => { /* do not crash workflow on host callback failure */ });
    };
    const set = revisionSubscribers.get(sessionId) ?? new Set();
    set.add(send); revisionSubscribers.set(sessionId, set);
    return { send, close: () => {
      closed = true; set.delete(send);
      if (!set.size) revisionSubscribers.delete(sessionId);
    } };
  }

  async function runTurn({ sessionId, signal: hostSignal, onStarted, ...options }) {
    // Snapshot/cancellation provenance is retained even when the queued turn
    // never gets to start. Host cancellation cannot evict an unrelated session.
    const controller = new AbortController();
    const onCancelled = () => abortWithReason(controller,
      CANCELLATION_REASONS.CLIENT_REQUEST_CANCELLED,
      { source: 'client_request', diagnostics: { sessionId } });
    hostSignal?.addEventListener('abort', onCancelled, { once: true });
    if (hostSignal?.aborted) onCancelled();
    const observation = observer.begin(sessionId);
    const efficiency = createEfficiencyRun(observation.runId);
    const reservation = coordinator.reserve(sessionId, controller);
    let activated = false, executionCommitted = false;
    try {
      await reservation.wait;
      if (controller.signal.aborted) throw cancellationErrorFromSignal(controller.signal);
      reservation.activate();
      activated = true;
      liveEfficiency.set(sessionId, efficiency);
      observations.set(sessionId, observation);
      observation.running();
      await onStarted?.();
      if (controller.signal.aborted) throw cancellationErrorFromSignal(controller.signal);
      const session = options.session ?? lifecycle.sessions.get(sessionId);
      if (!session) throw new Error(`Unknown session: ${sessionId}`);
      const reporter = options.reporter;
      const observedReporter = async (event) => {
        // Observation cannot delay native ACP presentation or provider streaming.
        // Native updates are not copied into the persisted trace.
        efficiency.onEvent(event);
        // Context composition counters belong to P3 telemetry, not to the
        // P1 execution trace or host presentation event stream.
        if (['role_context_profile','role_provider_prompt_profile','role_activity'].includes(event?.type)) return;
        if (event?.type === 'role_router_context') { observation.event(event); return; }
        observation.event(event?.type === 'role_start' ? {...event,presetId:session.selectedProfile??null} : event);
        if (typeof reporter === 'function') await reporter(event);
      };
      if (reporter?.permission) observedReporter.permission = reporter.permission;
      const value = await execution.execute({
        ...options, sessionId, session, signal: controller.signal, reporter: observedReporter,
        onBeforeCommit: async (target, result, selectedTaskId) => {
          retainEfficiencyRun(target, efficiency.finish({ status: result?.status ?? 'unknown', taskId: selectedTaskId, presetId: target.selectedProfile, result }));
        },
      });
      executionCommitted = true;
      await observation.finish({ status: 'completed', resultStatus: value.result?.status, committed: true });
      return value;
    } catch (error) {
      const cancelled = Boolean(controller.signal.aborted || error?.cancellationReason);
      const durableSession = options.session ?? lifecycle.sessions.get(sessionId);
      if (durableSession && activated && !executionCommitted) {
        try {
          retainEfficiencyRun(durableSession, efficiency.finish({ status: cancelled ? 'cancelled' : 'failed',
            taskId: null, presetId: durableSession.selectedProfile }));
          await lifecycle.persist(sessionId, durableSession);
        } catch { /* optional efficiency cannot replace the original error */ }
      }
      await observation.finish({
        status: cancelled ? 'cancelled' : 'failed',
        ...executionFailureDiagnostic(error, { cancelled }),
      });
      throw error;
    } finally {
      hostSignal?.removeEventListener('abort', onCancelled);
      if (observations.get(sessionId) === observation) observations.delete(sessionId);
      if (liveEfficiency.get(sessionId) === efficiency) liveEfficiency.delete(sessionId);
      reservation.release();
    }
  }

  return {
    sessions: lifecycle.sessions,
    getEfficiencyView: (sessionId) => {
      const session = lifecycle.sessions.get(sessionId);
      const live = liveEfficiency.get(sessionId);
      return efficiencyView(live ? { efficiencyRuns: [...(session?.efficiencyRuns ?? []), live.finish({ status: 'running' })], efficiencyTelemetryTruncated: session?.efficiencyTelemetryTruncated === true } : session);
    },
    getEfficiencyRunIndex: (sessionId) => {
      const session = lifecycle.sessions.get(sessionId);
      const live = liveEfficiency.get(sessionId);
      const rows = normalizeEfficiencyRuns([...(session?.efficiencyRuns ?? []),
        ...(live ? [live.finish({ status: 'running' })] : [])]);
      return [...new Map(rows.map(r => [r.runId, r])).values()]
        .map(r => ({ runId: r.runId, status: r.status, outcome: r.outcome?.category ?? 'unknown', executionGroupId:r.executionGroupId, completedAt: r.completedAt, invocations: r.invocations.length }));
    },
    getEfficiencyReport: (sessionId, runId = null) => {
      const session = lifecycle.sessions.get(sessionId);
      const live = liveEfficiency.get(sessionId);
      const rows = normalizeEfficiencyRuns([
        ...(session?.efficiencyRuns ?? []),
        ...(live ? [live.finish({ status: 'running' })] : []),
      ]);
      const runs = [...new Map(rows.map(r => [r.runId, r])).values()];
      // Existing run IDs are opaque, not paths. Never expose raw session state.
      const selected = runId ? runs.filter(run => run.runId === runId) : runs.slice(-1);
      return { version: 1, scope: 'session', retainedRuns: runs.length, truncated: session?.efficiencyTelemetryTruncated === true, runs: selected,
        note: 'Prepared prompt characters are not model tokens; provider-added context is unknown. Context occupancy snapshots are not cumulative input usage.' };
    },
    getEfficiencyHistory: (sessionId) => historicalEfficiency(lifecycle.sessions.get(sessionId)?.repoRoot, { enabled: process.env.AGENT_P3_HISTORY === '1' }),
    createSession: lifecycle.create,
    restoreSession: lifecycle.restore,
    persistSession: persist,
    runTurn,
    cancelSession: coordinator.cancel,
    resolveQualityDecision: (sessionId, session, selection) => {
      if (coordinator.isBusy(sessionId)) throw new Error('Cannot resolve a decision while a workflow is active.');
      return execution.decide(sessionId, session, selection);
    },
    getExecutionView: async (sessionId, runId = null) => {
      const session = lifecycle.sessions.get(sessionId) ?? null;
      const view = await observer.getView(sessionId, { runId, session });
      return runId ? view : projectCurrentView(sessionId, view);
    },
    getExecutionTrace: (sessionId, options = {}) => observer.getTrace(sessionId, options),
    getRoutingReport: (sessionId, options = {}) => routingReport({observer,sessionId,...options}),
    listExecutionRuns: (sessionId, options = {}) => observer.listRuns(sessionId, options),
    subscribeExecution: (sessionId, listener) => {
      const feed = qualityListener(sessionId, listener);
      const unsubscribe = observer.subscribe(sessionId, feed.send);
      return () => { unsubscribe(); feed.close(); };
    },
    watchExecution: async (sessionId, listener) => {
      const feed = qualityListener(sessionId, listener);
      try {
        const unsubscribe = await observer.watchWithSnapshot(sessionId, feed.send, {
          getSession: () => lifecycle.sessions.get(sessionId) ?? null,
        });
        return () => { unsubscribe(); feed.close(); };
      } catch (error) { feed.close(); throw error; }
    },
  };
}

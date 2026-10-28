// Durable, host-neutral ownership of implementation Plans and their checkpoints.
// A conversation may contain several tasks; session-level legacy fields are
// compatibility aliases for the active task, never independent sources of truth.
import { randomUUID } from 'node:crypto';

const PLAN_VERSION = 1;
const TASK_VERSION = 1;
const MAX_TASKS = 100; // Fail closed rather than silently evict resumable work.

function validPlan(value) {
  return value?.version === PLAN_VERSION && typeof value.planId === 'string' &&
    value.planId.length > 0 && value.plan && typeof value.plan === 'object';
}

function validCheckpoint(value) {
  return value?.version === 1 && typeof value.planId === 'string';
}

export function ensureImplementationTasks(session) {
  if (!Array.isArray(session.implementationTasks)) session.implementationTasks = [];
  if (!session.implementationTasks.length && (validPlan(session.implementationPlan) || validCheckpoint(session.implementationCheckpoint))) {
    // Migrate pre-registry sessions without losing or inventing evidence. A
    // legacy orphan (or checkpoint with a DIFFERENT Plan ID) stays accessible
    // for diagnosis, never attached to a newer implementation by accident.
    const plan = validPlan(session.implementationPlan) ? session.implementationPlan : null;
    const checkpoint = validCheckpoint(session.implementationCheckpoint) ? session.implementationCheckpoint : null;
    const matches = plan && (!checkpoint || checkpoint.planId === plan.planId);
    if (checkpoint && !matches) session.implementationTasks.push({
      version: TASK_VERSION, taskId: randomUUID(), plan: null, checkpoint,
      reconciliation: null, createdAt: new Date().toISOString(), origin: 'legacy_orphan',
    });
    if (plan) session.implementationTasks.push({
      version: TASK_VERSION, taskId: randomUUID(), plan,
      checkpoint: matches ? checkpoint : null,
      reconciliation: matches ? session.implementationReconciliation ?? null : null,
      createdAt: new Date().toISOString(), origin: 'legacy',
    });
    session.activeImplementationTaskId = session.implementationTasks.at(-1).taskId;
    const active = session.implementationTasks.at(-1);
    session.implementationPlan = active.plan;
    session.implementationCheckpoint = active.checkpoint;
    session.implementationReconciliation = active.reconciliation;
  }

  if (session.activeImplementationTaskId && !session.implementationTasks.some((task) => task.taskId === session.activeImplementationTaskId)) {
    session.activeImplementationTaskId = null;
  }
  const selected = session.implementationTasks.find((task) => task.taskId === session.activeImplementationTaskId);
  if (selected) {
    // Legacy aliases are projections of the selected task. Never let a stale
    // alias make /checkpoint or other readers display another task's state.
    session.implementationPlan = selected.plan ?? null;
    session.implementationCheckpoint = selected.checkpoint ?? null;
    session.implementationReconciliation = selected.reconciliation ?? null;
  }
  return session.implementationTasks;
}

export function activeImplementationTask(session) {
  return ensureImplementationTasks(session).find((task) => task.taskId === session.activeImplementationTaskId) ?? null;
}

export function selectImplementationTask(session, taskId) {
  const entry = ensureImplementationTasks(session).find((task) => task.taskId === taskId);
  if (!entry || !validPlan(entry.plan)) throw new Error('Requested implementation task has no saved structured Plan; no coder was run.');
  session.activeImplementationTaskId = entry.taskId;
  session.implementationPlan = entry.plan;
  session.implementationCheckpoint = entry.checkpoint ?? null;
  session.implementationReconciliation = entry.reconciliation ?? null;
  return entry;
}

export function registerImplementationPlan(session, plan, { origin = 'change' } = {}) {
  if (!validPlan(plan)) throw new Error('Cannot save an invalid structured implementation Plan.');
  const tasks = ensureImplementationTasks(session);
  if (tasks.length >= MAX_TASKS) throw new Error('Implementation task archive is full. Export older tasks before creating another; nothing was discarded.');
  const entry = {
    version: TASK_VERSION, taskId: randomUUID(), plan, checkpoint: null,
    reconciliation: null, createdAt: new Date().toISOString(), origin,
  };
  tasks.push(entry);
  selectImplementationTask(session, entry.taskId);
  return entry;
}

export function updateActiveImplementationTask(session, field, value) {
  const entry = activeImplementationTask(session);
  if (!entry) throw new Error(`Cannot save ${field}: there is no active implementation task.`);
  if (field === 'checkpoint') {
    if (!validPlan(entry.plan) || (value && value.planId !== entry.plan.planId)) {
      throw new Error('Checkpoint does not belong to the selected implementation Plan; nothing was replaced.');
    }
    entry.checkpoint = value;
    session.implementationCheckpoint = value;
  } else if (field === 'reconciliation') {
    if (!validPlan(entry.plan) || (value && value.planId !== entry.plan.planId)) {
      throw new Error('Reconciliation does not belong to the selected implementation Plan; nothing was replaced.');
    }
    entry.reconciliation = value;
    session.implementationReconciliation = value;
  } else if (field === 'plan') {
    if (!validPlan(value) || value.planId !== entry.plan?.planId) {
      throw new Error('Cannot replace a task Plan with a different identity during reconciliation.');
    }
    entry.plan = value;
    session.implementationPlan = value;
  } else throw new Error(`Unknown implementation task field: ${field}`);
}

// Compatibility helper for legacy callers: accepts only a validated typed
// operation reference, never parses language for IDs.
export function implementationTaskReference(taskSpec) {
  return taskSpec && typeof taskSpec === 'object' &&
    ['current_implementation','saved_implementation'].includes(taskSpec.continuation?.mode)
    ? taskSpec.continuation?.operationId ?? null : null;
}

export function findImplementationTask(session, reference) {
  const matches = ensureImplementationTasks(session).filter((task) =>
    task.plan && [task.taskId, task.plan.planId].some((id) => id?.toLowerCase().startsWith(reference)));
  if (matches.length !== 1) throw new Error(matches.length
    ? `Implementation task ID '${reference}' is ambiguous; specify a full taskId.`
    : `Implementation task '${reference}' was not found in this session. No coder was run.`);
  return matches[0];
}

export function implementationTaskSummaries(session) {
  return ensureImplementationTasks(session).map((task) => ({
    taskId: task.taskId,
    planId: task.plan?.planId ?? task.checkpoint?.planId ?? null,
    goal: task.plan?.plan?.goal ?? null,
    status: task.checkpoint?.status ?? (task.plan ? 'planned' : 'orphaned_checkpoint'),
    completedStages: task.checkpoint?.completedStages ?? [],
    active: task.taskId === session.activeImplementationTaskId,
    origin: task.origin,
  }));
}

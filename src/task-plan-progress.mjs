import { cleanPlanStep } from './implementation-stages.mjs';
const VALID_STATUSES = new Set(['pending', 'in_progress', 'completed']);

function cleanStepText(value) {
  return String(value ?? '').trim();
}

export function buildTaskPlanProgressContract(taskPlan, {
  mechanism = 'native plan/progress mechanism',
} = {}) {
  if (!Array.isArray(taskPlan) || taskPlan.length === 0) return '';
  const steps = taskPlan.map((step, index) => `${index + 1}. ${cleanPlanStep(cleanStepText(step))}`);
  return `\n\nTASK PLAN PROGRESS CONTRACT:\nA grounded task plan already exists with exactly ${taskPlan.length} ordered steps:\n${steps.join('\n')}\nTreat this as the authoritative progress checklist shown to the user. Use the ${mechanism} whenever it is available and publish status updates while you work; do not wait until the final answer to report progress.\n- Keep exactly ${taskPlan.length} items in the same order. Do not merge, split, reorder, remove, or invent steps.\n- Keep each item semantically aligned with the corresponding numbered step. You may shorten labels because the outer UI preserves the planner's original text.\n- Use only pending, in_progress, and completed statuses. While work is active, the current step should be in_progress, earlier finished steps completed, and future steps pending.\n- Before advancing, mark the current step completed and the next step in_progress. Completed steps must not regress.\n- Your first progress snapshot should mark the first unfinished step in_progress rather than leaving every step pending.\nIf the native mechanism cannot represent this checklist exactly, do not replace it with a different plan; continue the task and let the orchestrator keep the last valid outer-plan snapshot.`;
}

function providerStatuses(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return { ok: false, reason: 'empty_snapshot' };
  }

  const statuses = [];
  let hasExplicitStatus = false;
  for (let index = 0; index < items.length; index++) {
    const item = items[index] ?? {};
    if (Object.prototype.hasOwnProperty.call(item, 'status') && item.status != null) {
      hasExplicitStatus = true;
      if (!VALID_STATUSES.has(item.status)) {
        return { ok: false, reason: 'invalid_status', index, status: item.status };
      }
      statuses.push(item.status);
    } else if (item.completed === true) {
      statuses.push('completed');
    } else {
      statuses.push(null);
    }
  }

  // Older Codex CLI todo-list events expose only `completed`. Preserve their
  // sequential semantics by treating the first unfinished item as active.
  if (!hasExplicitStatus) {
    const firstIncomplete = statuses.findIndex((status) => status !== 'completed');
    if (firstIncomplete === -1) return { ok: true, statuses: statuses.map(() => 'completed'), source: 'legacy_completed' };
    return {
      ok: true,
      statuses: statuses.map((status, index) => status === 'completed'
        ? 'completed'
        : index === firstIncomplete
          ? 'in_progress'
          : 'pending'),
      source: 'legacy_completed',
    };
  }

  // Mixed events are tolerated for compatibility: explicit provider status is
  // authoritative; legacy `completed: true` remains usable for other entries.
  const hasExplicitInProgress = statuses.includes('in_progress');
  let inferredActive = hasExplicitInProgress;
  for (let index = 0; index < statuses.length; index++) {
    if (statuses[index] != null) continue;
    if (!inferredActive) {
      statuses[index] = 'in_progress';
      inferredActive = true;
    } else {
      statuses[index] = 'pending';
    }
  }
  return { ok: true, statuses, source: 'status' };
}

function validateOrderedStatuses(statuses) {
  const inProgressCount = statuses.filter((status) => status === 'in_progress').length;
  if (inProgressCount > 1) return { ok: false, reason: 'multiple_in_progress' };

  let phase = 'completed';
  for (let index = 0; index < statuses.length; index++) {
    const status = statuses[index];
    if (phase === 'completed') {
      if (status === 'in_progress') phase = 'in_progress';
      else if (status === 'pending') phase = 'pending';
    } else if (phase === 'in_progress') {
      if (status === 'completed') return { ok: false, reason: 'non_monotonic_order', index };
      if (status === 'pending') phase = 'pending';
    } else if (status !== 'pending') {
      return { ok: false, reason: 'non_monotonic_order', index };
    }
  }
  return { ok: true };
}

export function reconcileTaskPlanProgress(currentPlan, items) {
  if (!Array.isArray(currentPlan) || currentPlan.length === 0) {
    return { ok: false, reason: 'no_outer_plan' };
  }
  if (!Array.isArray(items) || items.length === 0) {
    return { ok: false, reason: 'empty_snapshot' };
  }
  if (items.length !== currentPlan.length) {
    return {
      ok: false,
      reason: 'item_count_mismatch',
      expected: currentPlan.length,
      actual: items.length,
    };
  }

  const parsed = providerStatuses(items);
  if (!parsed.ok) return parsed;
  const incoming = parsed.statuses;

  // Some providers emit an initial all-pending plan immediately after role
  // start. The outer reporter has already marked the first step in progress;
  // do not regress that useful state because of a stale initialization frame.
  if (incoming.every((status) => status === 'pending')
      && currentPlan.some((step) => step.status !== 'pending')) {
    return { ok: true, changed: false, plan: currentPlan, ignored: 'stale_all_pending' };
  }

  for (let index = 0; index < currentPlan.length; index++) {
    const before = currentPlan[index]?.status;
    const after = incoming[index];
    if (before === 'completed' && after !== 'completed') {
      return { ok: false, reason: 'completed_regression', index, before, after };
    }
    if (before === 'in_progress' && after === 'pending') {
      return { ok: false, reason: 'active_regression', index, before, after };
    }
  }

  const ordered = validateOrderedStatuses(incoming);
  if (!ordered.ok) return ordered;

  const plan = currentPlan.map((step, index) => ({ ...step, status: incoming[index] }));
  const changed = plan.some((step, index) => step.status !== currentPlan[index]?.status);
  return { ok: true, changed, plan, source: parsed.source };
}

export function taskPlanProgressDiagnostic(result) {
  if (!result || result.ok) return null;
  switch (result.reason) {
    case 'item_count_mismatch':
      return `expected ${result.expected} items, received ${result.actual}`;
    case 'invalid_status':
      return `item ${Number(result.index) + 1} has unsupported status ${JSON.stringify(result.status)}`;
    case 'multiple_in_progress':
      return 'received more than one in_progress item for an ordered task plan';
    case 'non_monotonic_order':
      return `received non-sequential statuses near item ${Number(result.index) + 1}`;
    case 'completed_regression':
      return `item ${Number(result.index) + 1} attempted to regress from completed to ${result.after}`;
    case 'active_regression':
      return `item ${Number(result.index) + 1} attempted to regress from in_progress to pending`;
    case 'empty_snapshot':
      return 'received an empty progress snapshot';
    case 'no_outer_plan':
      return 'received progress without an outer task plan';
    default:
      return `rejected progress snapshot (${String(result.reason ?? 'unknown reason')})`;
  }
}

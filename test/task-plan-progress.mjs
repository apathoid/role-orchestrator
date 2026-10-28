import assert from 'node:assert/strict';
import {
  buildTaskPlanProgressContract,
  reconcileTaskPlanProgress,
  taskPlanProgressDiagnostic,
} from '../src/task-plan-progress.mjs';

const contract = buildTaskPlanProgressContract(['Inspect behavior', 'Implement change', 'Verify result'], {
  mechanism: 'Codex native plan/progress mechanism',
});
assert.match(contract, /exactly 3 ordered steps/);
assert.match(contract, /do not wait until the final answer/i);
assert.match(contract, /first unfinished step in_progress/i);
assert.match(contract, /Completed steps must not regress/i);
assert.equal(buildTaskPlanProgressContract([]), '');

const base = [
  { content: 'Inspect behavior', status: 'in_progress', priority: 'medium' },
  { content: 'Implement change', status: 'pending', priority: 'medium' },
  { content: 'Verify result', status: 'pending', priority: 'medium' },
];

let result = reconcileTaskPlanProgress(base, [
  { text: 'Inspect', status: 'completed' },
  { text: 'Implement', status: 'in_progress' },
  { text: 'Verify', status: 'pending' },
]);
assert.equal(result.ok, true);
assert.equal(result.changed, true);
assert.deepEqual(result.plan.map((step) => step.status), ['completed', 'in_progress', 'pending']);
assert.deepEqual(result.plan.map((step) => step.content), base.map((step) => step.content), 'planner-authored text stays authoritative');

result = reconcileTaskPlanProgress(result.plan, [
  { text: 'Inspect', status: 'completed' },
  { text: 'Implement', status: 'completed' },
  { text: 'Verify', status: 'in_progress' },
]);
assert.deepEqual(result.plan.map((step) => step.status), ['completed', 'completed', 'in_progress']);

result = reconcileTaskPlanProgress(result.plan, [
  { text: 'Inspect', status: 'completed' },
  { text: 'Implement', status: 'completed' },
  { text: 'Verify', status: 'completed' },
]);
assert.deepEqual(result.plan.map((step) => step.status), ['completed', 'completed', 'completed']);

// Legacy todo-list events expose only completed booleans.
result = reconcileTaskPlanProgress(base, [
  { text: 'Inspect', completed: true },
  { text: 'Implement', completed: false },
  { text: 'Verify', completed: false },
]);
assert.equal(result.ok, true);
assert.deepEqual(result.plan.map((step) => step.status), ['completed', 'in_progress', 'pending']);

// An initial all-pending native snapshot must not erase the role_start marker.
result = reconcileTaskPlanProgress(base, [
  { status: 'pending' }, { status: 'pending' }, { status: 'pending' },
]);
assert.equal(result.ok, true);
assert.equal(result.changed, false);
assert.equal(result.ignored, 'stale_all_pending');
assert.deepEqual(result.plan.map((step) => step.status), ['in_progress', 'pending', 'pending']);

result = reconcileTaskPlanProgress(base, [{ status: 'in_progress' }, { status: 'pending' }]);
assert.equal(result.ok, false);
assert.equal(result.reason, 'item_count_mismatch');
assert.match(taskPlanProgressDiagnostic(result), /expected 3 items, received 2/);

result = reconcileTaskPlanProgress(base, [
  { status: 'completed' }, { status: 'in_progress' }, { status: 'in_progress' },
]);
assert.equal(result.ok, false);
assert.equal(result.reason, 'multiple_in_progress');

result = reconcileTaskPlanProgress([
  { ...base[0], status: 'completed' }, base[1], base[2],
], [
  { status: 'in_progress' }, { status: 'pending' }, { status: 'pending' },
]);
assert.equal(result.ok, false);
assert.equal(result.reason, 'completed_regression');

result = reconcileTaskPlanProgress(base, [
  { status: 'pending' }, { status: 'in_progress' }, { status: 'pending' },
]);
assert.equal(result.ok, false);
assert.equal(result.reason, 'active_regression');

result = reconcileTaskPlanProgress(base, [
  { status: 'completed' }, { status: 'bogus' }, { status: 'pending' },
]);
assert.equal(result.ok, false);
assert.equal(result.reason, 'invalid_status');

console.log('task-plan-progress: passed');

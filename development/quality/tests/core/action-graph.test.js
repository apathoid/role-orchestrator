import assert from 'node:assert/strict';
import { test } from 'node:test';
import { admitActions, pendingDependencies } from '../../../../src/core/action-graph.js';

const action = (actionId, refs = []) => ({
  actionId, kind: 'delegate', objective: actionId, profileId: 'profile',
  contextRefs: [], expectedResult: 'report', dependsOn: refs.map(ref => ({
    actionId: ref[0], kind: ref[1] ?? 'after_terminal',
  })),
});

test('a diamond admits out-of-order nodes and respects two distinct dependency modes', () => {
  const origin = action('a');
  const left = action('b', [['a']]);
  const right = action('c', [['a', 'after_model_acceptance']]);
  const join = action('d', [['b'], ['c']]);
  assert.deepEqual(admitActions([], [join, right, origin, left]).map(item => item.kind), [
    'accepted', 'accepted', 'accepted', 'accepted',
  ]);
  assert.deepEqual(pendingDependencies(left, new Set(['a']), new Set()), []);
  assert.deepEqual(pendingDependencies(right, new Set(['a']), new Set()), right.dependsOn);
  assert.deepEqual(pendingDependencies(right, new Set(['a']), new Set(['a'])), []);
  assert.deepEqual(pendingDependencies(join, new Set(['b']), new Set()), [join.dependsOn[1]]);
});

test('a cycle and unknown references reject only affected actions', () => {
  const result = admitActions([], [
    action('cycle-1', [['cycle-2']]), action('cycle-2', [['cycle-1']]), action('good'),
    action('bad', [['unknown']]), action('downstream', [['bad']]),
  ]);
  assert.deepEqual(result.map(item => item.kind === 'rejected' ? item.reason : item.kind),
    ['cyclic_dependency', 'cyclic_dependency', 'accepted', 'unknown_dependency', 'unavailable_dependency']);
  assert.equal(result[3].dependencyId, 'unknown');
  assert.equal(result[4].dependencyId, 'bad');
});

test('action identity redelivery neither replaces the original nor invalidates its dependents', () => {
  const original = action('a');
  assert.deepEqual(admitActions([original], [action('a')]), [{ kind: 'duplicate', actionId: 'a' }]);
  const [conflict, dependent] = admitActions([original], [{ ...original, objective: 'replacement' }, action('b', [['a']])]);
  assert.equal(conflict.code, 'IDENTITY_CONFLICT');
  assert.equal(dependent.kind, 'accepted');
  assert.equal(original.objective, 'a');
});

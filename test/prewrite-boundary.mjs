import assert from 'node:assert/strict';
import { assessPreWriteBoundary, assertPreWriteBoundary } from '../src/execution/task-write-policy.mjs';
import { emptyTaskSpec } from '../src/routing/task-spec.mjs';

const change = emptyTaskSpec('change','explicit');
const withConstraints = (scope, exclusions = []) => ({ ...change, constraints: {
  ...change.constraints, writeScope: scope, excludedPaths: exclusions,
}});
const restricted = [withConstraints('tests_only'), withConstraints('production_only'),
  withConstraints('combined',['src/secrets']), withConstraints('unspecified',['src/secrets'])];
for (const task of restricted) {
  const result = assessPreWriteBoundary([task]);
  assert.equal(result.accepted, false, 'provider-owned tools cannot promise path interception');
  assert.equal(result.enforcement, 'NOT_ENFORCEABLE');
  assert.throws(() => assertPreWriteBoundary([task]), {code:'WRITE_AUTHORIZATION_BOUNDARY_UNAVAILABLE'});
}
assert.equal(assessPreWriteBoundary([change]).accepted, true, 'compatibility for unrestricted change');
assert.equal(assessPreWriteBoundary([change,emptyTaskSpec('plan')]).accepted,true,'a saved Plan constrains paths but is not the new write authorization');
assert.equal(assessPreWriteBoundary([null,change]).accepted,false,'a saved plan alone does not authorize a write');
assert.equal(assessPreWriteBoundary([change]).enforcement,'NO_PER_PATH_ENFORCEMENT');
assert.equal(assessPreWriteBoundary([]).accepted, false, 'missing authorization fails closed');
assert.equal(assessPreWriteBoundary([emptyTaskSpec()]).accepted, false);
assert.equal(assessPreWriteBoundary([change,restricted[0]]).accepted, false,
  'a saved Plan restriction cannot be broadened by a new Task Spec');
assert.equal(assessPreWriteBoundary([restricted[0],change]).accepted, false);
assert.equal(assessPreWriteBoundary([restricted[0]],{sandboxMode:'read-only'}).accepted,true,
  'read-only analysis may still proceed');
for (const mode of ['', 'danger-full-access', 'workspace-write ', 'unknown']) {
  const decision = assessPreWriteBoundary([change], { sandboxMode: mode });
  assert.deepEqual(decision, { accepted:false, enforcement:'NOT_ENFORCEABLE', reason:'unsupported_sandbox_mode' });
  assert.throws(() => assertPreWriteBoundary([change], { sandboxMode: mode }),
    { code:'WRITE_AUTHORIZATION_BOUNDARY_UNAVAILABLE', reasonCode:'unsupported_sandbox_mode' });
}
assert.equal(assessPreWriteBoundary([change,{...change,writeIntent:'ambiguous'}]).accepted,true);
assert.equal(assessPreWriteBoundary([change,{...change,constraints:{...change.constraints,writeScope:'invalid'}}]).accepted,false);
console.log('prewrite-boundary: PASS');

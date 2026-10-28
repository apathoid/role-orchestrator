import assert from 'node:assert/strict';
import { assessPreWriteBoundary, assertPreWriteBoundary, assessTaskWriteScope, assertTaskWriteScope } from '../src/execution/task-write-policy.mjs';
import { emptyTaskSpec } from '../src/routing/task-spec.mjs';
import { canonicalTaskPath } from '../src/routing/task-path.mjs';

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
assert.equal(assessPreWriteBoundary([change, null]).accepted, true,
  'absent saved Plan remains optional');
for (const specs of [
  [{...change, constraints: {...change.constraints, excludedPaths: undefined}}],
  [change, {...change, constraints: {...change.constraints, excludedPaths: undefined}}],
  [{...change, target: {kind:'none', selector: {type:'worktree'}}}],
  [{...change, constraints: {...change.constraints, excludedPaths: ['src/../secret']}}],
  [{...change, writeIntent: 'not_requested'}],
]) {
  const decision = assessPreWriteBoundary(specs);
  assert.equal(decision.accepted, false, 'malformed or unauthorized Task Spec must not reach provider');
  assert.throws(() => assertPreWriteBoundary(specs),
    { code:'WRITE_AUTHORIZATION_BOUNDARY_UNAVAILABLE' });
}
const ambiguous = {...change, ambiguities:['uncertain user intent']};
assert.equal(assessPreWriteBoundary([ambiguous]).reason,'ambiguous_write_authorization');
assert.equal(assessPreWriteBoundary([change, {...emptyTaskSpec('plan'), ambiguities:['saved plan caveat']}]).accepted,true,
  'a saved Plan ambiguity is context, not current user authorization');

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
assert.equal(assessPreWriteBoundary([change,{...change,writeIntent:'ambiguous'}]).accepted,false,
  'a malformed saved Task Spec must fail closed instead of silently being ignored');
assert.equal(assessPreWriteBoundary([change,{...change,constraints:{...change.constraints,writeScope:'invalid'}}]).accepted,false);

for (const forbidden of ['./src/private', 'src//private', 'src/./private',
  'src/private/', 'src/.GIT/config', 'src/../private']) {
  const malformed = { ...change, constraints: { ...change.constraints, excludedPaths:[forbidden] }};
  assert.deepEqual(assessPreWriteBoundary([malformed]),
    { accepted:false, enforcement:'NOT_ENFORCEABLE', reason:'invalid_task_authorization' },
    'noncanonical exclusion ' + forbidden + ' must not reach a writable invocation');
}
const inScope = withConstraints('combined',['src/secret']);
assert.equal(assessTaskWriteScope(['src/secret/item.txt'],inScope).accepted,false);
assert.equal(assessTaskWriteScope(['SRC/SECRET/item.txt'],inScope).violations[0].reason,
  'explicit_exclusion', 'case-insensitive audit is conservative on case-folding hosts');
assert.equal(assessTaskWriteScope(['src/secretary/item.txt'],inScope).accepted,true,
  'an exclusion must match complete path components, not substrings');
for (const changed of ['src//secret/item.txt','src/.GIT/config','src/./secret.txt','C:/windows/file']) {
  assert.equal(assessTaskWriteScope([changed],change).violations[0].reason,'unsafe_path');
}
for (const exclusion of ['./src/secret','src//secret','src/.GIT/config']) {
  assert.throws(() => assessTaskWriteScope(['src/secret/item.txt'],
    withConstraints('combined',[exclusion])),/invalid_task_write_paths/);
}
assert.throws(() => assertTaskWriteScope(['SRC/SECRET/file'],inScope),
  {code:'TASK_WRITE_SCOPE_VIOLATION'});

// Host-specific path aliases and control characters must never be treated as
// safe post-write evidence. These cannot establish a trusted pre-write sandbox.
for (const unsafe of ['src/a\\nb', 'src/a\\tb', 'src/a\\rb', 'src/CON',
  'src/aux.txt', 'src/file.', 'src/file ', 'src/file:stream',
  'src/' + 'a'.repeat(241), 'src/one?two']) {
  assert.equal(assessTaskWriteScope([unsafe],change).violations[0]?.reason,
    'unsafe_path', 'unsafe post-write path: ' + JSON.stringify(unsafe));
  assert.throws(() => assessTaskWriteScope(['src/ok'],withConstraints('combined',[unsafe])),
    /invalid_task_write_paths/, 'unsafe exclusion: ' + JSON.stringify(unsafe));
}
assert.equal(assessTaskWriteScope(['src/valid-file.ts'],change).accepted,true);
// The same canonical predicate must drive both typed authorization and audit.
for (const candidate of ['src/valid-file.ts', 'tests/example.test.mjs', 'docs/README.md',
  'src/aux.txt', 'src/CON', 'src/name.', 'src/../escape',
  'src//file', 'src/.git/config', 'src/file:stream', 'src/one?two',
  'src/' + 'x'.repeat(241)]) {
  const audited = assessTaskWriteScope([candidate],change);
  assert.equal(audited.accepted, canonicalTaskPath(candidate),
    'typed/audit path predicate mismatch for ' + JSON.stringify(candidate));
}
// Ensure real control characters are rejected, not only literal backslash
// sequences from escaped fixture strings.
for (const candidate of ['src/line' + String.fromCharCode(10) + 'break',
  'src/tab' + String.fromCharCode(9) + 'name',
  'src/nul' + String.fromCharCode(0) + 'name']) {
  assert.equal(canonicalTaskPath(candidate),false);
  assert.equal(assessTaskWriteScope([candidate],change).violations[0]?.reason,'unsafe_path');
}
// The typed task spec must reject the same dangerous aliases as the audit;
// otherwise an exclusion could pass routing but fail only after execution.
for (const unsafe of ['src/aux.txt','src/CON','src/lpt9.log','src/name.']) {
  const result = assessPreWriteBoundary([withConstraints('combined',[unsafe])]);
  assert.equal(result.accepted,false);
  assert.equal(result.reason,'invalid_task_authorization');
}
assert.equal(assessPreWriteBoundary([withConstraints('combined',['src/valid-file.ts'])]).reason,
  'excluded_paths_require_enforced_sandbox');

console.log('prewrite-boundary: PASS');

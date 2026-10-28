import assert from 'node:assert/strict';
import {assessTaskWriteScope, assertTaskWriteScope, assertTaskWriteScopes} from '../src/execution/task-write-policy.mjs';
import {emptyTaskSpec,validateTaskSpec} from '../src/routing/task-spec.mjs';
const task={...emptyTaskSpec('change','explicit'),constraints:{...emptyTaskSpec().constraints,
  writeScope:'tests_only',excludedPaths:['tests/protected']}};
assert.deepEqual(validateTaskSpec(task).constraints.writeScope,'tests_only');
assert.equal(assessTaskWriteScope(['tests/test_mod.py','pkg/mod_test.go','src/mod.test.ts'],task).accepted,true);
for (const path of ['src/../tests/test_a.py','src\\..\\tests\\test_a.py','/.git/index','.git/index','tests//test_a.py','src/mod.py','src/mod.ts','README.md','tests/protected/test_mod.py','unknown.xyz']) {
  assert.equal(assessTaskWriteScope([path],task).accepted,false,path);
  assert.throws(()=>assertTaskWriteScope([path],task),{code:'TASK_WRITE_SCOPE_VIOLATION'});
}
assert.equal(assessTaskWriteScope(['src/mod.py'],{...task,constraints:{...task.constraints,writeScope:'combined'}}).accepted,true);
assert.equal(assessTaskWriteScope(['src/mod.py'],{...task,constraints:{...task.constraints,writeScope:'production_only'}}).accepted,true);
assert.throws(()=>validateTaskSpec({...task,constraints:{...task.constraints,writeScope:'all'}}),/invalid_task_spec_write_scope/);
assert.equal(assessTaskWriteScope(['README.md'],emptyTaskSpec('change','explicit')).accepted,true,'legacy must remain compatible');
const resumed={...task,constraints:{...task.constraints,writeScope:'combined',excludedPaths:[]}};
assert.throws(()=>assertTaskWriteScopes(['src/production.ts'],[resumed,task]),{code:'TASK_WRITE_SCOPE_VIOLATION'},'resume cannot silently broaden a saved test-only plan');
console.log('task-write-policy: PASS');

import assert from 'node:assert/strict';
import {emptyTaskSpec,validateTaskSpec,QUALITY_GOALS} from '../src/routing/task-spec.mjs';
import {schemas} from '../src/schemas.mjs';
const task={...emptyTaskSpec('change','explicit'),qualityGoals:['test_inventory','scenario_assessment'],
  constraints:{...emptyTaskSpec().constraints,writeScope:'tests_only'}};
for (const skill of [undefined,'test-it','any-skill','reviews']) {
  const candidate={...task,...(skill?{skillName:skill}:{})};
  const normalized=validateTaskSpec(candidate);
  assert.deepEqual(normalized.qualityGoals,task.qualityGoals);
  assert.equal(normalized.constraints.writeScope,'tests_only');
  assert.notStrictEqual(normalized.qualityGoals,task.qualityGoals,'defensively copied');
}
assert.deepEqual(schemas.routing.properties.task.properties.qualityGoals.items.enum,QUALITY_GOALS);
for (const goals of [['invalid'],['test_inventory','test_inventory'],['measured_code_coverage','wrong']])
  assert.throws(()=>validateTaskSpec({...task,qualityGoals:goals}),/invalid_task_spec_quality_goals/);
assert.deepEqual(validateTaskSpec({...task,qualityGoals:undefined}).qualityGoals,[],'legacy saved plan');
assert.deepEqual(validateTaskSpec(emptyTaskSpec('investigate')).qualityGoals,[]);
console.log('semantic-quality-goals: PASS');

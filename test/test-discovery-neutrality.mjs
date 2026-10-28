import assert from 'node:assert/strict';
import {classifyTestCandidate, associateTestCandidates} from '../src/testing/discovery.mjs';
for (const [production,test] of [
  ['src/x.ts','src/x.test.ts'],['src/x.py','tests/test_x.py'],
  ['pkg/x.go','pkg/x_test.go'],['src/X.java','src/XTest.java'],
  ['src/X.cs','src/XTests.cs'],['lib/x.rb','spec/x_spec.rb'],
  ['src/X.php','tests/XTest.php'],['src/x.rs','tests/x.rs'],
  ['src/x.cpp','tests/x_test.cpp']]) {
  assert.equal(classifyTestCandidate(production).kind,'production_candidate',production);
  assert.equal(classifyTestCandidate(test).kind,'test',test);
  assert.equal(associateTestCandidates(production,[test]).length,1,production);
}
assert.equal(classifyTestCandidate('src/feature.custom').kind,'unknown');
assert.equal(classifyTestCandidate('dist/x.test.ts').kind,'ignored');
const custom=[{id:'custom',source:p=>p.endsWith('.custom'),test:p=>p.startsWith('tests/')}];
assert.equal(classifyTestCandidate('tests/feature.custom',{adapters:custom}).kind,'test');
assert.equal(classifyTestCandidate('src/feature.custom',{adapters:custom}).kind,'production_candidate');
console.log('test-discovery-neutrality: PASS');

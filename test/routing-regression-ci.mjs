// CI runs the production offline evaluator and comparison CLI; no providers or ACP fakes.
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {emptyTaskSpec} from '../src/routing/task-spec.mjs';
import {groundTruthDigest} from '../src/routing/ground-truth.mjs';
const root=await mkdtemp(join(tmpdir(),'semantic-regression-ci-'));
const make=(id,task,expected)=>({schemaVersion:1,id,task,taskDigest:groundTruthDigest(task),
  recordedAt:'2026-10-28T00:00:00Z',labelStatus:'confirmed',expected,
  provenance:{method:'manual_review',confirmedBy:'operator',confirmedAt:'2026-10-28T00:00:00Z'}});
const expected={operation:'investigate',writeIntent:'not_requested',selector:null,continuation:'new',ambiguity:false};
const cases=[make('case_one','Explain this behavior',expected),make('case_two','Analyze this issue',expected)];
const output=task=>({outputFormat:'structured',output:{mode:task.operation,writeIntent:task.writeIntent,task}});
const base={version:1,responses:Object.fromEntries(cases.map(c=>[c.id,{result:output(emptyTaskSpec())}]))};
const changed={version:1,responses:{...base.responses,
  case_two:{result:output(emptyTaskSpec('change','explicit'))}}};
const run=(script,args)=>spawnSync(process.execPath,[script,...args],{encoding:'utf8',timeout:45000});
try {
  const corpus=join(root,'corpus.json'),fixtures=join(root,'fixtures.json'),baseline=join(root,'baseline.json'),current=join(root,'current.json');
  await writeFile(corpus,JSON.stringify({schemaVersion:1,cases}));
  await writeFile(fixtures,JSON.stringify(base));
  const b=run('tools/semantic-evaluate.mjs',[root,corpus,'--offline',fixtures]);
  assert.equal(b.status,0,b.stderr);await writeFile(baseline,b.stdout,{mode:0o600});
  const bJson=JSON.parse(b.stdout);
  assert.equal(bJson.routerInvocations,0);assert.equal(bJson.providerFailures,0);
  assert.equal(bJson.groundTruth.verifiedOutputs,2);
  assert.equal(bJson.semanticAccuracyVerified,false);
  assert.equal(bJson.accuracy.operation,1);
  await writeFile(fixtures,JSON.stringify(changed));
  const c=run('tools/semantic-evaluate.mjs',[root,corpus,'--offline',fixtures]);
  assert.equal(c.status,1,c.stderr);await writeFile(current,c.stdout,{mode:0o600});
  const criteria=join(root,'criteria.json');await writeFile(criteria,JSON.stringify({minConfirmedCases:2}));
  const fail=run('tools/routing-compare.mjs',[baseline,current,criteria]);
  assert.equal(fail.status,1,fail.stderr);
  const comparison=JSON.parse(fail.stdout);
  assert.equal(comparison.status,'FAIL');assert.deepEqual(comparison.security.newFalsePositiveChange,['case_two']);
  assert.equal(comparison.gates.falsePositiveChange.denominator,2);
  const pass=run('tools/routing-compare.mjs',[baseline,baseline,criteria]);
  assert.equal(pass.status,0,pass.stderr);
  await writeFile(criteria,JSON.stringify({minConfirmedCases:3}));
  const insufficient=run('tools/routing-compare.mjs',[baseline,current,criteria]);
  assert.equal(insufficient.status,3,insufficient.stderr);
  const mismatch=JSON.parse(await readFile(baseline));mismatch.results[0].caseDigestVersion=1;
  const historical=join(root,'historical.json');await writeFile(historical,JSON.stringify(mismatch));
  await writeFile(criteria,JSON.stringify({minConfirmedCases:1}));
  const incompatible=run('tools/routing-compare.mjs',[historical,current,criteria]);
  assert.equal(incompatible.status,3,incompatible.stderr);
  console.log('routing-regression-ci: PASS (offline runner, confirmed gates, JSON, exit codes, historical incompatibility)');
} finally {await rm(root,{recursive:true,force:true});}

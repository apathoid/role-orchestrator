import assert from 'node:assert/strict';
import { mkdtemp,writeFile,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { emptyTaskSpec } from '../src/routing/task-spec.mjs';
import { evaluationRow,aggregateSemanticEvaluation } from '../src/routing/semantic-evaluation.mjs';
const root=await mkdtemp(join(tmpdir(),'semantic-offline-'));
const expected={operation:'investigate',writeIntent:'not_requested',selector:null,continuation:'new',ambiguity:false};
const cases=[
  {id:'valid',task:'Explain',expected},
  {id:'conflict',task:'Analyze',expected},
  {id:'missing',task:'Describe',expected},
  {id:'timeout',task:'What',expected},
  {id:'crash',task:'Why',expected},
  {id:'cancel',task:'When',expected},
  {id:'partial',task:'Where',expected},
  {id:'false_write',task:'How',expected},
  {id:'bad_git',task:'Which',expected},
  {id:'continuation',task:'About plan',expected:{...expected,continuation:'information'}},
];
const output=(task,mode=task.operation,writeIntent=task.writeIntent)=>
  ({outputFormat:'structured',output:{mode:mode==='plan'?'investigate':mode,writeIntent,complexity:'low',risk:'normal',task},
    meta:{usage:{inputTokens:10,outputTokens:5}}});
const responses={
  valid:{result:output(emptyTaskSpec()),latencyMs:12},
  conflict:{result:output(emptyTaskSpec(),'change','explicit')},
  missing:{result:{outputFormat:'structured',output:{mode:'investigate',writeIntent:'not_requested'}}},
  timeout:{error:{code:'TIMEOUT',message:'timeout'}},
  crash:{error:{code:'PROVIDER_CRASH'}},
  cancel:{error:{code:'PROVIDER_CANCELLED'}},
  partial:{result:output(emptyTaskSpec())},
  false_write:{result:output(emptyTaskSpec('change','explicit'))},
  bad_git:{result:output({...emptyTaskSpec('review'),target:{kind:'git',selector:{type:'commit',ref:'--exec'}}},'review','not_requested')},
  continuation:{result:output({...emptyTaskSpec(),continuation:{mode:'revise_plan'}})},
};
try {
  const rows=cases.map(c=>{
    const f=responses[c.id];
    if(f.error){const e=Object.assign(new Error(f.error.message??f.error.code),{code:f.error.code});return evaluationRow(c,{error:e,invoked:true});}
    return evaluationRow(c,{result:f.result,invoked:true,latencyMs:f.latencyMs??null});
  });
  const report=aggregateSemanticEvaluation(cases,rows);
  assert.equal(report.cases,10);
  assert.equal(report.validOutputs,4);
  assert.equal(report.semanticDenominator,0);
  assert.equal(report.providerFailures,3);
  assert.equal(report.contractFailures,3);
  assert.equal(report.contractDenominator,7);
  assert.equal(report.invalidOutputRate,3/7);
  assert.equal(report.routerInvocations,10);
  assert.equal(report.accuracy.operation,null);
  assert.equal(report.fixtureAgreement.operation,3/4);
  assert.equal(report.fixtureAgreement.continuation,3/4);
  assert.equal(report.falsePositiveWrite,0);
  assert.equal(report.writePrecision,null);
  assert.equal(report.writeRecall,null);
  assert.equal(report.tokens.reportedCases,6);
  assert.equal(report.latencySamples,1);
  assert.equal(report.latencyMs,12);
  assert.equal(report.status,'INCOMPLETE');
  // The stand-alone evaluator uses the same builder and has no provider dependency in offline mode.
  const corpus=join(root,'corpus.json'),fixture=join(root,'responses.json');
  await writeFile(corpus,JSON.stringify(cases));await writeFile(fixture,JSON.stringify({version:1,responses}));
  const cmd=spawnSync(process.execPath,['tools/semantic-evaluate.mjs',root,corpus,'--offline',fixture],
    {cwd:new URL('..',import.meta.url).pathname,encoding:'utf8',timeout:30000});
  assert.equal(cmd.status,1,cmd.stderr);
  const cli=JSON.parse(cmd.stdout);
  assert.equal(cli.source,'offline_fixture');
  assert.equal(cli.semanticAccuracyVerified,false);
  assert.equal(cli.validOutputs,report.validOutputs);
  assert.equal(cli.providerFailures,0);
  assert.equal(cli.simulatedProviderFailures,3);
  assert.equal(cli.routerInvocations,0);
  assert.equal(cli.tokens,null);
  assert.ok(cli.results.every(r=>/^[0-9a-f]{64}$/.test(r.requestDigest)));
  assert.equal(cli.results.find(r=>r.id==='missing').operation,null);
  const omitted={version:1,responses:{valid:responses.valid}};
  await writeFile(fixture,JSON.stringify(omitted));
  const missingCase=spawnSync(process.execPath,['tools/semantic-evaluate.mjs',root,corpus,'--offline',fixture],
    {cwd:new URL('..',import.meta.url).pathname,encoding:'utf8',timeout:30000});
  assert.equal(missingCase.status,3,missingCase.stderr);
  const partial=JSON.parse(missingCase.stdout);
  assert.equal(partial.routerInvocations,0,'offline fixtures are never invocations');
  assert.equal(partial.fixtureMissing,9);
  assert.equal(partial.semanticDenominator,0);
  assert.equal(partial.validOutputs,1);
}finally{await rm(root,{recursive:true,force:true});}
console.log('semantic-evaluator-offline: PASS');

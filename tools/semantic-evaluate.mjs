#!/usr/bin/env node
// Provider-neutral Router evaluation using the production request builder.
// Offline responses test evaluation mechanics, never real model accuracy.
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {loadConfig,resolveRouterContextMode} from '../src/config.mjs';
import {createModelRegistry} from '../src/models.mjs';
import {resolveRoleAssignments} from '../src/role-presets.mjs';
import {roleInstructions} from '../src/roles.mjs';
import {buildSemanticRouterRequest} from '../src/routing/request.mjs';
import {normalizeRouterContextTelemetry} from '../src/routing/context.mjs';
import {evaluationRow,aggregateSemanticEvaluation,canonicalJSON,caseIdentity} from '../src/routing/semantic-evaluation.mjs';
import {loadEvaluationCorpus} from '../src/routing/ground-truth.mjs';
const [,,repoArg,corpusArg,flag,...additional]=process.argv;
if(!repoArg||!corpusArg||!['--run','--offline'].includes(flag)){
  console.error('Usage: semantic-evaluate /repo/path corpus.json --run|--offline responses.json [--context-mode legacy|observe|optimized]');
  process.exit(2);
}
const validId=s=>typeof s==='string'&&/^[a-z0-9_-]{1,80}$/.test(s);
const hash=s=>createHash('sha256').update(s).digest('hex');
try {
  const args=[...additional];
  const offline=flag==='--offline';
  const offlinePath=offline?args.shift():null;
  let requestedMode=null;
  if(args.length===2&&args[0]==='--context-mode'&&['legacy','observe','optimized'].includes(args[1]))requestedMode=args[1];
  else if(args.length)throw new Error('invalid_evaluator_options');
  if(offline&&!offlinePath)throw new Error('missing_offline_fixture');
  const cases=loadEvaluationCorpus(JSON.parse(await readFile(resolve(corpusArg),'utf8')));
  if(cases.some(c=>!validId(c.id)||typeof c.task!=='string'||c.task.length>12000)||
      new Set(cases.map(c=>c.id)).size!==cases.length)throw new Error('invalid_corpus');
  const repoRoot=resolve(repoArg);
  const config=await loadConfig({repoRoot});
  const mode=resolveRouterContextMode(config,{diagnosticOverride:requestedMode});
  const effectiveAssignments=resolveRoleAssignments(config,config.defaultRolePreset??null);
  const routerAssignment=effectiveAssignments.router;
  const routerProfile=routerAssignment.profile;
  const configFingerprint=hash(canonicalJSON({
    selectedProfile:routerAssignment.profileName??null,provider:routerProfile?.provider??null,
    model:routerProfile?.model??null,requestedMode:mode,
    preset:config.defaultRolePreset??null,routerInstructions:hash(roleInstructions.router),schemaVersion:1}));
  let fixtures=null,registry=null;
  if(offline){
    const data=JSON.parse(await readFile(resolve(offlinePath),'utf8'));
    if(!data||typeof data!=='object'||Array.isArray(data)||data.version!==1||
        !data.responses||typeof data.responses!=='object'||Array.isArray(data.responses))throw new Error('invalid_offline_fixture');
    fixtures=data.responses;
  }else registry=createModelRegistry({...config,roleAssignments:effectiveAssignments});
  const rows=[];const projections=[];
  try {
    for(const item of cases){
      let request;
      try { request=await buildSemanticRouterRequest({repoRoot,userTask:item.task,
        ...(item.routerInput??{}),routerContextMode:mode}); }
      catch(e){const error=Object.assign(new Error('request_build_failed'),{code:'REQUEST_BUILD_FAILED'});
        rows.push(evaluationRow(item,{error,invoked:false,offline}));continue;}
      const requestDigest=hash(request.prompt);
      const context=normalizeRouterContextTelemetry(request.routerContextTelemetry);
      projections.push([item.id,context?.selectedMode??null,context?.fallbackReason??null,requestDigest]);
      const provided=offline&&Object.hasOwn(fixtures,item.id);
      const since=performance.now();let result=null,error=null;
      try {
        if(offline){
          if(!provided){const e=new Error('offline_fixture_missing');e.code='OFFLINE_FIXTURE_MISSING';throw e;}
          const fixture=fixtures[item.id];
          if(!fixture||typeof fixture!=='object'||Array.isArray(fixture)||
            (fixture.error&&(!fixture.error.code||typeof fixture.error.code!=='string'))){
            const e=new Error('malformed_fixture');e.code='OFFLINE_FIXTURE_MALFORMED';throw e;}
          if(fixture.error){const e=new Error('provider_fixture_failure');e.code=fixture.error.code;throw e;}
          result=fixture.result??fixture;
        }else{
          result=await registry.invokeRole('router',{cwd:repoRoot,sandboxMode:request.sandboxMode,
            schemaKind:request.schemaKind,schema:request.schema,prompt:request.prompt,
            promptBlocks:request.promptBlocks,mcpServers:request.mcpServers,
            additionalDirectories:request.additionalDirectories});
        }
      }catch(e){error=e;}
      rows.push({...evaluationRow(item,{result,error,invoked:!offline,offline,requestDigest,
        latencyMs:offline?(provided&&Number.isFinite(fixtures[item.id]?.latencyMs)?fixtures[item.id].latencyMs:null):
          Math.round(performance.now()-since)}),context});
    }
  }finally{await registry?.close();}
  const aggregate=aggregateSemanticEvaluation(cases,rows);
  const evaluationIdentity={version:1,corpusVersion:1,
    corpusDigest:hash(canonicalJSON(cases.map(caseIdentity))),requestBuilderVersion:1,
    evaluationMode:offline?'offline_fixture':'live_provider',
    routerConfigurationDigest:configFingerprint,routerInstructionsDigest:hash(roleInstructions.router),
    provider:routerProfile?.provider??null,model:routerProfile?.model??null,
    rolePreset:config.defaultRolePreset??null,routerContextMode:mode,
    projectionDigest:hash(canonicalJSON(projections))};
  console.log(JSON.stringify({...aggregate,evaluationIdentity,source:offline?'offline_fixture':'live_provider',
    semanticAccuracyVerified:!offline&&aggregate.groundTruth.status==='MEASURED',
    contextMode:mode,configurationDigest:configFingerprint,
    routerInstructionsDigest:hash(roleInstructions.router),
    note:offline?'Synthetic/offline output is not evidence of live model accuracy':'Only confirmed manually labeled cases qualify for verified accuracy'},null,2));
  // No provider evidence exists in offline mode; missing fixtures are incomplete data.
  if(aggregate.environmentFailures>0)process.exitCode=2;
  else if(aggregate.fixtureMissing>0||aggregate.groundTruth.verifiedOutputs<aggregate.groundTruth.confirmedCases)process.exitCode=3;
  else if(aggregate.contractFailures>0||aggregate.falsePositiveWrite>0)process.exitCode=1;
}catch(e){console.error('Semantic evaluation NOT_VERIFIED:',e.message);process.exitCode=2;}

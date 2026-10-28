// Versioned, opt-in evaluation input; entirely separate from routine traces.
// No Router output is ever promoted to ground truth.
import {createHash} from 'node:crypto';
import {validateTaskSpec,emptyTaskSpec} from './task-spec.mjs';
import {canonicalJSON} from './semantic-evaluation.mjs';
const OPS=['investigate','review','change','plan'],WRITE=['explicit','ambiguous','not_requested'];
const ID=/^[a-z0-9][a-z0-9_-]{0,79}$/;
const isObj=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const fail=reason=>{throw new TypeError(`invalid_ground_truth_${reason}`)};
export const groundTruthDigest=task=>createHash('sha256').update(task).digest('hex');
export function validateGroundTruthCase(input) {
  if(!isObj(input)||input.schemaVersion!==1||!ID.test(input.id)||
    typeof input.task!=='string'||!input.task.trim()||input.task.length>12000)
    fail('identity');
  if(Object.keys(input).some(key=>!['schemaVersion','id','task','taskDigest','labelStatus','expected',
    'provenance','recordedAt','routerInput','hostConstraints','projectContext','capture'].includes(key)))fail('unknown_field');
  if(input.taskDigest!==groundTruthDigest(input.task))fail('digest');
  if(input.capture!==undefined){
    const c=input.capture, IDSAFE=/^[a-zA-Z0-9._:-]{1,128}$/;
    const keys=['sessionId','runId','invocationId','eventSchemaVersion','typedTaskVersion','routerConfigurationDigest','provider','model','rolePreset'];
    if(!isObj(c)||Object.keys(c).some(k=>!keys.includes(k))||
      !['sessionId','runId'].every(k=>typeof c[k]==='string'&&IDSAFE.test(c[k]))||
      Object.entries(c).some(([k,v])=>['eventSchemaVersion','typedTaskVersion'].includes(k)?!Number.isSafeInteger(v)||v<1||v>100:
        !IDSAFE.test(v)))fail('capture');
  }
  if(!['confirmed','unlabeled'].includes(input.labelStatus))fail('label_status');
  if(!Number.isFinite(Date.parse(input.recordedAt))||typeof input.recordedAt!=='string')fail('date');
  const host=input.hostConstraints??{};
  if(!isObj(host)||Object.keys(host).some(k=>!['modeOverride','planOnly'].includes(k))||
    (host.modeOverride!==undefined&&!['investigate','review','change'].includes(host.modeOverride))||
    (host.planOnly!==undefined&&typeof host.planOnly!=='boolean'))fail('host_constraints');
  if(input.routerInput!==undefined&&(!isObj(input.routerInput)||Object.keys(input.routerInput).some(k=>
    !['sessionHistoryText','savedOperationMetadata','modeOverride','planOnly','reviewTargetText'].includes(k))))fail('router_input');
  if(input.projectContext!==undefined&&(!isObj(input.projectContext)||
    Object.keys(input.projectContext).some(k=>!['fixtureId','description'].includes(k))))fail('context');
  if(input.labelStatus==='unlabeled') {
    if(input.expected!==null&&input.expected!==undefined)fail('unlabeled_expected');
    return {...input,expected:null};
  }
  const prov=input.provenance;
  if(!isObj(prov)||prov.method!=='manual_review'||!['user','operator'].includes(prov.confirmedBy)||
      typeof prov.confirmedAt!=='string'||!Number.isFinite(Date.parse(prov.confirmedAt)))fail('provenance');
  const e=input.expected;
  if(!isObj(e)||!OPS.includes(e.operation)||!WRITE.includes(e.writeIntent)||
    Object.keys(e).some(key=>!['operation','writeIntent','selector','continuation','operationId','ambiguity'].includes(key))||
    !['new','current_review','current_implementation','saved_implementation','saved_review','information','revise_plan','reconcile','ambiguous'].includes(e.continuation)||
    typeof e.ambiguity!=='boolean'||
    (e.operationId!==undefined&&(typeof e.operationId!=='string'||!/^[a-zA-Z0-9_-]{8,128}$/.test(e.operationId))))fail('expected');
  // The common validator ensures typed Git selectors and continuation satisfy
  // exactly the same contract as production, without granting permissions.
  try{ validateTaskSpec({...emptyTaskSpec(e.operation,e.writeIntent),
    target:e.selector?{kind:'git',selector:e.selector}:{kind:'none',selector:null},
    continuation:{mode:e.continuation,...(e.operationId?{operationId:e.operationId}:{})},ambiguities:e.ambiguity?['human reviewed ambiguity']:[]},
    {modeOverride:host.modeOverride??null,planOnly:host.planOnly??false}); }
  catch{fail('typed_expected');}
  if(e.operation==='change'&&e.writeIntent!=='explicit')fail('write_conflict');
  return structuredClone(input);
}
export function loadEvaluationCorpus(input){
  const arr=Array.isArray(input)?input:isObj(input)&&input.schemaVersion===1&&Array.isArray(input.cases)?input.cases:null;
  if(!arr||!arr.length||arr.length>200)fail('corpus');
  const normalized=arr.map(c=>{
    if(c?.schemaVersion===1){const v=validateGroundTruthCase(c);return {
      id:v.id,task:v.task,expected:v.expected,
      schemaVersion:v.schemaVersion,labelStatus:v.labelStatus,provenance:v.provenance??null,
      hostConstraints:v.hostConstraints??null,projectContext:v.projectContext??null,capture:v.capture??null,
      routerInput:{...(v.routerInput??{}),...(v.hostConstraints??{})}};}
    // Older 56-case corpus must remain byte-identical. Its expected labels
    // are developer fixtures, not manually verified live ground truth.
    if(!c||!ID.test(c.id)||typeof c.task!=='string'||c.task.length>12000||
      !OPS.includes(c.expected?.operation))fail('legacy');
    return {...c,labelStatus:'legacy_fixture'};
  });
  if(new Set(normalized.map(x=>x.id)).size!==normalized.length)fail('duplicate_id');
  const versioned=arr.filter(c=>c?.schemaVersion===1);
  const fingerprints=versioned.map(c=>groundTruthDigest(canonicalJSON([c.taskDigest,c.hostConstraints??null,c.routerInput??null,c.projectContext??null])));
  if(new Set(fingerprints).size!==fingerprints.length)fail('duplicate_task');
  return normalized;
}

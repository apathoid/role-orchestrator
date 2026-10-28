// Read-only, provider-neutral assessment of already obtained Router outputs.
// A fixture is never a provider invocation, and unlabeled cases never enter accuracy.
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import { parseStructuredState } from '../structured-output.mjs';
import { validateTaskSpec, emptyTaskSpec } from './task-spec.mjs';
import { validateRouteConsistency } from './consistency.mjs';

const providerCodes=new Set(['PROVIDER_CANCELLED','PROVIDER_CRASH','MODEL_UNAVAILABLE','RATE_LIMIT','TIMEOUT','PROVIDER_TIMEOUT','SESSION_CANCELLED','CLIENT_REQUEST_CANCELLED']);
const environmentCodes=new Set(['ENVIRONMENT_ERROR','INFRA_FAILURE','STORAGE_FAILURE','REQUEST_BUILD_FAILED','EVALUATION_INTERRUPTED']);
export const CASE_DIGEST_VERSION=2;
// Canonical JSON: key ordering is immaterial, array ordering and null/absence are not.
export function canonicalJSON(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;
  if (value && typeof value==='object') return `{${Object.keys(value).sort().filter(k=>value[k]!==undefined).map(k=>`${JSON.stringify(k)}:${canonicalJSON(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
export function caseIdentity(item) {
  return createHash('sha256').update(canonicalJSON({schemaVersion:item.schemaVersion??0,
    id:item.id,task:item.task,expected:item.expected??null,hostConstraints:item.hostConstraints??null,
    routerInput:item.routerInput??null,projectContext:item.projectContext??null})).digest('hex');
}
// Selector IDENTITY, not dereferenced Git-target equivalence. Union order and
// merge-parent identity are significant. Unknown fields are rejected by production validation.
function validSelector(s) {
  if(s===null)return true;
  try {validateTaskSpec({...emptyTaskSpec('review'),target:{kind:'git',selector:s}});return true;}catch{return false;}
}
export function selectorIdentityEqual(actual,expected) {
  if(!validSelector(actual)||!validSelector(expected))return null;
  return isDeepStrictEqual(actual,expected);
}
export function classifyRouterFailure(error,{providerInvoked=true,offline=false}={}) {
  const c=String(error?.code??'');
  const msg=String(error?.message??'');
  if(c==='OFFLINE_FIXTURE_MISSING')return {category:'fixture_missing',type:'FIXTURE_MISSING',code:'fixture_missing'};
  if(c==='OFFLINE_FIXTURE_MALFORMED')return {category:'contract',type:'CONTRACT_FAILURE',code:'malformed_fixture'};
  if(environmentCodes.has(c)||!providerInvoked&&c!=='OFFLINE_FIXTURE_MISSING'&&!offline)
    return {category:'environment',type:'ENVIRONMENT_FAILURE',code:'environment_failure'};
  if(/^(invalid_|missing_task_spec|conflicting_semantic_|unsupported_|task_spec_)/.test(msg))
    return {category:'contract',type:'CONTRACT_FAILURE',code:'invalid_structured_output'};
  if(offline&&providerCodes.has(c))return {category:'simulated_provider',type:'PROVIDER_FAILURE',code:c.toLowerCase()};
  if(providerInvoked&&providerCodes.has(c))return {category:'provider',type:'PROVIDER_FAILURE',code:c.toLowerCase()};
  if(providerInvoked&&!offline)return {category:'provider',type:'PROVIDER_FAILURE',code:'unclassified_provider_failure'};
  return {category:'environment',type:'ENVIRONMENT_FAILURE',code:'environment_failure'};
}

export function interpretRouterOutput(result) {
  const outputFormat=result?.meta?.structuredOutput?.format ?? result?.outputFormat ??
    (result?.output && typeof result.output==='object' ? 'structured':'text');
  const routed=outputFormat==='structured' ? result.output :
    parseStructuredState({finalText:String(result?.output??'')},'routing').parsed;
  if(!routed || typeof routed!=='object' || !routed.task) throw new Error('missing_task_spec');
  const candidate=validateTaskSpec(routed.task);
  if(!['investigate','review','change'].includes(routed.mode) ||
      !['explicit','not_requested','ambiguous'].includes(routed.writeIntent) ||
      validateRouteConsistency({mode:routed.mode,writeIntent:routed.writeIntent},{taskSpec:candidate}).status!=='accepted')
    throw new Error('conflicting_semantic_and_legacy_route');
  return candidate;
}

export function evaluationRow(item,{result=null,error=null,latencyMs=null,requestDigest=null,invoked=true,offline=false}={}) {
  let spec=null,failure=null;
  if(error) failure=classifyRouterFailure(error,{providerInvoked:invoked,offline});
  else try {spec=interpretRouterOutput(result);} catch(e){failure=classifyRouterFailure(e,{providerInvoked:invoked,offline});}
  const expected=item.expected??null;
  const hasExpected=expected&&item.labelStatus!=='unlabeled';
  const expectedId=expected&&Object.hasOwn(expected,'operationId')?expected.operationId:null;
  const actualId=spec?.continuation?.operationId??null;
  const operationSelection=spec&&hasExpected?actualId===expectedId:null;
  const continuation=spec&&hasExpected?spec.continuation.mode===(expected.continuation??'new')&&operationSelection:null;
  const target=spec&&hasExpected?selectorIdentityEqual(spec.target?.selector??null,expected.selector??null):null;
  return {id:item.id,valid:!!spec,invoked:!!invoked,error:failure?.code??null,
    errorCategory:failure?.category??null,failureType:failure?.type??null,
    latencyMs:Number.isFinite(latencyMs)&&invoked?latencyMs:null,...(requestDigest?{requestDigest}:{}),
    operation:spec&&hasExpected?spec.operation===expected.operation:null,
    writeIntent:spec&&hasExpected?spec.writeIntent===expected.writeIntent:null,
    target,continuation,operationSelection,
    ambiguity:spec&&hasExpected?(!!spec.ambiguities.length===!!expected.ambiguity):null,
    falsePositiveWrite:spec&&hasExpected?spec.writeIntent==='explicit'&&expected.writeIntent!=='explicit':null,
    falsePositiveChange:spec&&hasExpected?spec.operation==='change'&&spec.writeIntent==='explicit'&&
      (expected.operation!=='change'||expected.writeIntent!=='explicit'):null,
    falseNegativeWrite:spec&&hasExpected?spec.writeIntent!=='explicit'&&expected.writeIntent==='explicit':null,
    usage:invoked?(result?.meta?.usage??result?.usage??null):null,
    labelStatus:item.labelStatus??'legacy_fixture',
    expectedOperation:expected?.operation??null,expectedWriteIntent:expected?.writeIntent??null,
    expectedContinuation:expected?.continuation??null,expectedOperationId:expectedId,
    caseDigestVersion:CASE_DIGEST_VERSION,caseDigest:caseIdentity(item)};
}
const share=(n,d)=>d?n/d:null;
export function aggregateSemanticEvaluation(cases,rows) {
  const confirmed=rows.filter(r=>r.labelStatus==='confirmed'&&r.expectedOperation);
  const verified=confirmed.filter(r=>r.valid);
  const fixture=rows.filter(r=>r.labelStatus==='legacy_fixture'&&r.valid);
  const compareKeys=['operation','target','writeIntent','continuation','operationSelection','ambiguity'];
  const accuracy=(set)=>Object.fromEntries(compareKeys.map(key=>[key,share(set.filter(r=>r[key]===true).length,set.filter(r=>typeof r[key]==='boolean').length)]));
  const expected=new Map(cases.map(c=>[c.id,c.expected]));
  const tp=verified.filter(r=>expected.get(r.id)?.writeIntent==='explicit'&&r.writeIntent===true).length;
  const fp=verified.filter(r=>r.falsePositiveWrite).length;
  const fn=verified.filter(r=>r.falseNegativeWrite).length;
  const falsePositiveDenominator=verified.filter(r=>r.expectedWriteIntent!=='explicit').length;
  const failureBreakdown=Object.fromEntries([...new Set(rows.map(r=>r.failureType).filter(Boolean))].sort()
    .map(kind=>[kind,rows.filter(r=>r.failureType===kind).length]));
  const errorBreakdown=Object.fromEntries([...new Set(rows.filter(r=>r.error).map(r=>r.error))].sort()
    .map(code=>[code,rows.filter(r=>r.error===code).length]));
  const measuredLatency=rows.filter(r=>r.invoked&&Number.isFinite(r.latencyMs));
  const contractFailures=rows.filter(r=>r.errorCategory==='contract').length;
  const contractDenominator=rows.filter(r=>r.valid).length+contractFailures;
  const tokenCases=rows.filter(r=>r.invoked&&(Number.isFinite(r.usage?.inputTokens)||Number.isFinite(r.usage?.outputTokens)));
  return {version:3,status:rows.some(r=>r.failureType||!r.valid)?'INCOMPLETE':rows.length?'MEASURED':'NOT_VERIFIED',
    groundTruth:{confirmedCases:confirmed.length,verifiedOutputs:verified.length,
      unlabeledCases:cases.filter(c=>c.labelStatus==='unlabeled').length,
      legacyFixtures:cases.filter(c=>c.labelStatus!=='confirmed'&&c.labelStatus!=='unlabeled').length,
      status:verified.length===confirmed.length&&confirmed.length?'MEASURED':verified.length?'PARTIAL':'NOT_VERIFIED',
      accuracy:accuracy(verified),falsePositiveChange:verified.filter(r=>r.falsePositiveChange).length,
      eligibleNonWrite:falsePositiveDenominator},
    cases:cases.length,validOutputs:rows.filter(r=>r.valid).length,semanticDenominator:verified.length,
    contractDenominator,invalidOutputRate:share(contractFailures,contractDenominator),
    providerFailures:rows.filter(r=>r.errorCategory==='provider'&&r.invoked).length,
    simulatedProviderFailures:rows.filter(r=>r.errorCategory==='simulated_provider').length,
    environmentFailures:rows.filter(r=>r.errorCategory==='environment').length,
    fixtureMissing:rows.filter(r=>r.errorCategory==='fixture_missing').length,
    contractFailures,providerOrContractFailures:rows.filter(r=>r.errorCategory==='provider'||r.errorCategory==='contract').length,
    failureBreakdown,errorBreakdown,accuracy:accuracy(verified),fixtureAgreement:accuracy(fixture),
    writePrecision:share(tp,tp+fp),writeRecall:share(tp,tp+fn),
    falsePositiveWrite:verified.filter(r=>r.falsePositiveWrite).length,
    falsePositiveWriteRate:share(fp,falsePositiveDenominator),
    routerInvocations:rows.filter(r=>r.invoked).length,
    latencyMs:measuredLatency.length?measuredLatency.reduce((s,r)=>s+r.latencyMs,0):null,
    latencySamples:measuredLatency.length,
    tokens:tokenCases.length?{input:tokenCases.reduce((s,r)=>s+(Number(r.usage.inputTokens)||0),0),
      output:tokenCases.reduce((s,r)=>s+(Number(r.usage.outputTokens)||0),0),reportedCases:tokenCases.length}:null,
    results:rows.map(({usage,...r})=>r)};
}

// Side-effect-free paired regression. Only the same confirmed, v2-digest
// eligibility set can prove a regression. Infrastructure is never a mismatch.
const FIELDS=['operation','writeIntent','target','continuation','operationSelection','ambiguity'];
const measure=(numerator,denominator)=>({numerator,denominator,value:denominator?numerator/denominator:null,
  status:denominator?'MEASURED':'INSUFFICIENT_EVIDENCE'});
const safeThreshold=n=>typeof n==='number'&&Number.isFinite(n)&&n>=0&&n<=1;
export function compareSemanticEvaluations(baseline,current,{minConfirmedCases=null,
  maxOperationAccuracyDrop=0,maxScopeAccuracyDrop=0,denyNewFalsePositiveChange=true,
  denyContinuationRegression=true,denyNewContractFailure=true,denyNewProviderFailure=false,
  allowConfigurationChange=false}={}) {
  if(!baseline||!current||!Array.isArray(baseline.results)||!Array.isArray(current.results))
    throw new TypeError('Invalid evaluation reports');
  if(!safeThreshold(maxOperationAccuracyDrop)||!safeThreshold(maxScopeAccuracyDrop))throw new TypeError('Invalid accuracy thresholds');
  const unique=(rows)=>new Map(rows.map(r=>[r.id,r]));
  const before=unique(baseline.results),after=unique(current.results);
  if(before.size!==baseline.results.length||after.size!==current.results.length)throw new TypeError('Duplicate evaluation case IDs');
  const bConfirmed=new Set([...before].filter(([,r])=>r.labelStatus==='confirmed').map(([id])=>id));
  const cConfirmed=new Set([...after].filter(([,r])=>r.labelStatus==='confirmed').map(([id])=>id));
  const unmatchedBaseline=[...bConfirmed].filter(id=>!cConfirmed.has(id));
  const unmatchedCandidate=[...cConfirmed].filter(id=>!bConfirmed.has(id));
  const paired=[...bConfirmed].filter(id=>cConfirmed.has(id)).map(id=>({id,before:before.get(id),after:after.get(id)}));
  const incompatibleCases=paired.filter(x=>x.before.caseDigestVersion!==2||x.after.caseDigestVersion!==2||
    !x.before.caseDigest||x.before.caseDigest!==x.after.caseDigest).map(x=>x.id);
  const comparable=paired.filter(x=>!incompatibleCases.includes(x.id));
  const complete=comparable.filter(x=>x.before.valid&&x.after.valid);
  const conditionDifference=[];
  const bIdentity=baseline.evaluationIdentity,cIdentity=current.evaluationIdentity;
  if(!bIdentity||!cIdentity||bIdentity.version!==1||cIdentity.version!==1){conditionDifference.push('EVALUATION_IDENTITY_MISSING');}
  else {
    for(const key of ['corpusDigest','corpusVersion','requestBuilderVersion','evaluationMode'])
      if(!bIdentity[key]||!cIdentity[key]||bIdentity[key]!==cIdentity[key])conditionDifference.push(`INCOMPATIBLE_${key.toUpperCase()}`);
    for(const key of ['routerConfigurationDigest','routerInstructionsDigest','provider','model','rolePreset','routerContextMode','projectionDigest'])
      if(bIdentity[key]!==cIdentity[key])conditionDifference.push(`CONFIGURATION_CHANGED_${key.toUpperCase()}`);
  }
  const configurationChanged=conditionDifference.filter(x=>x.startsWith('CONFIGURATION_CHANGED_'));
  const incompatibleConditions=conditionDifference.some(x=>!x.startsWith('CONFIGURATION_CHANGED_'))||
    (configurationChanged.length>0&&!allowConfigurationChange);
  const sameSample=unmatchedBaseline.length===0&&unmatchedCandidate.length===0&&incompatibleCases.length===0;
  const required=Number.isSafeInteger(minConfirmedCases)&&minConfirmedCases>0?minConfirmedCases:null;
  const newFalsePositive=complete.filter(x=>!x.before.falsePositiveChange&&x.after.falsePositiveChange).map(x=>x.id);
  const continuationRegression=complete.filter(x=>x.before.expectedContinuation!=='new'&&x.before.continuation===true&&x.after.continuation===false).map(x=>x.id);
  const gitScopeRegression=complete.filter(x=>x.before.target===true&&x.after.target===false).map(x=>x.id);
  const contractRegression=comparable.filter(x=>x.after.errorCategory==='contract'&&x.before.errorCategory!=='contract').map(x=>x.id);
  const providerEligible=comparable.filter(x=>x.before.invoked&&x.after.invoked);
  const providerRegression=providerEligible.filter(x=>x.after.errorCategory==='provider'&&x.before.errorCategory!=='provider').map(x=>x.id);
  const accuracy=Object.fromEntries(FIELDS.map(field=>{
    const eligible=complete.filter(x=>typeof x.before[field]==='boolean'&&typeof x.after[field]==='boolean');
    const b=measure(eligible.filter(x=>x.before[field]===true).length,eligible.length);
    const c=measure(eligible.filter(x=>x.after[field]===true).length,eligible.length);
    return [field,{baseline:b.value,current:c.value,baselineEvidence:b,candidateEvidence:c,
      denominator:eligible.length,drop:b.value===null?null:b.value-c.value}];
  }));
  const evidence=(ids,eligibility,enabled,reasonCode)=>({reasonCode,enabled,
    numerator:ids.length,denominator:eligibility,evidence:ids,baseline:0,candidate:ids.length,
    decision:!eligibility?'INSUFFICIENT_EVIDENCE':!enabled?'DISABLED':ids.length?'FAIL':'PASS'});
  const gates={
    falsePositiveChange:evidence(newFalsePositive,complete.filter(x=>x.before.expectedWriteIntent!=='explicit'||x.before.expectedOperation!=='change').length,denyNewFalsePositiveChange,'NEW_FALSE_POSITIVE_CHANGE'),
    continuation:evidence(continuationRegression,complete.filter(x=>x.before.expectedContinuation!=='new').length,denyContinuationRegression,'CONTINUATION_REGRESSION'),
    gitScope:evidence(gitScopeRegression,complete.filter(x=>x.before.target!==null&&x.after.target!==null).length,true,'GIT_SCOPE_REGRESSION'),
    contractFailure:evidence(contractRegression,comparable.length,denyNewContractFailure,'CONTRACT_REGRESSION'),
    providerFailure:evidence(providerRegression,providerEligible.length,denyNewProviderFailure,'PROVIDER_REGRESSION'),
  };
  const findings=[];
  for(const g of Object.values(gates))if(g.decision==='FAIL')findings.push(g.reasonCode);
  if(accuracy.operation.drop!==null&&accuracy.operation.drop>maxOperationAccuracyDrop)findings.push('OPERATION_ACCURACY_REGRESSION');
  if(accuracy.target.drop!==null&&accuracy.target.drop>maxScopeAccuracyDrop)findings.push('GIT_SCOPE_ACCURACY_REGRESSION');
  const sufficient=required!==null&&complete.length>=required&&sameSample&&!incompatibleConditions;
  return {version:2,status:sufficient?(findings.length?'FAIL':'PASS'):'INSUFFICIENT_EVIDENCE',
    source:'paired_confirmed_ground_truth',requiredConfirmed:required,pairedConfirmed:paired.length,
    validPaired:complete.length,caseMismatches:incompatibleCases,unmatchedBaseline:unmatchedBaseline.length,
    unmatchedCandidate:unmatchedCandidate.length,sameEligibilitySet:sameSample,
    conditions:{baseline:bIdentity??null,candidate:cIdentity??null,differences:conditionDifference,
      allowConfigurationChange,comparable:!incompatibleConditions},
    accuracy,gates,security:{newFalsePositiveChange:newFalsePositive,newFalsePositiveCount:newFalsePositive.length},
    continuationRegression,gitScopeRegression,contractRegression,providerRegression,findings,
    reasons:!sufficient?[...(required===null?['MIN_CONFIRMED_CASES_NOT_SET']:[]),
      ...(required!==null&&complete.length<required?['NOT_ENOUGH_VALID_PAIRED_CASES']:[]),
      ...(!sameSample?['INCOMPATIBLE_CASE_SET_OR_DIGEST']:[]),
      ...(incompatibleConditions?['INCOMPATIBLE_EVALUATION_CONDITIONS']:[])]:[],
    authorizationBypass:'NOT_VERIFIED',
    environment:'Offline results test fixture mechanics only; model accuracy requires real providers.'};
}

import assert from 'node:assert/strict';
import { reconcileReviewFindings,renderReviewFindings } from '../src/review-findings.mjs';
import { adjudicateReviewFindings, reviewWitnessSubject } from '../src/evidence/adjudication.mjs';
import { summarizeExecutionOutcome } from '../src/efficiency/outcome.mjs';
import { createEfficiencyRun } from '../src/efficiency/analytics.mjs';
import { normalizeEfficiencyRuns } from '../src/session-store.mjs';

const a={path:'src/state.ts',severity:'minor',contractId:'diagnostics-state',reproductionKey:'live-event',failureMode:'missing-revision',affectedBehavior:'reload',message:'revision lost',evidence:'reducer returned partial state',origin:'introduced',batchId:'batch-3',unitIds:['F1']};
const b={...a,message:'socket event drops revision field',severity:'major',evidence:'state snapshot',batchId:'batch-1',unitIds:['F2']};
const c={...a,message:'next fetch permanently fails',severity:'blocking',origin:'pre_existing',batchId:'batch-2',unitIds:['F3']};
const review=reconcileReviewFindings([a,b,c]);
assert.equal(review.raw,3);assert.equal(review.unique,1);
assert.equal(review.ledger[0].observations.length,3);
assert.deepEqual(new Set(review.ledger[0].observations.map(x=>x.batchId)),new Set(['batch-1','batch-2','batch-3']));
assert.equal(review.ledger[0].issue.severity,'blocking','conflicting severity must retain highest impact');
assert.deepEqual(review.ledger[0].severityVariants,['blocking','major','minor']);
assert.equal(review.ledger[0].issue.origin,'unknown','conflicting origin must not be asserted as fact');
assert.equal(reconcileReviewFindings([c,b,a]).ledger[0].findingId,review.ledger[0].findingId);
assert.equal(reconcileReviewFindings([c,b,a]).issues[0].message,review.issues[0].message);
assert.equal(reconcileReviewFindings([{...a,batchId:'new batch'},b,c]).issues[0].message,review.issues[0].message,
  'batch provenance must not select canonical prose');
assert.equal(reconcileReviewFindings([Object.fromEntries(Object.entries(a).reverse()),b,c]).issues[0].message,review.issues[0].message,
  'object key order must not select canonical prose');
const distinct=reconcileReviewFindings([{...a,reproductionKey:'another-event'},a]);
assert.equal(distinct.unique,2);
const cross=reconcileReviewFindings([{...a,path:'src/main.ts'},a]);
assert.equal(cross.unique,2);
const textOnly=reconcileReviewFindings([{path:'x.ts',message:'same phrase',evidence:'same evidence'}, {path:'x.ts',message:'same phrase',evidence:'other evidence'}]);
assert.equal(textOnly.unique,2);
assert(textOnly.potentialDuplicates >= 0);
const common={path:'path.ts',severity:'major',failureMode:'race',affectedBehavior:'reload',contractId:'contract'};
const items=[{...common,message:'alpha',reproductionKey:'r1'},{...common,message:'beta'},{...common,message:'gamma',reproductionKey:'r2'}];
const ids=reconcileReviewFindings(items).ledger.map(x=>x.findingId);
const W='a'.repeat(64);
const sourceKey='d'.repeat(64), scopeKey='e'.repeat(64);
const bind=(items,ds)=>{const byId=new Map(reconcileReviewFindings(items).ledger.map(row=>[row.findingId,row]));
  return {sourceKey,scopeKey,verifiedWitnesses:ds.map(decision=>({digest:decision.witnessDigest,
    subjectDigest:reviewWitnessSubject({left:byId.get(decision.left),right:byId.get(decision.right),decision,sourceKey,scopeKey}),
    origin:'trusted_host_verifier',verifierId:'test-host',evidenceRefs:['fixture-proof']}))};};
const decisions=[{left:ids[0],right:ids[1],authority:'independently_verified',relation:'equivalent',witnessDigest:W},
 {left:ids[1],right:ids[2],authority:'independently_verified',relation:'equivalent',witnessDigest:W}];
const adjudicated=adjudicateReviewFindings(items,decisions,bind(items,decisions));
assert.equal(adjudicated.unique,2,'a transitive chain cannot merge contradictory reproduction keys');
assert.equal(adjudicated.rejected.includes('different_reproduction'),true);
// Candidate B↔C must survive independent A↔B adjudication even if A wins the
// representative selection and A↔C was never a candidate.
const aliasA={...common,contractId:'a-contract',reproductionKey:'reconnect',failureMode:'state-reset',
 affectedBehavior:'subsystem-x',message:'First cause',evidence:'A'};
const aliasB={...common,contractId:'b-contract',reproductionKey:'reconnect',failureMode:'state-reset',
 affectedBehavior:'subsystem-x',message:'Secondary cause',evidence:'B'};
const unmergedC={...aliasB,affectedBehavior:'subsystem-y',message:'Other risk',evidence:'C'};
const aliasBaseline=reconcileReviewFindings([aliasA,aliasB,unmergedC]);
const aId=aliasBaseline.ledger.find(row=>row.issue.contractId==='a-contract').findingId;
const bId=aliasBaseline.ledger.find(row=>row.issue.message==='Secondary cause').findingId;
const cId=aliasBaseline.ledger.find(row=>row.issue.message==='Other risk').findingId;
const joined=adjudicateReviewFindings([aliasA,aliasB,unmergedC],[
 {left:aId,right:bId,authority:'independently_verified',relation:'equivalent',witnessDigest:W}],
 bind([aliasA,aliasB,unmergedC],[{left:aId,right:bId,authority:'independently_verified',relation:'equivalent',witnessDigest:W}]));
assert.equal(joined.unique,2);
const mergedRow=joined.ledger.find(row=>row.relatedFindingIds.length===2);
const independentRow=joined.ledger.find(row=>row.relatedFindingIds.length===1);
assert(mergedRow.potentialDuplicateIds.includes(independentRow.findingId),
  'adjudication must retain B-C candidates when primary representative A differs');
assert(mergedRow.relatedFindingIds.includes(aId)&&mergedRow.relatedFindingIds.includes(bId));
assert(!mergedRow.relatedFindingIds.includes(cId));
const restored=adjudicateReviewFindings([b,a],[],{});
assert.equal(restored.ledger[0].observations.length,2);
const outcome=summarizeExecutionOutcome({status:'review_findings',route:{policy:{mode:'review'}},planCompleted:true,
 reviewCoverage:{complete:true},review:{issues:[a],verdict:'fix'},verification:[]});
assert.equal(outcome.reviewComplete,true);assert.equal(outcome.implementationComplete,null);
assert.equal(outcome.reviewFilesCoverageSource,'model_reported');
const reviewEvent={type:'review_progress',rawFindings:3,uniqueFindings:1,reconciledFindings:2,
 potentialDuplicates:0,verificationSource:'observed',observedExecuteCalls:2};
const meter=createEfficiencyRun('review-stabilization');meter.onEvent(reviewEvent);
meter.onEvent({type:'review_quality_assessed',mode:'observe',status:'not_enforced',total:3,assessed:1,open:2});
meter.onEvent({type:'review_quality_evidence_rejected',count:3,reasonCounts:{missing_finding:2,unsupported_risk_assessment:1,'/secret':4}});
const saved=normalizeEfficiencyRuns([meter.finish({status:'review_findings'})])[0];
assert.equal(saved.reviewObservations,3);assert.equal(saved.reviewCanonicalFindings,1);
assert.equal(saved.reviewConfirmedMerges,2);assert.equal(saved.reviewVerificationSource,'observed');
assert.equal(saved.reviewObservedExecuteCalls,2);
assert.equal(saved.reviewQualityGateMode,'observe');
assert.equal(saved.reviewRiskEvidenceRejectedReasons.missing_finding,2);
assert.equal(saved.reviewRiskEvidenceRejectedReasons['/secret'],undefined);
const unsafe=renderReviewFindings(reconcileReviewFindings([{...a,path:'src/a.ts\n### Forged heading',batchId:'B\n### Forged heading'}]).ledger);
assert.equal(unsafe.includes('\n### Forged heading'),false,'injected metadata must not create report sections');
const included=adjudicateReviewFindings([{...a,path:'src/state.ts'},{...a,path:'src/another.ts'}],[],{});
assert.equal(included.unique,2);
assert.equal(included.raw,2);
const sourceCount=review.ledger[0].observations.map(x=>x.evidence).length;
assert.equal(sourceCount,3,'full source evidence survives even when UI is bounded');
// Three audit passes also exercise deliberately hostile boundaries.
const invalid=adjudicateReviewFindings([a,b],null,{verifiedWitnessDigests:new Set([W])});
assert.equal(invalid.unique,1);
const unsupported=adjudicateReviewFindings(items,decisions);
assert.equal(unsupported.unique,3,'host-unverified digests cannot authorize a merge');
const rawCorpus=Array.from({length:75},(_,i)=>({...a,message:`Variant ${i}`,evidence:`Evidence ${i}`,
 reproductionKey:`reproduction-${i%25}`,batchId:`batch-${i%5}`,unitIds:[`F${i%8}`]}));
const baselineCorpus=reconcileReviewFindings(rawCorpus);
const permutedCorpus=reconcileReviewFindings([...rawCorpus].sort((x,y)=>y.message.localeCompare(x.message)));
assert.equal(baselineCorpus.unique,25);
assert.equal(baselineCorpus.raw,75);
assert.deepEqual(baselineCorpus.ledger.map(x=>x.findingId),permutedCorpus.ledger.map(x=>x.findingId));
assert.equal(baselineCorpus.ledger.reduce((n,x)=>n+x.observations.length,0),75);
assert.equal((renderReviewFindings(baselineCorpus.ledger).match(/^- \*\*RF-/gm)??[]).length,25);
assert.equal(adjudicateReviewFindings(rawCorpus).unique,25);
const polluted=createEfficiencyRun('adversarial-reasons');
polluted.onEvent({type:'review_quality_evidence_rejected',count:2,
 reasonCounts:JSON.parse('{"__proto__":1,"constructor":1,"missing_finding":1}')});
const kept=normalizeEfficiencyRuns([polluted.finish({status:'review_incomplete'})])[0];
assert.deepEqual(kept.reviewRiskEvidenceRejectedReasons,{missing_finding:1});
assert.equal({}.polluted,undefined);

console.log('review-stabilization: PASS');

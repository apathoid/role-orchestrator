import assert from 'node:assert/strict';
import { reconcileReviewFindings } from '../src/review-findings.mjs';
import { adjudicateReviewFindings } from '../src/evidence/adjudication.mjs';

const base={path:'src/review.ts',contractId:'state-machine',reproductionKey:'reconnect',failureMode:'stale-result',affectedBehavior:'restore',severity:'major'};
const issues=[{...base,message:'A',evidence:'trace A'},{...base,contractId:'other-state-machine',message:'B',evidence:'trace B'}];
const ledger=reconcileReviewFindings(issues).ledger;
const decision={left:ledger[0].findingId,right:ledger[1].findingId,authority:'independently_verified',relation:'equivalent',witnessDigest:'b'.repeat(64)};
const unscoped=adjudicateReviewFindings(issues,[decision],{sourceKey:'revision-B',scopeKey:'scope-B',verifiedWitnessDigests:new Set([decision.witnessDigest])});
assert.equal(unscoped.unique,2,'a bare digest must not authorize any scoped merge');
console.log('review-hardening: PASS');

// Controlled candidate discovery: candidates are hypotheses; false positives
// must never promote model claims into automatic adjudication.
const sample=(name,opts={})=>({path:`src/${name}.ts`,contractId:'',reproductionKey:'',
  failureMode:'',affectedBehavior:'',message:'',...opts});
const cases=[
 {truth:true, left:sample('one',{contractId:'reload',failureMode:'race',affectedBehavior:'cache',message:'Late update loses cache'}),
  right:sample('one',{contractId:'reload',failureMode:'race',affectedBehavior:'cache',message:'Old result overwrites cache'})},
 {truth:true,left:sample('one',{contractId:'reload',reproductionKey:'disconnect',failureMode:'race',affectedBehavior:'restore',message:'Network stale state'}),
  right:sample('two',{contractId:'reload',reproductionKey:'disconnect',failureMode:'timeout',affectedBehavior:'restore',message:'Restoring state stuck'})},
 {truth:true,left:sample('one',{contractId:'restore',failureMode:'stale-read',affectedBehavior:'document sync',message:'Misses latest snapshot'}),
  right:sample('one',{contractId:'restore',failureMode:'request lost',affectedBehavior:'document sync',message:'New state not delivered'})},
 {truth:true,left:sample('one',{contractId:'restore',failureMode:'dropped callback',affectedBehavior:'document sync',message:'Callbacks disappear'}),
  right:sample('two',{contractId:'restore',failureMode:'event lost',affectedBehavior:'document sync',message:'No subscription update'})},
 {truth:false,left:sample('one',{contractId:'transfer',reproductionKey:'first',failureMode:'race',message:'A'}),
  right:sample('one',{contractId:'transfer',reproductionKey:'second',failureMode:'race',message:'B'})},
 {truth:false,left:sample('one',{contractId:'alpha',failureMode:'race',message:'A'}),
  right:sample('one',{contractId:'beta',failureMode:'race',message:'B'})},
 {truth:false,left:sample('one',{contractId:'email',failureMode:'missing input',message:'Input empty'}),
  right:sample('one',{contractId:'auth',failureMode:'bad token',message:'Input empty'})},
 {truth:false,left:sample('one',{contractId:'first',reproductionKey:'same',failureMode:'race',message:'A'}),
  right:sample('two',{contractId:'second',reproductionKey:'same',failureMode:'race',message:'B'})},
 {truth:false,left:sample('one',{message:'Blank'}),right:sample('two',{message:'Blank'})},
];
const {findingCandidateReason}=await import('../src/evidence/similarity.mjs');
const measurement=list=>{
 let tp=0,fp=0,fn=0;
 for(const row of list){const hit=!!findingCandidateReason(row.left,row.right);
   if(row.truth&&hit)tp++; else if(row.truth)fn++;else if(hit)fp++;}
 return {tp,fp,fn,precision:tp/(tp+fp),recall:tp/(tp+fn)};
};
const measured=measurement(cases);
assert(measured.recall>=1,'all labeled true pairs in this fixture must be found');
assert(measured.fp<=1,'bounded false positives; discovery never performs merges');
for(const row of cases)if(!row.truth){
 assert.equal(adjudicateReviewFindings([row.left,row.right]).unique,2,'negative candidate must not be auto-merged');
}
console.log('candidate-corpus:',JSON.stringify(measured));

const { mergeReviewAttempt, makeReviewCheckpoint, validateReviewCheckpoint } = await import('../src/review-checkpoint.mjs');
const prior={batchId:'B1',unitIds:['F1'],output:{verdict:'escalate',summary:'Original issue',
  issues:[{...issues[0],message:'First discovery',evidence:'line 10'}],
  riskAssessments:[{riskId:'RR-1',status:'investigated',outcome:'issue_found',evidence:'Read original source'}],
  openQuestions:[{statement:'First question'}]}};
const incoming={verdict:'pass',summary:'Second inspection',issues:[
  {...issues[0],message:'First discovery',evidence:'line 10'},
  {...issues[0],message:'Additional evidence',evidence:'line 20'}],
  riskAssessments:[],openQuestions:[{statement:'Second question'}]};
const combined=mergeReviewAttempt(prior,incoming,{batchId:'B2',unitIds:['F1']});
assert.equal(combined.verdict,'escalate','retries cannot discard an earlier escalation');
assert.equal(combined.issues.length,2,'identical replay is idempotent but different evidence survives');
assert.deepEqual(combined.issues.map(issue=>issue.reportedBatchId),['B1','B2']);
assert.equal(combined.riskAssessments.length,1);
assert.equal(combined.openQuestions.length,2);
const replay=mergeReviewAttempt({...prior,output:combined},incoming,{batchId:'B3',unitIds:['F1']});
assert.equal(replay.issues.length,2,'replaying a completed observation must not duplicate it');
assert.equal(reconcileReviewFindings(combined.issues.map(issue=>({...issue,
  batchId:issue.reportedBatchId,unitIds:issue.reportedUnitIds}))).raw,2);
assert.equal(reconcileReviewFindings(combined.issues.map(issue=>({...issue,
  batchId:issue.reportedBatchId,unitIds:issue.reportedUnitIds}))).unique,1);
assert.throws(()=>mergeReviewAttempt(prior,{...incoming,
 issues:Array.from({length:61},(_,i)=>({...issues[0],message:`Evidence ${i}`}))},
 {batchId:'B2',unitIds:['F1']}),/limit_exceeded/,'never silently discard findings to meet a report cap');
const plan={version:1,planKey:'fixture',totalUnits:1,scope:{deniedFiles:0,status:'resolved'},units:[{
  id:'F1',kind:'criterion',dependencies:[],paths:[]}]};
const cp=makeReviewCheckpoint({scopeKey:'scope',repoKey:'source',plan,status:'in_progress',
 records:[{id:'F1',status:'checked',evidence:'Explicitly inspected the criterion source code.'}],
 reports:[{batchId:'B1',unitIds:['F1'],outputFormat:'structured',output:combined}]});
const checked=validateReviewCheckpoint(cp,{scopeKey:'scope',repoKey:'source',plan});
assert(checked,'merged retry checkpoint must remain resumable');
assert.deepEqual(checked.reports[0].output.issues.map(issue=>issue.reportedBatchId),['B1','B2']);
const damaged=structuredClone(cp);
damaged.reports[0].output.issues[0].reportedUnitIds=['not-a-real-unit'];
assert.equal(validateReviewCheckpoint(damaged,{scopeKey:'scope',repoKey:'source',plan}),null,
 'tampered observation provenance must invalidate restore rather than invent coverage');
console.log('retry-checkpoint: PASS');

const {reviewWitnessSubject}=await import('../src/evidence/adjudication.mjs');
const scopeKey='c'.repeat(64),sourceKey='d'.repeat(64);
const attestation={digest:decision.witnessDigest,
  subjectDigest:reviewWitnessSubject({left:ledger[0],right:ledger[1],decision,scopeKey,sourceKey}),
  origin:'trusted_host_verifier',verifierId:'verified-host-test',evidenceRefs:['host/review/123']};
const opts={scopeKey,sourceKey,verifiedWitnesses:[attestation]};
const safe=adjudicateReviewFindings(issues,[decision],opts);
assert.equal(safe.unique,1);
assert.equal(safe.semanticMerges,1);
assert.equal(safe.exactIdentityMerges,0);
assert.equal(safe.accepted.length,1);
assert.equal(safe.ledger[0].adjudicationWitnesses[0].verifierId,'verified-host-test');
for (const altered of [
 {...opts,sourceKey:'e'.repeat(64)},
 {...opts,scopeKey:'e'.repeat(64)},
 {...opts,verifiedWitnesses:[{...attestation,origin:'reviewer_self_attested'}]},
 {...opts,verifiedWitnesses:[{...attestation,evidenceRefs:[]}]},
 {...opts,verifiedWitnesses:[{...attestation,subjectDigest:'f'.repeat(64)}]},
 {...opts,verifiedWitnesses:[]},
]) assert.equal(adjudicateReviewFindings(issues,[decision],altered).unique,2,
 'replayed or malformed host verification must fail closed');
assert.equal(adjudicateReviewFindings([{...issues[0],evidence:'changed source witness'},issues[1]],
 [decision],opts).unique,2,'changed observations invalidate the pair-scoped witness even if finding IDs stay the same');
assert.equal(adjudicateReviewFindings(issues,[{...decision,rootCauseKey:'new root cause'}],opts).unique,2,
 'changing the equivalence claim invalidates its host subject');
const fakePeer={...issues[1],reproductionKey:'different-reproduction'};
const changedLedger=reconcileReviewFindings([issues[0],fakePeer]).ledger;
const changedDecision={...decision,left:changedLedger[0].findingId,right:changedLedger[1].findingId};
const invalidProof={...opts,verifiedWitnesses:[{
 ...attestation,subjectDigest:reviewWitnessSubject({left:changedLedger[0],right:changedLedger[1],
  decision:changedDecision,scopeKey,sourceKey})}]};
assert.equal(adjudicateReviewFindings([issues[0],fakePeer],[changedDecision],invalidProof).unique,2,
 'trusted verifier cannot override contradictory explicit reproduction keys');
const equivAcrossFiles=[{...issues[0],path:'a.ts'},{...issues[1],path:'b.ts'}];
const crossRows=reconcileReviewFindings(equivAcrossFiles).ledger;
const crossDecision={...decision,left:crossRows[0].findingId,right:crossRows[1].findingId,
 crossFile:true,rootCauseKey:'shared/root/cause'};
const crossWitness={...attestation,subjectDigest:reviewWitnessSubject({left:crossRows[0],right:crossRows[1],
 decision:crossDecision,scopeKey,sourceKey})};
assert.equal(adjudicateReviewFindings(equivAcrossFiles,[crossDecision],{
 ...opts,verifiedWitnesses:[crossWitness]}).unique,1);
assert.equal(adjudicateReviewFindings(equivAcrossFiles,[{...crossDecision,crossFile:false}],{
 ...opts,verifiedWitnesses:[crossWitness]}).unique,2);
const identical=adjudicateReviewFindings([issues[0],issues[0]],[],opts);
assert.equal(identical.unique,1);
assert.equal(identical.exactIdentityMerges,1);
assert.equal(identical.semanticMerges,0);
console.log('trust-boundary: PASS');

const {findingHypothesisGroups}=await import('../src/evidence/findings.mjs');
const largeCandidates=Array.from({length:80},(_,i)=>[
 {path:`src/item-${i}-a.ts`,contractId:`independent-${i}`,failureMode:'race',affectedBehavior:'subscription',message:`Report ${i} left`},
 {path:`src/item-${i}-b.ts`,contractId:`independent-${i}`,failureMode:'race',affectedBehavior:'subscription',message:`Report ${i} right`},
]).flat();
const discovered=findingHypothesisGroups(largeCandidates);
assert.equal(discovered.length,80,'large review must not silently lose semantic groups outside the first 128 findings');
assert.equal(findingHypothesisGroups([...largeCandidates].reverse()).length,80);
console.log('candidate-large-corpus: PASS (80 of 80 groups)');

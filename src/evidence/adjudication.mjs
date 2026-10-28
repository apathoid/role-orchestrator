// Host-witnessed equivalence, NEVER model-guessed equivalence. The checkpoint
// and its raw observations are immutable; only a derived ledger is grouped.
import { createHash } from 'node:crypto';
import { reconcileReviewFindings, composeReviewLedgerGroup } from '../review-findings.mjs';
import { normalizeFindingTerm as norm } from './similarity.mjs';

const sha = data => createHash('sha256').update(JSON.stringify(data)).digest('hex');
const hexDigest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const canonical = value => Array.isArray(value) ? value.map(canonical) :
  value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])) : value;
const pairKey = (a,b) => JSON.stringify([a,b].sort());

// An independent verifier sees the *raw* model observations and explicitly
// certifies one specific equivalence claim, in one repository revision/scope.
// The digest identifies the subject; it is NOT a signature or a proof that
// the host actually performed the claimed independent verification.
export function reviewWitnessSubject({left,right,decision,scopeKey,sourceKey}={}) {
  if (!left || !right || !hexDigest(sourceKey) || !hexDigest(scopeKey) ||
      typeof left.findingId !== 'string' || typeof right.findingId !== 'string' ||
      left.findingId === right.findingId || decision?.relation !== 'equivalent') return null;
  const records=[left,right].sort((a,b)=>a.findingId.localeCompare(b.findingId)).map(row=>({
    id:row.findingId, observationsDigest:sha((row.observations??[])
      .map(row=>JSON.stringify(canonical(row))).sort()),
  }));
  return sha(['review_equivalence_subject_v1',scopeKey,sourceKey,records,
    decision.crossFile === true, norm(decision.rootCauseKey)]);
}

export function adjudicateReviewFindings(issues=[],decisions=[],{
  sourceKey=null,scopeKey=null,verifiedWitnesses=[],verifiedWitnessDigests=null,
}={}) {
  const baseline=reconcileReviewFindings(issues);
  const ids=new Map(baseline.ledger.map(row=>[row.findingId,row]));
  const parent=new Map([...ids.keys()].map(id=>[id,id]));
  const root=id=>{while(parent.get(id)!==id)id=parent.get(id);return id;};
  const rejected=[], accepted=[];
  // Complete ordering includes competing certificates for the same pair;
  // otherwise the presentation can change solely from host array order.
  const edgeKey = decision => JSON.stringify([pairKey(decision?.left,decision?.right),
    norm(decision?.rootCauseKey),decision?.crossFile===true,decision?.witnessDigest??'',
    decision?.relation??'',decision?.authority??'']);
  const ordered=[...(Array.isArray(decisions)?decisions:[])].sort((a,b)=>edgeKey(a).localeCompare(edgeKey(b)));
  const witnessPool=Array.isArray(verifiedWitnesses) ? [...verifiedWitnesses].sort((a,b)=>
    JSON.stringify([a?.verifierId,a?.digest,a?.subjectDigest,a?.evidenceRefs]).localeCompare(
      JSON.stringify([b?.verifierId,b?.digest,b?.subjectDigest,b?.evidenceRefs]))) : [];
  const verifiedCauses=new Map([...ids.keys()].map(id=>[id,new Set()]));
  const members=id=>[...ids.keys()].filter(key=>root(key)===root(id)).map(key=>ids.get(key));
  for(const decision of ordered) {
    const left=ids.get(decision?.left),right=ids.get(decision?.right);
    if(!left||!right||left.findingId===right.findingId||decision.relation!=='equivalent'||
       decision.authority!=='independently_verified'||!hexDigest(decision.witnessDigest)) {
      rejected.push('invalid_equivalence_decision');continue;
    }
    const subjectDigest=reviewWitnessSubject({left,right,decision,scopeKey,sourceKey});
    const witness=witnessPool.find(item=>
      item?.digest===decision.witnessDigest && item.subjectDigest===subjectDigest &&
      item.origin==='trusted_host_verifier' && typeof item.verifierId==='string' &&
      item.verifierId.trim().length>=3 && item.verifierId.length<=120 &&
      Array.isArray(item.evidenceRefs) && item.evidenceRefs.length>0 && item.evidenceRefs.length<=16 &&
      item.evidenceRefs.every(x=>typeof x==='string'&&x.length>0&&x.length<=160));
    if(!subjectDigest || !witness) {
      // A bare verifiedWitnessDigests Set is retained as an accepted input
      // shape for old hosts, but it can never certify a scope-bound merge.
      rejected.push('unbound_or_unverified_witness');continue;
    }
    if(left.issue.path!==right.issue.path && (decision.crossFile!==true||
       typeof decision.rootCauseKey!=='string'||decision.rootCauseKey.trim().length<8||decision.rootCauseKey.length>300)) {
      rejected.push('cross_file_witness_required');continue;
    }
    if(root(left.findingId)===root(right.findingId)) continue;
    const joined=[...members(left.findingId),...members(right.findingId)];
    const reproductions=new Set(joined.map(row=>norm(row.issue.reproductionKey)).filter(Boolean));
    if(reproductions.size>1){rejected.push('different_reproduction');continue;}
    const crossFile=new Set(joined.map(row=>row.issue.path).filter(Boolean)).size>1;
    if(crossFile && (decision.crossFile!==true||!norm(decision.rootCauseKey))) {
      rejected.push('cross_file_witness_required');continue;
    }
    const lRoot=root(left.findingId),rRoot=root(right.findingId);
    const causes=new Set([...(verifiedCauses.get(lRoot)??[]),...(verifiedCauses.get(rRoot)??[])]);
    if(norm(decision.rootCauseKey))causes.add(norm(decision.rootCauseKey));
    if(crossFile&&causes.size>1){rejected.push('conflicting_root_cause');continue;}
    parent.set(rRoot,lRoot);
    verifiedCauses.set(lRoot,causes);verifiedCauses.delete(rRoot);
    accepted.push({left:left.findingId,right:right.findingId,witnessDigest:decision.witnessDigest,
      subjectDigest,verifierId:witness.verifierId,evidenceRefs:[...witness.evidenceRefs]});
  }
  const groups=new Map();
  for(const row of baseline.ledger){const id=root(row.findingId);const group=groups.get(id)??[];group.push(row);groups.set(id,group);}
  const ledger=[...groups.values()].map(group=>composeReviewLedgerGroup(group))
    .sort((a,b)=>a.findingId.localeCompare(b.findingId));
  const canonicalByOriginal=new Map(ledger.flatMap(row=>row.relatedFindingIds.map(id=>[id,row.findingId])));
  const linked=new Map(ledger.map(row=>[row.findingId,new Set()]));
  const candidatePairs=new Set();
  for(const edge of baseline.candidateEdges){
    const left=canonicalByOriginal.get(edge.left),right=canonicalByOriginal.get(edge.right);
    if(!left||!right||left===right)continue;
    candidatePairs.add(pairKey(left,right));
    linked.get(left).add(right);linked.get(right).add(left);
  }
  for(const row of ledger){
    row.potentialDuplicateIds=[...linked.get(row.findingId)].sort();
    const groupIds=new Set(row.relatedFindingIds);
    row.adjudicationWitnesses=accepted.filter(a=>groupIds.has(a.left)&&groupIds.has(a.right));
  }
  const potentialDuplicates=candidatePairs.size;
  const canonicalFindings=ledger.length;
  return {version:2,raw:baseline.raw,unique:canonicalFindings,canonicalFindings,
    reconciledDuplicates:baseline.raw-canonicalFindings,confirmedMerges:baseline.raw-canonicalFindings,
    exactIdentityMerges:baseline.raw-baseline.unique,semanticMerges:baseline.unique-canonicalFindings,
    potentialDuplicates,potentialDuplicatePairs:potentialDuplicates,rejected,accepted,ledger,
    issues:ledger.map(row=>row.issue)};
}

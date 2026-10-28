// Discovery only. Similarity is NEVER evidence of equivalence.
export const normalizeFindingTerm = x => typeof x === 'string' ? x.toLowerCase().normalize('NFKC').trim().replace(/\s+/g,' ') : '';
const keywords=x=>new Set(normalizeFindingTerm(x).match(/[\p{L}\p{N}_-]{5,}/gu) ?? []);
const overlap=(a,b)=>{const A=keywords(a),B=keywords(b);if(A.size<4||B.size<4)return 0;
  return [...A].filter(x=>B.has(x)).length/Math.max(A.size,B.size);};
export function findingCandidateReason(a,b) {
  const n=normalizeFindingTerm;
  const ac=n(a.contractId),bc=n(b.contractId),ar=n(a.reproductionKey),br=n(b.reproductionKey);
  const af=n(a.failureMode),bf=n(b.failureMode);
  // Contradictory explicit reproduction/contract identifiers are not evidence
  // of similarity, even when two reports happen to share the same file.
  if (ar && br && ar!==br) return null;
  if (ac && bc && ac!==bc && !(ar && ar===br)) return null;
  if (ar && ar===br && (!ac||!bc||ac===bc)) return 'same_reproduction_candidate';
  if (ac && ac===bc && af && af===bf) return 'same_contract_failure_candidate';
  // The same well-identified behavior can be described by disjoint failure
  // vocabulary, including across file boundaries. A candidate is not a merge.
  if (ac && ac===bc && n(a.affectedBehavior) && n(a.affectedBehavior)===n(b.affectedBehavior))
    return 'same_contract_behavior_candidate';
  if (n(a.path) && n(a.path)===n(b.path) && af && af===bf) return 'same_file_failure_candidate';
  if (n(a.path) && n(a.path)===n(b.path) && overlap(a.message,b.message)>=0.72) return 'textual_overlap_candidate';
  if (ac&&ac===bc&&overlap(a.message,b.message)>=0.55) return 'cross_file_contract_candidate';
  return null;
}

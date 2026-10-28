// Candidate discovery is a derived projection of the SAME review ledger.
// Similarity never certifies equivalence or authorizes a merge.
import { reconcileReviewFindings } from '../review-findings.mjs';
import { normalizeFindingTerm } from './similarity.mjs';

export function findingHypothesisGroups(observations=[]) {
  const {ledger,candidateEdges}=reconcileReviewFindings(observations);
  // Discovery already compared the complete bounded checkpoint corpus. An
  // arbitrary first-128-ID cutoff hides legitimate groups (and changes which
  // groups are shown based on hash sorting), despite retaining their edges.
  const limited=new Set(ledger.map(row=>row.findingId));
  const edges=candidateEdges.filter(edge=>limited.has(edge.left)&&limited.has(edge.right));
  const parent=new Map([...limited].map(id=>[id,id]));
  function root(id){while(parent.get(id)!==id)id=parent.get(id);return id;}
  for(const edge of edges)parent.set(root(edge.right),root(edge.left));
  const groups=new Map();
  for(const row of ledger){
    const id=root(row.findingId);const rows=groups.get(id)??[];rows.push(row);groups.set(id,rows);
  }
  return [...groups.values()].filter(g=>g.length>1).map(group=>{
    const ids=new Set(group.map(row=>row.findingId));
    return {count:group.length,relation:'potential_duplicate',confirmation:'required',
      findingIds:[...ids].sort(),paths:[...new Set(group.map(row=>row.issue.path).filter(Boolean))].sort(),
      reasons:[...new Set(edges.filter(e=>ids.has(e.left)&&ids.has(e.right)).map(e=>e.reason))].sort(),
      distinctReproductions:new Set(group.map(row=>normalizeFindingTerm(row.issue.reproductionKey)).filter(Boolean)).size};
  }).sort((a,b)=>a.findingIds[0].localeCompare(b.findingIds[0]));
}

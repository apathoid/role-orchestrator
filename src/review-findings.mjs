import { formatReviewSourceLocation } from './review-source-location.mjs';
// One derived, review-only ledger. Durable model observations live in the
// Review Operation checkpoint; reconciliation never rewrites that authority.
import { createHash } from 'node:crypto';
import { findingIdentity } from './quality-state.mjs';
import { findingCandidateReason, normalizeFindingTerm as normalize } from './evidence/similarity.mjs';
const shortHash = value => createHash('sha256').update(value).digest('hex').slice(0,16);
const priorities={blocking:3,major:2,minor:1};
const safeInline = value => String(value??'').replace(/[\r\n`<>\[\]]/g,' ').slice(0,240);
const variant = (items) => [...new Set(items.filter(x=>typeof x==='string'&&x.trim()))].sort();

function identity(issue) {
  const contract=normalize(issue?.contractId), reproduction=normalize(issue?.reproductionKey),path=normalize(issue?.path);
  const failure=normalize(issue?.failureMode),behavior=normalize(issue?.affectedBehavior);
  if (contract && reproduction && path) return `strong:${JSON.stringify([contract,reproduction,path,failure,behavior])}`;
  if (path && reproduction && failure && behavior) return `behavior:${JSON.stringify([path,reproduction,failure,behavior])}`;
  // Weak or missing identifiers are not proof of semantic equivalence.
  return `exact:${findingIdentity(issue)}`;
}
function publicIssue(issue) {
  const {batchId:_batchId,unitIds:_unitIds,reportedBatchId:_reportedBatchId,reportedUnitIds:_reportedUnitIds,...clean}=issue;
  return clean;
}
function normalizedObservation(issue) {
  return { ...publicIssue(issue),batchId:typeof issue.batchId==='string'?issue.batchId:null,
    unitIds:Array.isArray(issue.unitIds)?issue.unitIds.filter(x=>typeof x==='string').slice(0,64):[] };
}
// Stable representative across batch ordering and checkpoint restoration.
function orderObservations(a,b) {
  const priority=(priorities[b.severity]??0)-(priorities[a.severity]??0);
  const identityOf = issue => {
    const clean=publicIssue(issue);
    return JSON.stringify(Object.keys(clean).sort().map(key=>[key,clean[key]]));
  };
  // Provenance (batch/unit) must never determine which message is canonical.
  return priority || identityOf(a).localeCompare(identityOf(b),'en');
}
export function composeReviewLedgerGroup(rows,{canonicalId}={}) {
  const observations=rows.flatMap(row=>row.observations??[]).sort(orderObservations);
  const issues=observations.map(publicIssue);
  const primary=issues[0]??{};
  const severityVariants=variant(issues.map(issue=>issue.severity));
  const originVariants=variant(issues.map(issue=>issue.origin));
  const highest=severityVariants.reduce((value,level)=>
    (priorities[level]??0)>(priorities[value]??0)?level:value,'');
  const origins=new Set(originVariants.map(x=>x==='preexisting'?'pre_existing':x));
  const origin=origins.size===1?[...origins][0]:'unknown';
  const evidence=variant(issues.map(issue=>issue.evidence));
  const findingIds=variant(rows.flatMap(row=>[row.findingId,...(row.relatedFindingIds??[])]));
  const findingId=canonicalId??findingIds[0];
  return {
    findingId,identityKey:rows.length===1?rows[0].identityKey:`adjudicated:${findingId}`,
    relatedFindingIds:findingIds, relatedPaths:variant(issues.map(issue=>issue.path)),
    severityVariants,originVariants,observations,
    occurrences:observations.map(x=>({batchId:x.batchId,unitIds:x.unitIds})),
    evidence,
    issue:{...primary,findingId,severity:highest||primary.severity,origin,
      evidence:evidence.join('\n---\n').slice(0,1800)},
  };
}
export function reconcileReviewFindings(issues) {
  const entries=new Map();let raw=0;
  for(const issue of issues??[]) {
    if(!issue||typeof issue!=='object'||Array.isArray(issue)) continue;
    raw++;
    const key=identity(issue);
    const entry=entries.get(key)??{findingId:`RF-${shortHash(key)}`,identityKey:key,observations:[]};
    entry.observations.push(normalizedObservation(issue));entries.set(key,entry);
  }
  const ledger=[...entries.values()].map(row=>composeReviewLedgerGroup([row]))
    .sort((a,b)=>a.findingId.localeCompare(b.findingId));
  const candidates=[];
  for(let i=0;i<ledger.length;i++)for(let j=i+1;j<ledger.length;j++) {
    const reason=findingCandidateReason(ledger[i].issue,ledger[j].issue);
    if(reason)candidates.push({left:ledger[i].findingId,right:ledger[j].findingId,reason});
  }
  const linked=new Map(ledger.map(row=>[row.findingId,[]]));
  for(const edge of candidates){linked.get(edge.left).push(edge.right);linked.get(edge.right).push(edge.left);}
  for(const row of ledger)row.potentialDuplicateIds=linked.get(row.findingId).sort();
  return {version:2,raw,unique:ledger.length,canonicalFindings:ledger.length,
    reconciledDuplicates:raw-ledger.length,confirmedMerges:raw-ledger.length,
    exactIdentityMerges:raw-ledger.length,semanticMerges:0,
    potentialDuplicates:candidates.length,potentialDuplicatePairs:candidates.length,
    candidateEdges:candidates,ledger,issues:ledger.map(row=>row.issue)};
}

// The renderer cannot add model-generated findings, nor can it remove any
// canonical records. Any unverified relation is displayed as uncertainty.
export function renderReviewFindings(ledger,{locations=new Map()}={}) {
  if(!ledger?.length)return 'Структурированных замечаний не поступило.';
  return ledger.map(({findingId,issue,evidence=[],observations=[],severityVariants=[],originVariants=[],relatedFindingIds=[],relatedPaths=[],potentialDuplicateIds=[],adjudicationWitnesses=[]})=>{
    const resolved=locations.get(findingId);
    const location=resolved?` (${formatReviewSourceLocation(resolved)})`:issue.path?` (\`${String(issue.path).replace(/[\r\n`]/g,' ').slice(0,120)}\`)`:'';
    const witness=typeof issue.evidence==='string'&&issue.evidence.trim()
      ?`\n   - Свидетельства: ${issue.evidence.replace(/[\r\n]+/g,' ').slice(0,480)}`:'';
    const origin=['introduced','exposed_existing','pre_existing','preexisting','related'].includes(issue.origin)
      ?`\n   - Происхождение (оценка reviewer, не независимое подтверждение): ${issue.origin}`:'';
    const fix=typeof issue.suggestedFix==='string'&&issue.suggestedFix.trim()
      ?`\n   - Рекомендация: ${issue.suggestedFix.replace(/[\r\n]+/g,' ').slice(0,330)}`:'';
    const conflicts=severityVariants.length>1?`\n   - Оценки severity: ${severityVariants.map(safeInline).join(', ')}; показана максимальная.`:'';
    const origins=originVariants.length>1?`\n   - Противоречивые оценки происхождения: ${originVariants.map(safeInline).join(', ')} (не подтверждено).`:'';
    const duplicates=potentialDuplicateIds.length?`\n   - Возможные дубликаты (не объединены): ${potentialDuplicateIds.slice(0,8).join(', ')}${potentialDuplicateIds.length>8?' …':''}.`:'';
    const aliases=relatedFindingIds.length>1?`\n   - Объединены идентификаторы: ${relatedFindingIds.join(', ')} (независимо подтверждено).`:'';
    const otherPaths=relatedPaths.length>1?`\n   - Связанные файлы: ${relatedPaths.map(path=>`\`${safeInline(path)}\``).join(', ')}.`:'';
    const witnesses=adjudicationWitnesses.length
      ? `\n   - Независимое подтверждение, заявленное host: ${adjudicationWitnesses.map(w=>
        `${safeInline(w.verifierId)} (${w.witnessDigest.slice(0,12)}, ${w.evidenceRefs.length} ссылок)`).join('; ')}; статус зависит от доверия к host.` : '';
    const sources=observations.length>1?`\n   - Наблюдений: ${observations.length}; batches: ${variant(observations.map(x=>x.batchId)).slice(0,12).map(safeInline).join(', ')||'неизвестны'}; evidence записей: ${evidence.length}.`:'';
    return `- **${findingId} · ${issue.severity??'unknown'}**${location}: ${String(issue.message??'').replace(/[\r\n]+/g,' ').slice(0,500)}${witness}${origin}${fix}${conflicts}${origins}${duplicates}${aliases}${witnesses}${otherPaths}${sources}`;
  }).join('\n');
}

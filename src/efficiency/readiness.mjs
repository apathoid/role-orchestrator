// Read-only readiness diagnostics. A missing provider counter is not a monitor failure.
const count = (xs, predicate) => xs.filter(predicate).length;
export function efficiencyReadiness(runs = []) {
  const invocations = runs.flatMap(run => Array.isArray(run?.invocations) ? run.invocations : []);
  const total = invocations.length;
  const composition = count(invocations, r=>Number.isSafeInteger(r.contextProfile?.promptCharacters));
  const boundary = count(invocations, r=>Number.isSafeInteger(r.providerPromptProfile?.characters));
  const occupancy = count(invocations, r=>Number.isSafeInteger(r.contextOccupancy?.peak));
  const exactInput = count(invocations, r=>Number.isSafeInteger(r.usage?.inputTokens));
  const exactOutput = count(invocations, r=>Number.isSafeInteger(r.usage?.outputTokens));
  const timing = count(invocations, r=>Number.isSafeInteger(r.elapsedMs) &&
    (r.firstActivityElapsedMs === null || r.firstActivityElapsedMs === undefined || r.firstActivityElapsedMs <= r.elapsedMs));
  const categorized = count(invocations, r=>r.contextProfile?.taskBody?.sections?.some(s=>s.kind!=='other' && s.characters>0));
  const largeUnclassified = count(invocations, r=>(r.contextProfile?.taskBody?.sections?.find(s=>s.kind==='other')?.characters ?? 0)>10_000);
  const toolsObserved=count(invocations,r=>r.toolMetrics?.version===2);
  const toolUnknownKinds=invocations.reduce((n,r)=>n+(r.toolMetrics?.kindCoverage?.unknown??0),0);
  const toolUnknownContent=invocations.reduce((n,r)=>n+(r.toolMetrics?.contentCoverage?.unknown??0),0);
  const toolTruncated=count(invocations,r=>r.toolMetrics?.truncated===true);
  const problems=[];
  if (total && composition<total) problems.push('prepared_context_missing');
  if (total && timing<total) problems.push('timing_inconsistent');
  if (total && boundary<total) problems.push('provider_boundary_not_observed');
  if (largeUnclassified) problems.push('large_unclassified_task_body');
  if (toolTruncated) problems.push('tool_observations_truncated');
  return {invocations:total, coverage:{composition,boundary,occupancy,exactInput,exactOutput,timing,categorized,largeUnclassified,toolsObserved,toolUnknownKinds,toolUnknownContent,toolTruncated},
    providerTokenUsage:exactInput===total&&exactOutput===total&&total>0?'complete':exactInput||exactOutput?'partial':'not_reported',
    problems, note:'Context occupancy is not cumulative input usage. Coverage counts are independent; provider-added hidden instructions remain unknown.'};
}

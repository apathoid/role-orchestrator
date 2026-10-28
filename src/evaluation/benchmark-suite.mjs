// Offline, independently adjudicated scenario comparison. No model outputs
// are interpreted as ground truth, and absent usage never becomes zero.
import { evaluateQuality, compareQuality } from './efficiency-quality.mjs';
function median(values) {
  if (!values.length) return null;
  const ordered=[...values].sort((a,b)=>a-b),middle=Math.floor(ordered.length/2);
  return ordered.length%2 ? ordered[middle] : (ordered[middle-1]+ordered[middle])/2;
}
export function evaluateBenchmarkSuite({ scenarios=[], minRuns=2 }={}) {
  if (!Array.isArray(scenarios) || !scenarios.length || scenarios.length>100 ||
      !Number.isInteger(minRuns) || minRuns<1 || minRuns>30) throw new Error('Invalid benchmark suite');
  const results=[];
  const unique=new Set();
  for (const scenario of scenarios) {
    if (typeof scenario?.id !== 'string' || !/^[a-zA-Z0-9_.-]{1,100}$/.test(scenario.id) || unique.has(scenario.id) ||
        !Array.isArray(scenario.baselineRuns) || !Array.isArray(scenario.candidateRuns))
      throw new Error('Invalid or duplicate benchmark scenario');
    unique.add(scenario.id);
    const inputs={...scenario.adjudication};
    const base=scenario.baselineRuns.map(run=>evaluateQuality({...inputs,...run,
      expectedFindings:inputs.expectedFindings, blockerMajorIds:inputs.blockerMajorIds,
      mandatoryObligations:inputs.mandatoryObligations}));
    const next=scenario.candidateRuns.map(run=>evaluateQuality({...inputs,...run,
      expectedFindings:inputs.expectedFindings, blockerMajorIds:inputs.blockerMajorIds,
      mandatoryObligations:inputs.mandatoryObligations}));
    const comparisons=next.map((candidate,i)=>compareQuality(base[Math.min(i,base.length-1)],candidate));
    const dataSufficient=base.length>=minRuns && next.length>=minRuns;
    const qualityAccepted=dataSufficient && comparisons.every(c=>c.acceptedQuality);
    const costs=arr=>({invocationsMedian:median(arr.map(x=>x.efficiency.invocations).filter(x=>x!==null)),
      tokenMedian:arr.every(x=>x.efficiency.inputTokens!==null && x.efficiency.outputTokens!==null)
        ? median(arr.map(x=>x.efficiency.inputTokens+x.efficiency.outputTokens)) : null,
      elapsedMedian:arr.every(x=>x.efficiency.elapsedMs!==null)
        ? median(arr.map(x=>x.efficiency.elapsedMs)) : null,
      quotaMedian:arr.every(x=>x.efficiency.quotaPercentage!==null)
        ? median(arr.map(x=>x.efficiency.quotaPercentage)) : null});
    const baseline=costs(base), candidate=costs(next);
    const reduction=(before,after)=>before>0 && after!==null ? 1-after/before : null;
    results.push({id:scenario.id, runs:{baseline:base.length,candidate:next.length},
      qualityStatus:!dataSufficient?'insufficient_evidence':qualityAccepted?'accepted':'regressed',
      baseline,candidate, reductions:{invocations:reduction(baseline.invocationsMedian,candidate.invocationsMedian),
        tokens:reduction(baseline.tokenMedian,candidate.tokenMedian),
        elapsed:reduction(baseline.elapsedMedian,candidate.elapsedMedian),
        quota:reduction(baseline.quotaMedian,candidate.quotaMedian)},
      minCriticalMisses:Math.min(...next.map(x=>x.quality.criticalMisses)),
      maxCriticalMisses:Math.max(...next.map(x=>x.quality.criticalMisses))});
  }
  return {version:1,status:results.some(x=>x.qualityStatus==='regressed')?'rejected':
    results.some(x=>x.qualityStatus==='insufficient_evidence')?'insufficient_evidence':'accepted',scenarios:results};
}

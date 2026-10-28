// Offline adjudication. Ground-truth IDs must be written by a human or by an
// independently verified fixture; model-produced counts are not truth labels.
const ids = values => {
  if (!Array.isArray(values) || values.some(x => typeof x !== 'string' || !/^[a-zA-Z0-9_.:-]{1,100}$/.test(x)))
    throw new Error('Adjudicated findings must have stable bounded IDs');
  return new Set(values);
};
export function evaluateQuality({ expectedFindings, reportedFindings, blockerMajorIds = [],
  mandatoryObligations = [], verifiedObligations = [], measurements = {} } = {}) {
  const expected = ids(expectedFindings), reported = ids(reportedFindings), critical = ids(blockerMajorIds);
  const mandatory = ids(mandatoryObligations), verified = ids(verifiedObligations);
  for (const id of critical) if (!expected.has(id)) throw new Error('Critical ID missing from adjudicated findings');
  const hits = [...reported].filter(id => expected.has(id));
  const falsePositives = [...reported].filter(id => !expected.has(id));
  const missed = [...expected].filter(id => !reported.has(id));
  const uncovered = [...mandatory].filter(id => !verified.has(id));
  const precision = reported.size ? hits.length / reported.size : expected.size ? 0 : 1;
  const recall = expected.size ? hits.length / expected.size : 1;
  const quality = { expected:expected.size, reported:reported.size, truePositive:hits.length,
    falsePositive:falsePositives.length, missed:missed.length,
    criticalMisses:[...critical].filter(id => !reported.has(id)).length,
    precision, recall, mandatoryCoverage:mandatory.size ? (mandatory.size-uncovered.length)/mandatory.size : 1,
    uncoveredObligations:uncovered.length };
  const usage = x => Number.isSafeInteger(x) && x >= 0 ? x : null;
  return { version:1, quality, efficiency: { invocations:usage(measurements.invocations),
    elapsedMs:usage(measurements.elapsedMs), inputTokens:usage(measurements.inputTokens),
    outputTokens:usage(measurements.outputTokens), quotaPercentage:typeof measurements.quotaPercentage === 'number' &&
    measurements.quotaPercentage>=0 && measurements.quotaPercentage<=100 ? measurements.quotaPercentage : null,
    usageSource:['provider_reported','external_observation'].includes(measurements.usageSource) ? measurements.usageSource : 'unknown' } };
}
export function compareQuality(baseline, candidate) {
  const a=baseline.quality,b=candidate.quality;
  return { acceptedQuality: b.criticalMisses <= a.criticalMisses && b.recall >= a.recall && b.precision >= a.precision &&
    b.mandatoryCoverage >= a.mandatoryCoverage,
    invocationReduction: baseline.efficiency.invocations && candidate.efficiency.invocations !== null
      ? 1-candidate.efficiency.invocations/baseline.efficiency.invocations : null,
    tokenReduction: baseline.efficiency.inputTokens && candidate.efficiency.inputTokens !== null
      ? 1-candidate.efficiency.inputTokens/baseline.efficiency.inputTokens : null };
}

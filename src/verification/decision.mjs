// Deterministic verification advice: never runs tools or upgrades evidence.
export function chooseVerification({ obligations = [], evidence = [], availableCommands = [], risk = {} } = {}) {
  const outstanding = obligations.filter(row => row.status !== 'satisfied');
  if (!outstanding.length) return { required:false, strategy:'none', obligationIds:[], reason:'coverage_complete' };
  const haveExecutedTests = evidence.some(e => e.kind === 'tool_result' && e.level === 'tool_observed' && e.passed);
  const hasTestCommand = availableCommands.some(cmd => typeof cmd === 'string' && /(?:test|vitest|pytest|jest)/i.test(cmd));
  const needsIndependent = risk.security === true || risk.concurrency === true;
  return { required:true, strategy:needsIndependent ? 'independent_review' : hasTestCommand && !haveExecutedTests ? 'targeted_test' : 'source_inspection',
    obligationIds:outstanding.map(row => row.id), reason: needsIndependent ? 'risk_requires_independent_analysis'
      : hasTestCommand && !haveExecutedTests ? 'relevant_test_available' : 'unverified_coverage' };
}

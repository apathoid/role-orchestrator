// Deterministic verification advice: never runs tools or upgrades evidence.
// availableCommands is an operator-approved subset, NOT a model discovery list.
export function chooseVerification({ obligations = [], evidence = [], availableCommands = [], risk = {} } = {}) {
  const outstanding = obligations.filter(row => row.status !== 'satisfied');
  if (!outstanding.length) return { required:false, strategy:'none', obligationIds:[], reason:'coverage_complete' };
  const haveExecutedTests = evidence.some(e => e.kind === 'tool_result' && e.level === 'tool_observed' && e.passed);
  // The caller supplies the trusted, operator-approved verification subset.
  // Command spelling is not a security policy or a universal test classifier.
  // Project-specific tools, languages and custom checkers are all eligible.
  const hasTestCommand = Array.isArray(availableCommands) &&
    availableCommands.some(cmd => typeof cmd === 'string' && cmd.trim().length > 0);
  const needsIndependent = risk.security === true || risk.concurrency === true;
  return { required:true, strategy:needsIndependent ? 'independent_review' : hasTestCommand && !haveExecutedTests ? 'targeted_test' : 'source_inspection',
    obligationIds:outstanding.map(row => row.id), reason: needsIndependent ? 'risk_requires_independent_analysis'
      : hasTestCommand && !haveExecutedTests ? 'relevant_test_available' : 'unverified_coverage' };
}

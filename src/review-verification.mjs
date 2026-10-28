// Only workflow-executed checks have an authoritative test disposition.
// Provider tool metadata may prove a command ran, never an exact test count.
export function createReviewToolEvidenceObserver() {
  const tools = new Map();
  return {
    observe(event) {
      if (event?.type !== 'role_tool_event' || !event.invocationId) return;
      const update = event.update ?? {};
      const observed = event.toolObservation ?? {};
      const toolId = observed.toolId ?? update.toolCallId;
      if (typeof toolId !== 'string' || !toolId) return;
      const id = `${event.invocationId}:${toolId}`;
      const row = tools.get(id) ?? { kind: null, completed: false };
      const kind = observed.kind ?? update.kind;
      if (typeof kind === 'string') row.kind = kind;
      const status = observed.status ?? update.status;
      if (typeof status === 'string' && ['completed', 'failed', 'cancelled'].includes(status))
        row.completed = status === 'completed';
      tools.set(id, row);
    },
    snapshot() {
      return { completedExecuteCalls: [...tools.values()].filter((row) => row.kind === 'execute' && row.completed).length };
    },
  };
}

export function reviewVerificationEvidence(verification, toolObservation = null) {
  if (!Array.isArray(verification) || verification.length === 0)
    return { source: toolObservation?.completedExecuteCalls > 0 ? 'observed' : 'unverified',
      observedExecuteCalls: Number.isSafeInteger(toolObservation?.completedExecuteCalls)
        ? toolObservation.completedExecuteCalls : 0,
      confirmedChecks: 0, passedChecks: 0, testCount: null, testCountVerified: false };
  return { source: 'workflow', observedExecuteCalls: toolObservation?.completedExecuteCalls ?? 0,
    confirmedChecks: verification.length,
    passedChecks: verification.filter((row) => row?.status === 'PASS').length,
    testCount: null, testCountVerified: false };
}
export function sanitizeUnverifiedTestCounts(markdown, evidence) {
  if (evidence?.testCountVerified) return markdown;
  // Fail closed only on numeric claims of tests passing, not on cited file
  // line numbers, finding severities or legitimate counts of review units.
  return String(markdown).replace(/(?<![\p{L}\d])\d{1,7}\s+(?:(?:успешно\s+)?(?:пройденных?|успешных?)\s+)?тест(?:ов|а)?(?![\p{L}])|\b\d{1,7}\s+tests?\s+(?:passed|succeeded)\b|\b(?:passed|succeeded)\s+\d{1,7}\s+tests?\b/giu,
    'тесты (точное число не подтверждено)');
}

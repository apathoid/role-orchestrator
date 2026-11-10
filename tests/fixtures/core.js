export const request = overrides => ({
  schemaVersion: 1, requestId: 'request-1', text: 'Literal task', attachments: [],
  userConstraints: [], configurationRef: 'test-config', ...overrides,
});

export const assessment = overrides => ({
  author: 'primary', overall: 'partial', requirements: [], observationRefs: [], findingRefs: [],
  unresolvedQuestions: [], answer: 'A partial answer', ...overrides,
});

export const decision = overrides => ({
  schemaVersion: 1, decisionId: 'decision-1', operationId: 'op-1', contextCursor: 0,
  additions: [], cancellations: [], finalAssessment: assessment(), ...overrides,
});

export const outcome = (attemptId, overrides) => ({
  schemaVersion: 1, attemptId, terminal: 'completed', effect: 'none', diagnostics: [], outputRefs: [],
  usage: { inputTokens: null, outputTokens: null, cost: null }, ...overrides,
});

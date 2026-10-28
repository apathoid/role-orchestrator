// Risk signals based on source inventory, NOT model assertions and NOT an authorization gate.
const highRiskPaths = /(?:^|\/)(?:auth|security|permissions?|crypto|payments?|migrations?|access-control)(?:\/|\.|-)/i;
const asyncPaths = /(?:socket|stream|concurren|worker|thunk|queue|reconnect|lifecycle|abort|transaction)/i;
export function assessReviewWorkload(scope, classification = {}, contract = {}) {
  const paths = scope?.available ? (scope.paths ?? []).map(x => x.path) : null;
  const sources = paths ?? [];
  const userChecks = (contract.checks ?? []).filter(x=> x.source === 'user');
  const riskFlags = Object.freeze({ security: sources.some(x => highRiskPaths.test(x)) || classification.risk === 'security_or_data',
    concurrency: sources.some(x => asyncPaths.test(x)), crossSubsystem: new Set(sources.map(x => x.split('/').slice(0, 3).join('/'))).size > 2 });
  const highRisk = riskFlags.security || classification.risk === 'security_or_data';
  const uncertain = !paths || scope.status !== 'resolved' || classification.risk === 'unknown';
  const mediumRisk = riskFlags.concurrency || riskFlags.crossSubsystem || classification.risk === 'architecture' ||
    userChecks.some(x => /critical|безопасност|гонк|race condition|целостност/iu.test(x.description));
  return Object.freeze({ files: paths?.length ?? null, riskFlags, highRisk, mediumRisk, uncertain,
    confidence: uncertain ? 'partial' : 'complete' });
}

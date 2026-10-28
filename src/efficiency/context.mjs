// Conservative role-aware context selection: authoritative content remains in
// workflow body/Engineering Core; historical reductions require explicit opt-in.
import { createHash } from 'node:crypto';
import { buildSessionContextText } from '../conversation-context.mjs';
const BUDGETS = Object.freeze({ router: [24000, 8], responderLow: [24000, 8], responderMedium: [32000, 12], responderHigh: [40000, 16], explorer: [64000, 20] });
export function compileRoleHistory(session, role, { mode = 'legacy', savedPlan = false } = {}) {
  const full = buildSessionContextText(session);
  const allow = mode === 'conservative' && savedPlan && BUDGETS[role];
  const [maxChars, maxFullTurns] = allow ? BUDGETS[role] : [120000, 32];
  const text = allow ? buildSessionContextText(session, { maxChars, maxFullTurns, maxSummaryChars: 16000 }) : full;
  // Only the historical context is reduced, never userTask, plan, security,
  // current findings or review coverage supplied via other role sections.
  return {
    text, manifest: { role, mode: allow ? 'bounded_historical' : 'legacy', originalChars: full.length,
      includedChars: text.length, historyReduced: text.length < full.length,
      fingerprint: createHash('sha256').update(text).digest('hex'),
      completeness: allow && text.length < full.length ? 'historical_partial' : 'complete' },
  };
}
// An untrusted role report is a hint, never a verified P2 evidence record.
export function researchHandoff(exploration, { maxChars = 12000 } = {}) {
  if (!exploration || typeof exploration !== 'object' || exploration.format === 'text') return null;
  // Only compact a known schema; anything unrecognized must remain available.
  const allowed = new Set(['summary', 'relevantFiles', 'constraints', 'existingPatterns', 'likelyVerification', 'unknowns']);
  if (Object.keys(exploration).some(key => !allowed.has(key))) return null;
  const text = JSON.stringify({ ...exploration, provenance: 'explorer_role_report_unverified' });
  if (text.length > maxChars || !String(exploration.summary ?? '').trim()) return null;
  return { text, source: 'explorer_role_report', completeness: 'unverified', sourceFileCount: exploration.relevantFiles?.length ?? 0 };
}

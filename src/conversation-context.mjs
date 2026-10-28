const DEFAULT_MAX_CONTEXT_CHARS = 120_000;
const DEFAULT_MAX_FULL_TURNS = 32;
const DEFAULT_MAX_SUMMARY_CHARS = 16_000;
const DEFAULT_MAX_TITLE_CHARS = 60;
const DEFAULT_MAX_TITLE_WORDS = 8;

function cleanText(value) {
  return String(value ?? '').replace(/\r\n/g, '\n').trim();
}

function formatAttachment(ref) {
  if (!ref || typeof ref !== 'object') return '';
  const fields = [
    typeof ref.id === 'string' ? `id=${ref.id}` : null,
    typeof ref.type === 'string' ? `type=${ref.type}` : null,
    typeof ref.mimeType === 'string' ? `mimeType=${ref.mimeType}` : null,
    Number.isFinite(ref.size) ? `size=${Math.max(0, Math.floor(ref.size))}` : null,
    ref.persisted === true ? 'persisted=true' : 'persisted=false',
    typeof ref.reason === 'string' ? `reason=${ref.reason}` : null,
    typeof ref.uri === 'string' ? `uri=${ref.uri}` : null,
  ].filter(Boolean);
  return fields.length ? `- [attachment ${fields.join(' ')}]` : '';
}

function formatTurn(turn, index) {
  const user = cleanText(turn?.user) || '[non-text prompt context]';
  const assistant = cleanText(turn?.assistant) || '[no persisted assistant response]';
  const attachments = Array.isArray(turn?.attachments)
    ? turn.attachments.map(formatAttachment).filter(Boolean).join('\n')
    : '';
  const attachmentSection = attachments
    ? `\n\nUser attachments from this turn (historical metadata; payloads may be rehydrated separately):\n${attachments}`
    : '';
  return `Turn ${index + 1}:\nUser:\n${user}${attachmentSection}\n\nAssistant:\n${assistant}`;
}

function formatSummary(item, index) {
  const user = cleanText(item?.user) || '[non-text prompt context]';
  const result = cleanText(item?.result) || '[no compact result]';
  return `Earlier turn ${index + 1}:\nUser: ${user}\nResult: ${result}`;
}

/**
 * Builds continuity context for fresh inner role sessions.
 *
 * Inner Codex sessions are intentionally invocation-scoped, so the outer ACP
 * conversation must be supplied explicitly. Preserve recent turns verbatim
 * instead of reducing every follow-up to orchestration summaries. A separate
 * bounded workflow-memory layer preserves useful explorer/review findings that
 * may not have appeared in the final assistant answer.
 */
export function buildSessionContextText(session, {
  maxChars = DEFAULT_MAX_CONTEXT_CHARS,
  maxFullTurns = DEFAULT_MAX_FULL_TURNS,
  maxSummaryChars = DEFAULT_MAX_SUMMARY_CHARS,
} = {}) {
  const transcript = Array.isArray(session?.transcript) ? session.transcript : [];
  const history = Array.isArray(session?.history) ? session.history : [];
  if (!transcript.length && !history.length) return '';

  const full = [];
  let used = 0;
  const start = Math.max(0, transcript.length - Math.max(1, maxFullTurns));
  for (let i = transcript.length - 1; i >= start; i -= 1) {
    const block = formatTurn(transcript[i], i);
    const cost = block.length + (full.length ? 2 : 0);
    if (full.length && used + cost > maxChars) break;
    // Always retain at least the latest full turn, clipping only in the
    // pathological case where that single turn exceeds the whole budget.
    if (!full.length && cost > maxChars) {
      const keep = Math.max(1_000, maxChars);
      full.unshift(`${block.slice(0, Math.floor(keep * 0.65))}\n\n[…middle omitted for context budget…]\n\n${block.slice(-Math.floor(keep * 0.35))}`);
      used = full[0].length;
      break;
    }
    full.unshift(block);
    used += cost;
  }

  const parts = [];
  // Keep a bounded workflow-memory layer even for recent verbatim turns. The
  // user-facing answer is not guaranteed to contain every useful explorer/
  // review finding, so these compact records preserve important orchestration
  // evidence across outer turns without requiring persistent inner sessions.
  if (history.length && maxSummaryChars > 0) {
    const summaries = [];
    let summaryChars = 0;
    for (let i = history.length - 1; i >= 0; i -= 1) {
      const block = formatSummary(history[i], i);
      const cost = block.length + (summaries.length ? 2 : 0);
      if (summaries.length && summaryChars + cost > maxSummaryChars) break;
      summaries.unshift(block);
      summaryChars += cost;
    }
    if (summaries.length) parts.push(`OUTER SESSION WORKFLOW MEMORY (historical; preserve constraints/findings, but re-check mutable repository facts when needed):\n${summaries.join('\n\n')}`);
  }

  if (full.length) {
    parts.push(`OUTER CONVERSATION — RECENT TURNS VERBATIM (historical dialogue, not a new role contract):\n${full.join('\n\n')}`);
  }
  return parts.join('\n\n');
}

export function compactSessionTitle(value, fallback = '') {
  let text = cleanText(value) || cleanText(fallback);
  if (!text) return '';

  text = text
    .replace(/^#+\s*/, '')
    .replace(/^ORCHESTRATOR ROLE BOUNDARY\s*:\s*/i, '')
    .replace(/^ROLE (?:BOUNDARY|CONTRACT|INSTRUCTIONS)\s*:\s*/i, '')
    .replace(/\s+/g, ' ')
    .replace(/^["'`]+|["'`]+$/g, '')
    .trim();

  const words = text.split(/\s+/).filter(Boolean);
  if (words.length > DEFAULT_MAX_TITLE_WORDS) text = words.slice(0, DEFAULT_MAX_TITLE_WORDS).join(' ');
  if (text.length > DEFAULT_MAX_TITLE_CHARS) {
    const clipped = text.slice(0, DEFAULT_MAX_TITLE_CHARS + 1);
    const boundary = clipped.lastIndexOf(' ');
    text = (boundary >= 24 ? clipped.slice(0, boundary) : clipped.slice(0, DEFAULT_MAX_TITLE_CHARS)).trim();
  }
  return text.replace(/[\s:;,.!?—–-]+$/u, '').trim();
}

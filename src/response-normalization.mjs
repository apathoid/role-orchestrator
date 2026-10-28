// Normalize only a complete, user-facing Markdown response. Never attempt
// this on structured outputs or on partially published ACP chunks.
export function normalizeFinalMarkdown(text, { preserveLiteral = false } = {}) {
  if (preserveLiteral || typeof text !== 'string') return text;
  const match = text.trim().match(/^```(?:markdown|md)\s*\n([\s\S]*?)\n```$/i);
  if (!match) return text;
  const body = match[1];
  // Require evidence that the fenced content is a document, not an example.
  return /^(?:#{1,6}\s|[-*]\s|\d+\.\s)/m.test(body) ? body.trim() : text;
}

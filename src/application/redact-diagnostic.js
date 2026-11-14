/**
 * Conservative diagnostic projection. This intentionally does not promise to
 * find secrets hidden in arbitrary natural language.
 * @param {unknown} value
 * @param {{secrets?: readonly string[], captureBodies?: boolean}} [options]
 * @returns {unknown}
 */
export function redactDiagnostic(value, { secrets = [], captureBodies = false } = {}) {
  const known = secrets.filter(s => typeof s === 'string' && s.length >= 4);
  const sensitive = /(?:password|secret|credential|token|api[_-]?key|authorization|cookie|private[_-]?key)/i;
  const body = /^(?:prompt|rawPrompt|requestBody|responseBody|toolBody|toolInput|toolOutput|body|input|output)$/i;
  /** @param {unknown} node @param {string} [key] @returns {unknown} */
  function visit(node, key = '') {
    if (sensitive.test(key)) return '[REDACTED]';
    if (!captureBodies && body.test(key)) return '[BODY OMITTED]';
    if (typeof node === 'string') {
      let text = node
        .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/-]+=*/gi, '$1 [REDACTED]')
        .replace(/(https?:\/\/)[^/@\s:]+:[^/@\s]+@/gi, '$1[REDACTED]@');
      for (const secret of known) text = text.replaceAll(secret, '[REDACTED]');
      return text;
    }
    if (Array.isArray(node)) return node.map(item => visit(item));
    if (node && typeof node === 'object') {
      /** @type {Record<string, unknown>} */
      const result = {};
      for (const [name, child] of Object.entries(node)) {
        if (name === '__proto__' || name === 'constructor') continue;
        result[name] = visit(child, name);
      }
      return result;
    }
    return node;
  }
  return visit(value);
}

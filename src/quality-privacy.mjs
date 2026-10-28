// Minimize durable data at the writer. This sanitizer is defense in depth, not
// a substitute for excluding arbitrary argv, raw output and environment data.
const patterns = [
  /-----BEGIN (?:[A-Z ]* )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]* )?PRIVATE KEY-----/gi,
  /\b(?:Bearer\s+)[a-z0-9._~+\/-]{8,}/gi,
  /\b(?:sk-(?:proj-)?|gh[pousr]_|github_pat_|glpat-|xox[baprs]-|AKIA|ASIA)[a-z0-9_\-]{8,}/gi,
  // Full URL userinfo (including percent encoding) must never be preserved.
  /([a-z][a-z\d+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi,
  /(?:--?(?:token|password|passwd|secret|api[-_]?key|access[-_]?key|auth[-_]?token))\s*(?:=|\s+)\s*(?:"[^"]*"|'[^']*'|[^\s;]+)/gi,
  /(?:-H|--header)\s*(?:=|\s+)\s*(?:"?Authorization\s*:\s*(?:Bearer|Basic)\s+)[^\s"']+/gi,
  /\b(?:[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|ACCESS_KEY)[A-Z0-9_]*)\s*[:=]\s*(?:["']?)[^\s,;"']{4,}["']?/gi,
];
export function sanitizeQualityText(value, limit = 1200) {
  let str = String(value ?? '');
  for (const pattern of patterns) str = str.replace(pattern, '[REDACTED]');
  return str.slice(0, limit);
}
export function sanitizeQualityValue(value) {
  if (typeof value === 'string') return sanitizeQualityText(value);
  if (Array.isArray(value)) return value.map(sanitizeQualityValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, v]) =>
    [key, /(?:^|[_-])(?:token|password|passwd|secret|authorization|apiKey|privateKey|credential)(?:$|[_-])/i.test(key) ? '[REDACTED]' : sanitizeQualityValue(v)]));
  return value;
}

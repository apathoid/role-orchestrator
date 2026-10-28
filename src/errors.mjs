const GENERIC_UPSTREAM_ERROR = /^(?:internal error|request failed|unknown error)(?:\:\s*)?$/i;
const ERROR_DETAIL_KEYS = [
  'message', 'details', 'detail', 'reason', 'error_description', 'errorDescription',
  'additionalDetails', 'title', 'type', 'code', 'codexErrorInfo',
];
const ERROR_CONTAINER_KEYS = ['error', 'cause'];

function diagnosticStrings(value, depth = 0, seen = new Set()) {
  if (value == null || depth > 4) return [];
  if (typeof value === 'string') return value.trim() ? [value.trim()] : [];
  if (typeof value === 'number' || typeof value === 'boolean') return [String(value)];
  if (typeof value !== 'object' || seen.has(value)) return [];
  seen.add(value);
  if (Array.isArray(value)) return value.flatMap((item) => diagnosticStrings(item, depth + 1, seen));
  const result = [];
  const keys = [
    ...ERROR_DETAIL_KEYS.filter((key) => Object.hasOwn(value, key)),
    ...ERROR_CONTAINER_KEYS.filter((key) => Object.hasOwn(value, key)),
  ];
  for (const key of keys) {
    const child = value[key];
    if (child == null) continue;
    const strings = diagnosticStrings(child, depth + 1, seen);
    for (const text of strings) {
      const rendered = ERROR_DETAIL_KEYS.includes(key) ? text : `${key}: ${text}`;
      if (!result.includes(rendered)) result.push(rendered);
      if (result.length >= 8) return result;
    }
  }
  return result;
}

function safeErrorValue(value, depth = 0, seen = new Set()) {
  if (value == null || depth > 4) return undefined;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value !== 'object' || seen.has(value)) return undefined;
  seen.add(value);
  if (Array.isArray(value)) {
    const items = value.map((item) => safeErrorValue(item, depth + 1, seen)).filter((item) => item !== undefined);
    return items.length ? items : undefined;
  }
  const out = {};
  for (const key of [...ERROR_DETAIL_KEYS, ...ERROR_CONTAINER_KEYS]) {
    if (!Object.hasOwn(value, key)) continue;
    const child = safeErrorValue(value[key], depth + 1, seen);
    if (child !== undefined) out[key] = child;
  }
  return Object.keys(out).length ? out : undefined;
}

export function safeUpstreamErrorData(value) {
  return safeErrorValue(value);
}

export function upstreamErrorDiagnostic(error, streamedText = '') {
  const base = String(error?.message ?? error ?? 'Unknown provider error').trim();
  const candidates = [String(streamedText ?? '').trim(), ...diagnosticStrings(error?.data)].filter(Boolean);
  const details = [];
  for (const candidate of candidates) {
    const compact = candidate.replace(/\s+/g, ' ').trim().slice(0, 2_000);
    if (!compact || compact === base || base.includes(compact) || details.includes(compact)) continue;
    details.push(compact);
    if (details.length >= 3) break;
  }
  if (!details.length) return base;
  if (GENERIC_UPSTREAM_ERROR.test(base)) return `${base}: ${details.join(' — ')}`;
  return `${base} — ${details.join(' — ')}`;
}

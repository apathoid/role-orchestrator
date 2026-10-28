// ACP-specific, lossy privacy boundary for P3 measurements. The original
// update continues on the native presentation path unchanged. No tool output,
// names, arguments, paths, titles or IDs survive persistence.
export const ACP_TOOL_KINDS = Object.freeze(['read','edit','delete','move','search','execute','think','fetch','switch_mode','other']);
const KINDS = new Set(ACP_TOOL_KINDS);
const own = (obj, field) => Object.prototype.hasOwnProperty.call(obj, field);
const MAX_CONTENT_ITEMS = 2048;
const MAX_CHARS = 50_000_000;

function sumStrings(strings) {
  let characters = 0, utf8Bytes = 0;
  for (const value of strings) {
    if (typeof value !== 'string') return null;
    characters += value.length;
    if (characters > MAX_CHARS) return null;
    utf8Bytes += Buffer.byteLength(value, 'utf8');
    if (characters > MAX_CHARS || utf8Bytes > MAX_CHARS) return null;
  }
  return { characters, utf8Bytes };
}
function contentItem(item) {
  if (!item || typeof item !== 'object') return null;
  if (item.type === 'content') {
    const inner = item.content;
    if (inner?.type === 'text') return sumStrings([inner.text]);
    if (inner?.type === 'resource' && typeof inner.resource?.text === 'string') return sumStrings([inner.resource.text]);
    return null;
  }
  if (item.type === 'diff') {
    // ACP diffs are source-like text. Count only the diff text, never paths.
    const entries = [item.oldText,item.newText].filter(x => typeof x === 'string');
    return entries.length ? sumStrings(entries) : null;
  }
  // Compat for v1 adapters which expose a bare TextContent rather than its
  // ACP ToolCallContent wrapper.
  if ((item.type === 'text' || item.type === undefined) && typeof item.text === 'string') return sumStrings([item.text]);
  return null; // images, terminals and unknown blocks: volume is not known
}
function measureContent(value, operation) {
  if (operation === 'replace' && (value === null || (Array.isArray(value) && value.length === 0))) {
    return { semantics:'clear', textCharacters:0, textUtf8Bytes:0, coverage:'complete' };
  }
  const items = operation === 'append' ? [value] : value;
  if (!Array.isArray(items)) return { semantics:operation, textCharacters:null, textUtf8Bytes:null, coverage:'unknown' };
  let characters=0, utf8Bytes=0, unknown=false;
  for (const item of items.slice(0,MAX_CONTENT_ITEMS)) {
    const part=contentItem(item);
    if (!part) { unknown=true; continue; }
    characters+=part.characters; utf8Bytes+=part.utf8Bytes;
    if (characters>MAX_CHARS || utf8Bytes>MAX_CHARS) return {semantics:operation,textCharacters:null,textUtf8Bytes:null,coverage:'unknown'};
  }
  if (items.length>MAX_CONTENT_ITEMS) unknown=true;
  return {semantics:operation,textCharacters:unknown&&!characters?null:characters,textUtf8Bytes:unknown&&!characters?null:utf8Bytes,coverage:unknown?(characters?'partial':'unknown'):'complete'};
}
function safeKind(kind) { return KINDS.has(kind) ? kind : 'unknown'; }
// Limited, explicitly marked inference for known ACP adapter tool names. Kind
// declared by the provider always wins. No command/title matching or parsing.
function inferredKind(name) {
  if (typeof name !== 'string') return null;
  if (/^(?:read_file|fs\/read_text_file|open_file)$/i.test(name)) return 'read';
  if (/^(?:write_file|edit_file|apply_patch)$/i.test(name)) return 'edit';
  if (/^(?:search|grep|find_files)$/i.test(name)) return 'search';
  return null;
}
// Never infer v2 from an upsert alone: v1 has an identically named update.
// The negotiated protocol is authoritative; chunk notifications are v2-only.
export function acpObservationVersion(protocolVersion, update) {
  if (update?.sessionUpdate === 'tool_call_content_chunk') return 'v2';
  return protocolVersion === 2 || /^2(?:\.|$)/.test(String(protocolVersion ?? '')) ? 'v2' : 'v1';
}
/** Pure conversion. Omitted properties remain omitted for patch semantics. */
export function normalizeAcpToolObservation(update, { version = 'v1' } = {}) {
  if (!update || typeof update !== 'object' || !['tool_call','tool_call_update','tool_call_content_chunk'].includes(update.sessionUpdate)) return null;
  const toolId=update.toolCallId;
  if (typeof toolId !== 'string' || !toolId || toolId.length>256) return null;
  const operation=update.sessionUpdate === 'tool_call_content_chunk' ? 'append_content' : 'upsert';
  const result={type:'tool_observation',toolId,operation};
  if (own(update,'kind')) {
    if (update.kind === null && version === 'v2') result.kind=null;
    else if (typeof update.kind === 'string') { result.kind=safeKind(update.kind);result.kindSource='declared'; }
  } else if (own(update,'name')) {
    const inferred=inferredKind(update.name);
    if (inferred) {result.kind=inferred;result.kindSource='inferred';}
  }
  if (own(update,'status')) {
    if (update.status === null && version === 'v2') result.status=null;
    else if (typeof update.status === 'string') result.status=update.status;
  }
  if (operation === 'append_content') result.content=measureContent(update.content,'append');
  else if (own(update,'content')) result.content=measureContent(update.content,'replace');
  return result;
}

// Malformed telemetry must never interrupt an otherwise valid provider turn.
export function safeNormalizeAcpToolObservation(update, options) {
  try { return normalizeAcpToolObservation(update, options); }
  catch { return null; }
}

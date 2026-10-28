import { assertShape } from './schemas.mjs';
import { taskSpecFailureCode } from './routing/task-spec.mjs';
import { routingOutputFailureCode } from './routing/output-failures.mjs';

function stripSingleJsonFence(text) {
  const match = text.match(/^\s*```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/i);
  return match ? match[1].trim() : null;
}

function extractBalancedJsonObjects(text) {
  const objects = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    // Ignore punctuation in commentary outside JSON objects.
    if (depth === 0 && ch !== '{') continue;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') { if (depth === 0) start = i; depth += 1; }
    else if (ch === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) { objects.push(text.slice(start, i + 1)); start = -1; }
    }
  }
  return { objects, incomplete: depth > 0 };
}

function rawStateText({ finalText = '', unphasedText = '' }) {
  const final = String(finalText ?? '').trim();
  const unphased = String(unphasedText ?? '').trim();
  return final || unphased;
}

function structuredCandidates({ finalText = '', unphasedText = '' }) {
  const raw = [finalText, unphasedText]
    .map(text => String(text ?? '').trim()).filter(Boolean);
  if (raw.length === 2) raw.push(`${raw[0]}${raw[1]}`, `${raw[1]}${raw[0]}`);
  const candidates = [];
  const seen = new Set();
  const add = (value, source) => {
    const text = String(value ?? '').trim();
    if (!text || seen.has(text)) return;
    seen.add(text);
    candidates.push({ text, source });
  };
  for (const [index, text] of raw.entries()) {
    add(text, `raw-${index + 1}`);
    const fenced = stripSingleJsonFence(text);
    if (fenced) add(fenced, `fenced-${index + 1}`);
    for (const object of extractBalancedJsonObjects(text).objects) add(object, `embedded-${index + 1}`);
  }
  return candidates;
}

// Machine decisions are stricter than user-facing role outputs. Only one
// complete object in the authoritative final-answer channel can be accepted.
// This is structural interpretation, never language-based intent extraction.
function routingCandidate(state) {
  const final = String(state?.finalText ?? '').trim();
  const raw = final || String(state?.unphasedText ?? '').trim();
  const baseSource = final ? 'final-answer' : 'unphased-answer';
  const fenced = stripSingleJsonFence(raw);
  const candidateText = fenced ?? raw;
  const scan = extractBalancedJsonObjects(candidateText);
  const diagnostics = {stage:'structured_extraction',jsonRecognized:false,taskPresent:false,
    incomplete:false,ambiguousFragments:false,code:null,taskFailureCode:null,outputFailureCode:null};
  const fail = (code, stage = diagnostics.stage) => {
    const error = new Error(code);
    error.code = code;
    error.diagnostics = {...diagnostics,code,stage};
    error.raw = raw;
    throw error;
  };
  if (!candidateText) fail('ROUTER_OUTPUT_UNSTRUCTURED');
  if (scan.objects.length > 1) {
    diagnostics.ambiguousFragments = true;
    fail('ROUTER_OUTPUT_AMBIGUOUS');
  }
  if (scan.incomplete) {
    diagnostics.incomplete = true;
    fail('ROUTER_OUTPUT_INCOMPLETE');
  }
  if (!scan.objects.length) {
    fail(/[{}]|^```(?:json)?/i.test(candidateText) ? 'ROUTER_OUTPUT_MALFORMED' : 'ROUTER_OUTPUT_UNSTRUCTURED');
  }
  // Without an explicit final-answer channel, a JSON sample embedded in
  // unphased commentary is NOT sufficient authority for a machine decision.
  if (!final && candidateText !== scan.objects[0]) fail('ROUTER_OUTPUT_UNSTRUCTURED');
  // Accept one object in the final channel, possibly surrounded by commentary. Do not combine
  // unrelated channels, or prefer the first among competing fragments.
  let parsed;
  try { parsed = JSON.parse(scan.objects[0]); }
  catch { fail('ROUTER_OUTPUT_MALFORMED'); }
  diagnostics.jsonRecognized = true;
  diagnostics.taskPresent = Object.hasOwn(parsed ?? {}, 'task');
  try { assertShape('routing', parsed); }
  catch (error) {
    // Keep the precise, allowlisted nested failure without exposing model text.
    diagnostics.taskFailureCode = taskSpecFailureCode(error);
    diagnostics.outputFailureCode = routingOutputFailureCode(error);
    fail(error.code === 'ROUTER_TASK_MISSING' ? 'ROUTER_TASK_MISSING' :
      diagnostics.taskFailureCode !== null ||
      (diagnostics.taskPresent && (!parsed.task || typeof parsed.task !== 'object' || Array.isArray(parsed.task)))
        ? 'ROUTER_TASK_INVALID' : 'ROUTER_OUTPUT_INVALID', 'shape_validation');
  }
  return {parsed,raw:scan.objects[0],source:fenced?'fenced-final':baseSource,
    diagnostics:{...diagnostics,stage:'validated'}};
}

export function parseStructuredState(state, schemaKind) {
  if (schemaKind === 'routing') return routingCandidate(state);
  const errors = [];
  for (const candidate of structuredCandidates(state)) {
    try {
      const parsed = JSON.parse(candidate.text);
      assertShape(schemaKind, parsed);
      return {parsed,source:candidate.source,raw:candidate.text};
    } catch (error) { errors.push(`${candidate.source}: ${error.message}`); }
  }
  const error = new Error(errors.length ? errors.join(' | ') : 'No candidate JSON object was found.');
  error.raw = rawStateText(state);
  throw error;
}

// Text recovery is for displaying role output, never for authorizing a Router
// decision. Machine-readable diagnostics must not include prompt/output text.
export function parseStructuredStateOrText(state, schemaKind) {
  const rawText = rawStateText(state);
  try {
    const structured = parseStructuredState(state, schemaKind);
    return {format:'structured',data:structured.parsed,rawText,source:structured.source,
      parseError:null,...(structured.diagnostics ? {diagnostics:structured.diagnostics} : {})};
  } catch (error) {
    return {format:'text',text:rawText,rawText,source:null,parseError:error.message,
      ...(schemaKind === 'routing' ? {diagnostics:error.diagnostics ?? {
        stage:'structured_extraction',jsonRecognized:false,taskPresent:false,
        incomplete:false,ambiguousFragments:false,code:'ROUTER_OUTPUT_UNSTRUCTURED',taskFailureCode:null,outputFailureCode:null,
      }} : {})};
  }
}

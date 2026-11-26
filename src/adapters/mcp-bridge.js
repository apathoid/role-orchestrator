import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { boundedFieldError, count, decode, id, optional, record } from '../core/decode.js';
import { controllerIntentInputDescription } from '../application/controller-intent-instructions.js';
import { contextReference, historyCursor } from '../core/contracts.js';
import { createPendingControllerDecisions } from './controller-proposals.js';

/** @import {Invocation} from '../core/ports.js' */
/** @import {IncomingMessage, ServerResponse} from 'node:http' */

export const bridgeName = 'role_orchestrator';
const maxRequestBytes = 32 * 1024;
const maxDecisionRequestBytes = 2 * 1024 * 1024;
const maxDecisionCalls = 128;
const maxResponseBytes = 256 * 1024;
const maxConcurrentCalls = 4;
const toolStatuses = new Set(['completed', 'failed', 'truncated', 'invalid_input', 'denied', 'unavailable', 'closed', 'unknown', 'budget']);
const toolEffects = new Set(['none', 'possible', 'unknown']);
const versions = new Set(['2025-03-26', '2025-06-18', '2025-11-25']);

const listArgs = record({ cursor: optional(historyCursor) });
const fetchArgs = record({
  ref: contextReference,
  sourceOperationId: optional(id),
  offset: optional(count),
  maxBytes: optional(count),
});

const evidenceListArgs = record({cursor:optional(count)});
const evidenceFetchArgs = record({ref:id,offset:optional(count),maxBytes:optional(count)});
const countSchema = { type: 'integer', minimum: 0 };
const listTool = {
  name: 'context_list', description: 'Optionally list visible historical records by page. Copy nextCursor exactly to continue the same journal-prefix traversal; omit cursor or use 0 to start a fresh traversal. A directory page describes its traversal, not all later records. Capture completeness is independent of projection omissions.',
  inputSchema: { type: 'object', properties: { cursor: { anyOf: [{type:'integer',enum:[0]}, { type: 'object',
    properties: { revision: countSchema, index: countSchema }, required: ['revision','index'], additionalProperties: false }] } }, additionalProperties: false },
};
const decisionShortDescription = 'Register a ControllerIntent proposal; replaces must identify a registered ref in this invocation. Receipt is not admission or native turn completion; finalAssessment.answer need not be repeated.';
const decisionTool = {
  name: 'submit_decision',
  // Annotation only: no new nested constraints that could suppress delivery
  // of malformed replacements before the existing registration boundary.
  description: decisionShortDescription + ' registered:true is a registration fact, not guaranteed replacement eligibility; registered:false means not registered; if absent, no registration fact is provided. Native work may continue.\n' + controllerIntentInputDescription,
  inputSchema: { type:'object', properties:{ intent:{}, replaces:{type:'string'} }, required:['intent'], additionalProperties:false },
};
const fetchShortDescription = 'Retrieve a visible historical record by ref or directory position. Optional offset reads bounded base64 byte chunks of saved UTF-8/JSON or binary data; nextOffset locates further saved bytes. Source completeness and truncation remain as recorded; a complete chunk or exhausted offset does not restore missing source data.';
const fetchTool = {
  name: 'context_fetch', description: fetchShortDescription + ' Optional sourceOperationId selects another operation only under existing trusted sharing permissions; maxBytes limits a range response only when offset is supplied.',
  inputSchema: { type: 'object', properties: {
    ref: { anyOf: [{ type: 'string', minLength: 1 }, { type: 'object',
      properties: { revision: countSchema, index: countSchema }, required: ['revision', 'index'], additionalProperties: false }] },
    sourceOperationId: { type: 'string', minLength: 1 },
    offset: countSchema,
    maxBytes: countSchema,
  }, required: ['ref'], additionalProperties: false },
};

const evidenceListTool = {
  name:'evidence_list',
  description:'Optional directory of accepted observations in this invocation (append-only, up to 12 positions per page), not a native tool or capability inventory.\nIdentity: canonical ref identifies a record, not proof; source/provenance attribute the report. Native title/kind are provider-reported; inheritedFields marks earlier same-call values.\nAvailability: completeness describes capture, not tool success. hasCapturedValue, if present, indicates a stored value, not guaranteed fetch access. native.omittedFields marks capture-metadata omissions; omittedMetadataFields marks projection omissions. Positional unavailable entries are budget gaps, not tool failures.\nPaging: pass resumeCursor as cursor to read later, even after an empty/exhausted page; nextCursor signals more entries already captured.',
  inputSchema:{type:'object',properties:{cursor:countSchema},additionalProperties:false},
};
const evidenceFetchShortDescription = 'Read an accepted current-invocation observation by canonical ref. Chunk fields: base64 (bounded saved bytes), format (utf8/json), offset, totalBytes, nextOffset (byte offset for the next chunk). Missing ref, unavailable payload, closed scope and budget are access outcomes, not capture completeness or tool status. Exhausted bytes do not establish full source capture or durable commit.';
const evidenceFetchTool = {
  name:'evidence_fetch',
  description:evidenceFetchShortDescription + ' Optional maxBytes limits saved bytes in a chunk; maxBytes alone reads from offset 0.',
  inputSchema:{type:'object',properties:{ref:{type:'string',minLength:1},offset:countSchema,maxBytes:countSchema},required:['ref'],additionalProperties:false},
};

/** @param {boolean} enabled
 *  @param {{contextListToolName?:string,contextFetchToolName?:string,evidenceListToolName?:string,evidenceFetchToolName?:string}} [names]
 *  @param {Invocation['kind']} [kind] */
export function retrievalDetail(enabled, names = {}, kind = 'controller') {
  const list = names.contextListToolName ?? 'context_list';
  const fetch = names.contextFetchToolName ?? 'context_fetch';
  const context = enabled
    ? 'Optional MCP ' + list + ' and ' + fetch + ' retrieve scoped historical records when useful.' +
      (kind === 'delegate' ? ' Report material unavailable evidence explicitly.' : '')
    : kind === 'controller'
      ? 'Context retrieval is unavailable in this transport via MCP. Optional nextController.contextRequest can still select saved refs, positions, byte offsets or journal-prefix cursors (copy nextCursor exactly; 0 starts a fresh traversal) for a subsequent Controller turn without MCP; report material missing evidence when relevant.'
      : 'Historical context retrieval via MCP is unavailable in this transport. Supplied context retains its original scope and completeness.';
  return context + (names.evidenceListToolName && names.evidenceFetchToolName
    ? '\nOptional current-invocation MCP ' + names.evidenceListToolName + ' and ' + names.evidenceFetchToolName +
      ' expose accepted observations and canonical refs. Live observations are not durable until committed.'
    : '');
}

/** @param {unknown} value @returns {Record<string, unknown> | undefined} */
function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? /** @type {Record<string, unknown>} */ (value) : undefined;
}

/**
 * Return a bounded, model-visible MCP reply. Only in-flight ordinary requests
 * and bounded control receipts are retained for request-ID correlation.
 * Never retain an arbitrary completed ToolPort payload beyond settlement.
 * @param {unknown} value @param {string | number} requestId @param {boolean} [control]
 */
function toolReply(value, requestId, control = false) {
  const text = JSON.stringify(value);
  const full = { content: [{ type: 'text', text }], ...(object(value)?.kind === 'rejected' && {isError:true}) };
  // The JSON-RPC envelope and request id also consume response bytes.
  if (Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', id: requestId, result: full })) <= maxResponseBytes) {
    return full;
  }
  // The tool has already run. Limit the MCP representation, not its
  // receipt or execution status. A missing output is a delivery error,
  // not evidence of a no-effect pre-dispatch refusal.
  const tool = object(value);
  // A very large control request ID can consume nearly the entire envelope.
  // New receipt annotations must not replace a previously deliverable cause.
  // Only our own control receipts are eligible; external payloads are untouched.
  if (control && tool && Object.hasOwn(tool,'registered')) {
    const {registered: _registered, reason, ...rest} = tool;
    const detail = object(reason);
    if (detail && (Object.hasOwn(detail,'allowedFields') || Object.hasOwn(detail,'hint'))) {
      const {allowedFields: _fields, hint: _hint, ...primary} = detail;
      return toolReply({...tool, reason:primary}, requestId, true);
    }
    return toolReply({...rest, ...(reason !== undefined && {reason})}, requestId);
  }
  const limited = tool && typeof tool.status === 'string' && toolStatuses.has(tool.status) &&
      typeof tool.effect === 'string' && toolEffects.has(tool.effect)
    ? { status: tool.status, effect: tool.effect,
        ...(typeof tool.callId === 'string' ? { callId: tool.callId } : {}),
        ...(typeof tool.ref === 'string' ? { ref: tool.ref } : {}),
        outputUnavailableReason: 'budget' }
    : { kind: 'unavailable', reason: 'budget',
        effect: tool && typeof tool.effect === 'string' && toolEffects.has(tool.effect) ? tool.effect : 'unknown',
        ...(typeof tool?.callId === 'string' ? { callId: tool.callId } : {}),
        ...(typeof tool?.ref === 'string' ? { ref: tool.ref } : {}) };
  return { content: [{ type: 'text', text: JSON.stringify(limited) }], isError: true };
}

/** @param {IncomingMessage} request @param {number} limit */
async function readRequest(request, limit) {
  let total = 0;
  /** @type {Buffer[]} */
  const chunks = [];
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    total += chunk.length;
    if (total > limit) return {message:undefined,bytes:total};
    chunks.push(chunk);
  }
  try { return { message: object(JSON.parse(Buffer.concat(chunks).toString('utf8'))), bytes: total }; }
  catch { return undefined; }
}

/**
 * Stateless Streamable HTTP endpoint for one invocation. It binds only loopback,
 * uses an unguessable attempt URL and exposes only the supplied live ports.
 * @param {Pick<Invocation, 'contextAccess' | 'evidenceAccess' | 'preflightIntent' | 'externalTools' | 'signal' | 'controllerDelivery' | 'isActive'> & {attemptId?: string}} invocation
 */
export async function startMcpBridge({ contextAccess, evidenceAccess, preflightIntent, externalTools, signal, attemptId, controllerDelivery, isActive }) {
  signal.throwIfAborted();
  const path = '/' + randomUUID();
  let closed = false;
  const pendingDecision = controllerDelivery === 'intent_mcp' && attemptId
    ? createPendingControllerDecisions({ signal, attemptId, isActive, preflight:preflightIntent }) : undefined;
  // External tools share the MCP namespace. Use an unambiguous name for
  // the built-in control tool rather than silently shadowing any configured
  // external tool (including submit_decision itself).
  const listedExternalTools = externalTools?.list() ?? [];
  const externalNames = new Set(listedExternalTools.map(item => item.id));
  const reservedNames = new Set(externalNames);
  /** @param {string} name */
  function builtinName(name) {
    if (!reservedNames.has(name)) {
      reservedNames.add(name);
      return name;
    }
    const prefix = 'role_orchestrator_' + name;
    for (let i=0;;i++) {
      const candidate = i === 0 ? prefix : prefix + '_' + i;
      if (!reservedNames.has(candidate)) {
        reservedNames.add(candidate);
        return candidate;
      }
    }
  }
  const decisionToolName = pendingDecision ? builtinName(decisionTool.name) : undefined;
  const contextListToolName = contextAccess ? builtinName(listTool.name) : undefined;
  const contextFetchToolName = contextAccess ? builtinName(fetchTool.name) : undefined;
  const evidenceListToolName = evidenceAccess ? builtinName(evidenceListTool.name) : undefined;
  const evidenceFetchToolName = evidenceAccess ? builtinName(evidenceFetchTool.name) : undefined;
  let decisionCalls = 0;
  // Ordinary correlation exists only while a call is in flight. A completed
  // request id may be delivered again and run anew: no transport exactly-once.
  /** @type {Map<string | number, {fingerprint: string, response: Promise<unknown>}>} */
  const calls = new Map();
  // Control submissions have stronger invocation-local request-id identity.
  // Store only a content digest and a bounded receipt, not full request args.
  /** @type {Map<string | number, {fingerprint: string, response: Promise<unknown>}>} */
  const controlCalls = new Map();
  let active = 0;

  /** @param {import('../core/decode.js').FieldError} reason */
  function invalidInput(reason) {
    return {kind:'unavailable', reason:'invalid_input', diagnostic:boundedFieldError(reason)};
  }

  /** @param {string} name @param {unknown} args */
  async function callTool(name, args) {
    if (closed || signal.aborted) return { kind: 'unavailable', reason: 'closed' };
    // Controller submission is a separate bounded control plane, never one
    // of the ordinary concurrent native tool slots.
    if (name === decisionToolName && pendingDecision) return pendingDecision.register(args);
    active++;
    try {
      if (name === contextListToolName && contextAccess) {
        const parsed = decode(listArgs, args);
        return parsed.kind === 'accepted' ? contextAccess.list(parsed.value.cursor) : invalidInput(parsed.reason);
      }
      if (name === contextFetchToolName && contextAccess) {
        const parsed = decode(fetchArgs, args);
        if (parsed.kind === 'rejected') return invalidInput(parsed.reason);
        const { ref, sourceOperationId, offset, maxBytes } = parsed.value;
        // MCP JSON-RPC wraps the result as JSON-encoded text. Clamp the
        // requested ContextPort reply *independently* of fetchMaxBytes so a
        // large configured fetch ceiling cannot create an undeliverable reply.
        const transportLimit = Math.floor(maxResponseBytes / 2);
        const result = await contextAccess.fetch(ref, sourceOperationId,
          offset === undefined ? undefined : {
            offset, maxBytes: Math.min(transportLimit, maxBytes ?? transportLimit),
          });
        if (result.kind !== 'available' || !result.bytes) return result;
        if (result.bytes.byteLength > (maxResponseBytes / 2)) return { kind: 'unavailable', reason: 'budget' };
        const { bytes, ...details } = result;
        return { ...details, base64: Buffer.from(bytes).toString('base64') };
      }
      if (name === evidenceListToolName && evidenceAccess) {
        const parsed = decode(evidenceListArgs, args);
        return parsed.kind === 'accepted' ? evidenceAccess.list(parsed.value.cursor) : invalidInput(parsed.reason);
      }
      if (name === evidenceFetchToolName && evidenceAccess) {
        const parsed = decode(evidenceFetchArgs, args);
        if (parsed.kind === 'rejected') return invalidInput(parsed.reason);
        return evidenceAccess.fetch(parsed.value.ref,parsed.value.offset === undefined && parsed.value.maxBytes === undefined
          ? undefined : {offset:parsed.value.offset ?? 0,maxBytes:parsed.value.maxBytes});
      }
      return externalTools ? await externalTools.call(name, args) : { kind: 'unavailable', reason: 'missing' };
    } finally {
      active--;
    }
  }

  /** @param {IncomingMessage} request @param {ServerResponse} response */
  async function respond(request, response) {
    if (request.url !== path) { response.writeHead(404).end(); return; }
    const host = '127.0.0.1:' + port;
    if (request.headers.host !== host || (request.headers.origin !== undefined && request.headers.origin !== 'http://' + host)) {
      response.writeHead(403).end();
      return;
    }
    if (request.method !== 'POST') { response.writeHead(405, { Allow: 'POST' }).end(); return; }
    if (closed || signal.aborted) { response.writeHead(410).end(); return; }
    const protocol = request.headers['mcp-protocol-version'];
    if ((typeof protocol === 'string' && !versions.has(protocol)) ||
        request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
      response.writeHead(400).end();
      return;
    }
    if (Number(request.headers['content-length']) > (pendingDecision ? maxDecisionRequestBytes : maxRequestBytes)) {
      response.writeHead(413, { Connection: 'close' }).end();
      return;
    }
    const payload = await readRequest(request, pendingDecision ? maxDecisionRequestBytes : maxRequestBytes);
    const message = payload?.message;
    if (payload && payload.bytes > (pendingDecision ? maxDecisionRequestBytes : maxRequestBytes)) {
      response.writeHead(413, {Connection:'close'}).end();
      return;
    }
    if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      response.writeHead(400, { Connection: 'close' }).end();
      return;
    }
    if (payload.bytes > maxRequestBytes && !(pendingDecision && message.method === 'tools/call' &&
        object(message.params)?.name === decisionToolName)) { response.writeHead(413).end(); return; }
    if (message.id === undefined) { response.writeHead(202).end(); return; }
    if ((typeof message.id !== 'string' && typeof message.id !== 'number') ||
        (typeof message.id === 'number' && !Number.isFinite(message.id))) {
      response.writeHead(400).end();
      return;
    }
    const requestId = message.id;
    const params = object(message.params);
    /** @type {unknown} */
    let result;
    /** @type {{code: number, message: string} | undefined} */
    let error;
    switch (message.method) {
      case 'initialize':
        result = { protocolVersion: typeof params?.protocolVersion === 'string' && versions.has(params.protocolVersion)
          ? params.protocolVersion : '2025-06-18', capabilities: { tools: {} },
        serverInfo: { name: bridgeName, version: '1.0.0' } };
        break;
      case 'ping': result = {}; break;
      case 'tools/list': {
        // Preserve the pre-C18N front-page ordering for existing context and
        // external tools. Keep control discoverable near the front; new optional
        // evidence tools follow, without shadowing or hiding old tool IDs.
        const tools = [
          ...(contextAccess ? [{...listTool,name:contextListToolName},{...fetchTool,name:contextFetchToolName}] : []),
          ...(pendingDecision ? [{...decisionTool,name:decisionToolName}] : []),
          ...listedExternalTools.map(({ id, description, inputSchema, effect }) =>
            ({ name: id, description, inputSchema, annotations: { readOnlyHint: effect === 'read' } })),
          ...(evidenceAccess ? [{...evidenceListTool,name:evidenceListToolName},
            {...evidenceFetchTool,name:evidenceFetchToolName}] : []),
        ];
        const cursor = params?.cursor === undefined ? 0 :
          typeof params.cursor === 'string' && /^[0-9]+$/.test(params.cursor) ? Number(params.cursor) : -1;
        if (cursor < 0 || cursor > tools.length) { error = { code: -32602, message: 'Invalid cursor' }; break; }
        const end = cursor + 4;
        const page = { tools: tools.slice(cursor, end), ...(end < tools.length && { nextCursor: String(end) }) };
        // Do not turn a formerly deliverable page into 413 because optional
        // C22 descriptions share its envelope with arbitrary external tools.
        if (Buffer.byteLength(JSON.stringify({jsonrpc:'2.0',id:requestId,result:page})) > maxResponseBytes) {
          page.tools = page.tools.map(tool => {
            const description = tool.name === decisionToolName ? decisionShortDescription :
              tool.name === contextFetchToolName ? fetchShortDescription :
                tool.name === evidenceFetchToolName ? evidenceFetchShortDescription : undefined;
            return description === undefined ? tool : {...tool,description};
          });
        }
        result = page;
        break;
      }
      case 'tools/call': {
        if (typeof params?.name !== 'string') { error = { code: -32602, message: 'Invalid tool name' }; break; }
        const args = params.arguments ?? {};
        const fingerprint = createHash('sha256').update(JSON.stringify([params.name, args])).digest('hex');
        const control = params.name === decisionToolName && pendingDecision !== undefined;
        const previousControl = controlCalls.get(requestId);
        const previousOrdinary = calls.get(requestId);
        if ((previousControl && (!control || previousControl.fingerprint !== fingerprint)) ||
            (previousOrdinary && (control || previousOrdinary.fingerprint !== fingerprint))) {
          // A reliably known explicit replacement on a reused control id
          // must not resurrect a prior proposal. Ordinary active conflicts
          // are technical protocol errors, not effect-based classifications.
          if (control) pendingDecision?.observeRejectedReplacement(args);
          error = { code: -32602, message: 'Request id already used' };
          break;
        }
        if (control) {
          let call = previousControl;
          if (!call) {
            if (decisionCalls >= maxDecisionCalls) {
              result = toolReply(pendingDecision.exceedLimit(),requestId);
              break;
            }
            decisionCalls++;
            call = {fingerprint,response:callTool(params.name,args).then(value=>toolReply(value,requestId,true))};
            controlCalls.set(requestId,call);
          }
          result = await call.response;
        } else {
          let call = previousOrdinary;
          if (!call && active < maxConcurrentCalls) {
            // No completed ordinary result, arguments or Promise is retained.
            // Removal on settlement also covers failed calls and cancellation.
            const entry = {fingerprint,response:Promise.resolve(/** @type {unknown} */ (undefined))};
            entry.response = callTool(params.name,args).then(value=>toolReply(value,requestId)).finally(()=>{
              if (calls.get(requestId) === entry) calls.delete(requestId);
            });
            calls.set(requestId,entry);
            call = entry;
          }
          result = call ? await call.response :
            toolReply({kind:'unavailable',reason:'budget'},requestId);
        }
        break;
      }
      default: error = { code: -32601, message: 'Method not found' };
    }
    const body = JSON.stringify({ jsonrpc: '2.0', id: requestId, ...(error ? { error } : { result }) });
    if (Buffer.byteLength(body) > maxResponseBytes) { response.writeHead(413).end(); return; }
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(body);
  }

  const server = createServer({ requestTimeout: 5_000, headersTimeout: 5_000, keepAliveTimeout: 1000 }, (request, response) => {
    void respond(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500).end();
      else response.destroy();
    });
  });
  server.maxConnections = 16;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve(undefined);
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('MCP bridge has no TCP address');
  }
  const { port } = address;
  return {
    url: 'http://127.0.0.1:' + port + path,
    decisionToolName,contextListToolName,contextFetchToolName,evidenceListToolName,evidenceFetchToolName,
    finalizeDecision: pendingDecision ? () => pendingDecision.finalize() : undefined,
    close() {
      if (closed) return;
      closed = true;
      pendingDecision?.close();
      server.close();
      server.closeAllConnections();
      calls.clear();
      controlCalls.clear();
    },
  };
}

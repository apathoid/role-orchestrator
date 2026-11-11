import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { count, decode, id, optional, record } from '../core/decode.js';
import { contextReference } from '../core/contracts.js';

/** @import {Invocation} from '../core/ports.js' */
/** @import {IncomingMessage, ServerResponse} from 'node:http' */

export const bridgeName = 'role_orchestrator';
const maxRequestBytes = 32 * 1024;
const maxResponseBytes = 256 * 1024;
const maxToolCalls = 64;
const maxConcurrentCalls = 4;
const toolStatuses = new Set(['completed', 'failed', 'truncated', 'invalid_input', 'denied', 'unavailable', 'closed', 'unknown', 'budget']);
const toolEffects = new Set(['none', 'possible', 'unknown']);
const versions = new Set(['2025-03-26', '2025-06-18', '2025-11-25']);

const listArgs = record({ cursor: optional(count) });
const fetchArgs = record({
  ref: contextReference,
  sourceOperationId: optional(id),
  offset: optional(count),
});

const countSchema = { type: 'integer', minimum: 0 };
const listTool = {
  name: 'context_list', description: 'List visible historical records by page. Omitted prompt records can be found here.',
  inputSchema: { type: 'object', properties: { cursor: countSchema }, additionalProperties: false },
};
const fetchTool = {
  name: 'context_fetch', description: 'Retrieve a visible record by ref or position returned by context_list. Optional offset reads bounded base64 byte chunks of saved UTF-8/JSON or binary data; follow nextOffset to read more. Source completeness and truncation remain as recorded.',
  inputSchema: { type: 'object', properties: {
    ref: { anyOf: [{ type: 'string', minLength: 1 }, { type: 'object',
      properties: { revision: countSchema, index: countSchema }, required: ['revision', 'index'], additionalProperties: false }] },
    sourceOperationId: { type: 'string', minLength: 1 },
    offset: countSchema,
  }, required: ['ref'], additionalProperties: false },
};

/** @param {boolean} enabled */
export function retrievalDetail(enabled) {
  return enabled
    ? 'Optional MCP context_list and context_fetch retrieve omitted history when useful. context_fetch offset reads saved data in bounded base64 chunks with nextOffset; retain original completeness. Report material unavailable evidence explicitly.'
    : 'Context retrieval is unavailable in this transport via MCP. Optional nextController.contextRequest can still select saved refs, positions, byte offsets or cursors for a subsequent Controller turn without MCP; report material missing evidence when relevant.';
}

/** @param {unknown} value @returns {Record<string, unknown> | undefined} */
function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? /** @type {Record<string, unknown>} */ (value) : undefined;
}

/**
 * Cache only the bounded, model-visible MCP reply for deduplication. Retaining
 * an arbitrary ToolPort payload in the invocation call map would also retain
 * omitted bytes until the bridge closed.
 * @param {unknown} value @param {string | number} requestId
 */
function toolReply(value, requestId) {
  const text = JSON.stringify(value);
  const full = { content: [{ type: 'text', text }] };
  // The JSON-RPC envelope and request id also consume response bytes.
  if (Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', id: requestId, result: full })) <= maxResponseBytes) {
    return full;
  }
  // The tool has already run. Limit the MCP representation, not its
  // receipt or execution status. A missing output is a delivery error,
  // not evidence of a no-effect pre-dispatch refusal.
  const tool = object(value);
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

/** @param {IncomingMessage} request */
async function readRequest(request) {
  let total = 0;
  /** @type {Buffer[]} */
  const chunks = [];
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    total += chunk.length;
    if (total > maxRequestBytes) return undefined;
    chunks.push(chunk);
  }
  try { return object(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
  catch { return undefined; }
}

/**
 * Stateless Streamable HTTP endpoint for one invocation. It binds only loopback,
 * uses an unguessable attempt URL and exposes only the supplied live ports.
 * @param {Pick<Invocation, 'contextAccess' | 'externalTools' | 'signal'>} invocation
 */
export async function startMcpBridge({ contextAccess, externalTools, signal }) {
  signal.throwIfAborted();
  const path = '/' + randomUUID();
  let closed = false;
  /** @type {Map<string | number, {key: string, response: Promise<unknown>}>} */
  const calls = new Map();
  let active = 0;

  /** @param {string} name @param {unknown} args */
  async function callTool(name, args) {
    if (closed || signal.aborted) return { kind: 'unavailable', reason: 'closed' };
    active++;
    try {
      if (name === listTool.name && contextAccess) {
        const parsed = decode(listArgs, args);
        return parsed.kind === 'accepted' ? contextAccess.list(parsed.value.cursor) : { kind: 'unavailable', reason: 'invalid_input' };
      }
      if (name === fetchTool.name && contextAccess) {
        const parsed = decode(fetchArgs, args);
        if (parsed.kind === 'rejected') return { kind: 'unavailable', reason: 'invalid_input' };
        const { ref, sourceOperationId, offset } = parsed.value;
        const result = await contextAccess.fetch(ref, sourceOperationId,
          offset === undefined ? undefined : {offset});
        if (result.kind !== 'available' || !result.bytes) return result;
        if (result.bytes.byteLength > (maxResponseBytes / 2)) return { kind: 'unavailable', reason: 'budget' };
        const { bytes, ...details } = result;
        return { ...details, base64: Buffer.from(bytes).toString('base64') };
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
    if (Number(request.headers['content-length']) > maxRequestBytes) {
      response.writeHead(413, { Connection: 'close' }).end();
      return;
    }
    const message = await readRequest(request);
    if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      response.writeHead(400, { Connection: 'close' }).end();
      return;
    }
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
        const tools = [
          ...(contextAccess ? [listTool, fetchTool] : []),
          ...(externalTools?.list() ?? []).map(({ id, description, inputSchema, effect }) =>
            ({ name: id, description, inputSchema, annotations: { readOnlyHint: effect === 'read' } })),
        ];
        const cursor = params?.cursor === undefined ? 0 :
          typeof params.cursor === 'string' && /^[0-9]+$/.test(params.cursor) ? Number(params.cursor) : -1;
        if (cursor < 0 || cursor > tools.length) { error = { code: -32602, message: 'Invalid cursor' }; break; }
        const end = cursor + 4;
        result = { tools: tools.slice(cursor, end), ...(end < tools.length && { nextCursor: String(end) }) };
        break;
      }
      case 'tools/call': {
        if (typeof params?.name !== 'string') { error = { code: -32602, message: 'Invalid tool name' }; break; }
        const args = params.arguments ?? {};
        const key = JSON.stringify([params.name, args]);
        let call = calls.get(requestId);
        if (call && call.key !== key) { error = { code: -32602, message: 'Request id already used' }; break; }
        if (!call && calls.size < maxToolCalls && active < maxConcurrentCalls) {
          call = { key, response: callTool(params.name, args).then(value => toolReply(value, requestId)) };
          calls.set(requestId, call);
        }
        result = call ? await call.response : toolReply({ kind: 'unavailable', reason: 'budget' }, requestId);
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
    close() {
      if (closed) return;
      closed = true;
      server.close();
      server.closeAllConnections();
      calls.clear();
    },
  };
}

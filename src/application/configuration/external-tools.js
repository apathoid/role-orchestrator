import { decode, jsonValue } from '../../core/decode.js';

/** @import {ToolDefinition, ToolMetadata, ToolPort, ToolResult} from '../../core/ports.js' */
/** @import {ValidateFunction} from 'ajv' */

export const reservedToolIds = new Set(['context_list', 'context_fetch']);
const maxInputBytes = 32 * 1024;
const maxOutputBytes = 64 * 1024;
const maxCalls = 32;

/** @param {unknown} raw */
export async function compileExternalTool(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  const tool = /** @type {Partial<ToolDefinition>} */ (raw);
  const { id, description, resource, effect, inputSchema, invoke, cancel } = tool;
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id) || reservedToolIds.has(id) ||
      typeof description !== 'string' || !description.trim() || description.length > 1024 ||
      typeof resource !== 'string' || !resource.trim() || resource.length > 512 ||
      (effect !== 'read' && effect !== 'write') || typeof invoke !== 'function' ||
      (cancel !== undefined && typeof cancel !== 'function') ||
      !inputSchema || typeof inputSchema !== 'object' || Array.isArray(inputSchema) || inputSchema.type !== 'object') return undefined;
  try {
    const json = decode(jsonValue, inputSchema);
    if (json.kind !== 'accepted' || Buffer.byteLength(JSON.stringify(json.value)) > maxInputBytes) return undefined;
    const schema = /** @type {Record<string, unknown>} */ (json.value);
    const { Ajv } = await import('ajv');
    const validate = new Ajv({ strict: true, ownProperties: true }).compile(schema);
    if ('$async' in validate && validate.$async === true) return undefined;
    return { metadata: { id, description, resource, effect, inputSchema: schema }, validate, invoke, cancel };
  } catch { return undefined; }
}

/** @typedef {{metadata: ToolMetadata, validate: ValidateFunction, invoke: ToolDefinition['invoke'],
 *  cancel?: ToolDefinition['cancel']}} RegisteredTool */

/** @param {ReadonlyMap<string, RegisteredTool>} tools @returns {ToolPort} */
export function createExternalToolPort(tools) {
  return {
    bind({ attemptId, operationId, signal, isActive, permissions, newId, receive, maxBytes }) {
      let calls = 0;
      return {
        list: () => isActive() && !signal.aborted ? [...tools.values()].map(tool => structuredClone(tool.metadata)) : [],
        async call(id, input) {
          if (!isActive() || signal.aborted) return { status: 'closed', effect: 'none' };
          const tool = tools.get(id);
          if (!tool) return { status: 'unavailable', effect: 'none' };
          if (calls >= maxCalls) return { status: 'budget', effect: 'none' };
          calls++;
          const callId = newId();
          const { metadata: { resource, description, effect }, validate, invoke, cancel } = tool;
          const scope = { attemptId, operationId, callId, signal };
          /** @param {ToolResult} result */
          const record = result => ({ ...result, callId, ref: receive(id, { ...result, callId, toolId: id, attemptId }) });
          let decoded;
          try { decoded = decode(jsonValue, input); } catch { return record({ status: 'invalid_input', effect: 'none' }); }
          if (decoded.kind !== 'accepted' || Buffer.byteLength(JSON.stringify(decoded.value)) > maxInputBytes || !validate(decoded.value)) {
            return record({ status: 'invalid_input', effect: 'none' });
          }
          const permission = await permissions?.request({
            providerRequestId: 'external-tool:' + callId, resource,
            options: [{ id: 'allow', kind: 'allow' }, { id: 'deny', kind: 'deny' }],
            action: { source: 'provider_reported', title: description, kind: effect },
          });
          if (!isActive() || signal.aborted) return record({ status: 'closed', effect: 'none' });
          if (permission?.kind !== 'selected' || permission.option !== 'allow') {
            return record({ status: 'denied', effect: 'none' });
          }
          const interrupted = Promise.withResolvers();
          let started = false;
          const abort = () => {
            interrupted.resolve(started ? { status: 'unknown', effect: 'unknown' } : { status: 'closed', effect: 'none' });
            if (started && cancel) void Promise.resolve().then(() => cancel(scope)).catch(() => {});
          };
          signal.addEventListener('abort', abort, { once: true });
          try {
            const call = Promise.resolve().then(async () => {
              if (signal.aborted || !isActive()) return /** @type {const} */ ({ status: 'closed', effect: 'none' });
              try {
                started = true;
                const value = await invoke(decoded.value, scope);
                if (signal.aborted || !isActive()) return /** @type {const} */ ({ status: 'unknown', effect: 'unknown' });
                const result = decode(jsonValue, value);
                if (result.kind !== 'accepted') return /** @type {const} */ ({ status: 'failed', effect: 'unknown' });
                const knownEffect = effect === 'read' ? 'none' : 'possible';
                if (Buffer.byteLength(JSON.stringify(result.value)) > Math.min(maxBytes, maxOutputBytes)) {
                  return /** @type {const} */ ({ status: 'truncated', effect: knownEffect });
                }
                return /** @type {const} */ ({ status: 'completed', effect: knownEffect, output: result.value });
              } catch { return /** @type {const} */ ({ status: 'failed', effect: 'unknown' }); }
            });
            return record(await Promise.race([call, interrupted.promise]));
          } finally {
            signal.removeEventListener('abort', abort);
          }
        },
      };
    },
  };
}

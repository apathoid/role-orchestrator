export const AGENT_EVENT_TYPES = Object.freeze({
  REASONING: 'reasoning',
  COMMENTARY: 'commentary',
  FINAL_TEXT: 'final_text',
  CONTENT_BLOCK: 'content_block',
  TOOL_CALL: 'tool_call',
  TOOL_RESULT: 'tool_result',
  PLAN_UPDATE: 'plan_update',
  PERMISSION_REQUEST: 'permission_request',
  PROGRESS: 'progress',
  PROVIDER_STATE: 'provider_state',
  WARNING: 'warning',
  ERROR: 'error',
  USAGE: 'usage',
});

export const REASONING_LEVELS = Object.freeze(['none', 'low', 'medium', 'high', 'xhigh', 'max']);

export class AgentProvider {
  constructor(name, config = {}) {
    this.name = name;
    this.config = config;
  }

  capabilities() {
    return Object.freeze({ text: true });
  }

  async listModels() {
    return Array.isArray(this.config.models) ? this.config.models : [];
  }

  async invoke(_request) {
    throw new Error(`${this.constructor.name}.invoke() is not implemented.`);
  }

  async cancel(_invocationId) {}
  async close() {}
}

export function normalizeCapabilities(input = {}) {
  return Object.freeze({
    text: input.text !== false,
    images: input.images === true,
    embeddedResources: input.embeddedResources === true,
    resourceLinks: input.resourceLinks !== false,
    audio: input.audio === true,
    nativePlan: input.nativePlan === true,
    reasoningStream: input.reasoningStream === true,
    commentary: input.commentary === true,
    permissions: input.permissions === true,
    workspaceModes: Object.freeze({
      readOnly: input.workspaceModes?.readOnly === true,
      write: input.workspaceModes?.write === true,
    }),
    configurableModel: input.configurableModel !== false,
    configurableReasoning: input.configurableReasoning === true,
    mcp: Object.freeze({
      stdio: input.mcp?.stdio === true,
      http: input.mcp?.http === true,
      sse: input.mcp?.sse === true,
    }),
    resume: input.resume === true,
    structuredOutput: input.structuredOutput ?? 'prompt-validation',
  });
}

export function assertInvocationCapabilities(provider, request) {
  const caps = normalizeCapabilities(provider.capabilities?.() ?? {});
  const mode = request.sandboxMode ?? 'read-only';
  if (mode === 'read-only' && !caps.workspaceModes.readOnly) {
    throw Object.assign(new Error(`${provider.name}: provider cannot enforce read-only workspace access.`), { code: 'CAPABILITY_UNSUPPORTED' });
  }
  if (mode === 'workspace-write' && !caps.workspaceModes.write) {
    throw Object.assign(new Error(`${provider.name}: provider cannot enforce workspace-write access.`), { code: 'CAPABILITY_UNSUPPORTED' });
  }
  for (const block of request.promptBlocks ?? []) {
    if (block?.type === 'image' && !caps.images) {
      throw Object.assign(new Error(`${provider.name}: provider does not support image context.`), { code: 'CAPABILITY_UNSUPPORTED' });
    }
    if (block?.type === 'resource' && !caps.embeddedResources) {
      throw Object.assign(new Error(`${provider.name}: provider does not support embedded resources.`), { code: 'CAPABILITY_UNSUPPORTED' });
    }
    if (block?.type === 'resource_link' && !caps.resourceLinks) {
      throw Object.assign(new Error(`${provider.name}: provider does not support resource links.`), { code: 'CAPABILITY_UNSUPPORTED' });
    }
  }
  for (const server of request.mcpServers ?? []) {
    const type = String(server?.transport ?? server?.type ?? 'stdio').toLowerCase();
    if (type === 'stdio' && !caps.mcp.stdio) throw Object.assign(new Error(`${provider.name}: provider does not support stdio MCP.`), { code: 'CAPABILITY_UNSUPPORTED' });
    if ((type === 'http' || type === 'streamable-http') && !caps.mcp.http) throw Object.assign(new Error(`${provider.name}: provider does not support HTTP MCP.`), { code: 'CAPABILITY_UNSUPPORTED' });
    if (type === 'sse' && !caps.mcp.sse) throw Object.assign(new Error(`${provider.name}: provider does not support SSE MCP.`), { code: 'CAPABILITY_UNSUPPORTED' });
  }
  return caps;
}

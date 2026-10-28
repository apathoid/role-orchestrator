// Capability declarations must be usable during synchronous route/preview
// resolution, before loading any optional provider implementation or ACP SDK.
import { normalizeCapabilities } from './provider.mjs';

export function codexCliCapabilities() {
  return normalizeCapabilities({
    text: true, images: false, embeddedResources: false, resourceLinks: false,
    nativePlan: true, reasoningStream: true, commentary: true, permissions: false,
    workspaceModes: { readOnly: true, write: true },
    configurableModel: true, configurableReasoning: true, mcp: {},
    structuredOutput: 'native-or-prompt-validation',
  });
}

export function codexAcpCapabilities() {
  return normalizeCapabilities({
    text: true, images: true, embeddedResources: true, resourceLinks: true,
    audio: false, nativePlan: true, reasoningStream: true, commentary: true,
    permissions: true, workspaceModes: { readOnly: true, write: true },
    configurableModel: true, configurableReasoning: true,
    mcp: { stdio: true, http: true, sse: true }, structuredOutput: 'prompt-validation',
  });
}

export function genericAcpCapabilities(config, runtime = {}, initializeResponse = null) {
  const prompt = initializeResponse?.agentCapabilities?.promptCapabilities ?? {};
  return normalizeCapabilities({
    text: true,
    images: prompt.image === true || config.capabilities?.images === true,
    embeddedResources: prompt.embeddedContext === true || config.capabilities?.embeddedResources === true,
    resourceLinks: true,
    audio: prompt.audio === true || config.capabilities?.audio === true,
    nativePlan: config.capabilities?.nativePlan !== false,
    reasoningStream: config.capabilities?.reasoningStream !== false,
    commentary: config.capabilities?.commentary !== false,
    permissions: config.capabilities?.permissions === true || typeof runtime.requestPermission === 'function',
    workspaceModes: { readOnly: Boolean(config.workspaceModes?.readOnly), write: Boolean(config.workspaceModes?.write) },
    configurableModel: config.modelConfigId !== false,
    configurableReasoning: Boolean(config.reasoningConfigId),
    mcp: config.capabilities?.mcp ?? { stdio: true },
    structuredOutput: 'prompt-validation',
  });
}

export const providerImplementations = Object.freeze({
  'codex-cli': { module: './codex-cli.mjs', exportName: 'CodexCliProvider', capabilities: codexCliCapabilities },
  'codex-acp': { module: './codex-acp.mjs', exportName: 'CodexAcpProvider', capabilities: codexAcpCapabilities },
  'acp-agent': { module: './acp/generic-acp.mjs', exportName: 'GenericAcpProvider', capabilities: genericAcpCapabilities },
});

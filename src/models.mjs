import { LazyProvider } from './providers/lazy-provider.mjs';
import { assertInvocationCapabilities } from './providers/provider.mjs';
import { normalizeAgentEvent } from './providers/events.mjs';
import { normalizeProviderError } from './providers/errors.mjs';

function providerType(config) {
  return config.adapter ?? config.type;
}

function makeProvider(name, config, runtime) {
  if (!config) throw new Error(`Unknown provider: ${name}`);
  return new LazyProvider(name, config, runtime);
}

export function createModelRegistry(config, runtime = {}) {
  const providers = new Map();
  function providerFor(name) {
    if (!providers.has(name)) providers.set(name, makeProvider(name, config.providers[name], runtime));
    return providers.get(name);
  }

  function resolveRole(role) {
    const assignment = config.roleAssignments?.[role];
    const profileName = assignment?.profileName ?? config.roles[role];
    if (!profileName) throw new Error(`Unknown role: ${role}`);
    const profile = assignment?.profile ?? config.profiles[profileName];
    if (!profile) throw new Error(`Role ${role} references unknown profile ${profileName}.`);
    const provider = providerFor(profile.provider);
    return {
      role, profileName, profile, providerName: profile.provider, provider,
      adapter: providerType(config.providers[profile.provider]),
      capabilities: provider.capabilities?.() ?? { text: true },
    };
  }

  async function invokeRole(role, request) {
    const resolved = resolveRole(role);
    try {
      await resolved.provider.prepare?.();
      const capabilities = assertInvocationCapabilities(resolved.provider, request);
      const upstreamProgress = request.onProgress;
      const result = await resolved.provider.invoke({
        ...resolved,
        ...request,
        capabilities,
        providerOptions: { ...(resolved.profile.providerOptions ?? {}), ...(request.providerOptions ?? {}) },
        onProgress: upstreamProgress ? async (event) => {
          const normalized = normalizeAgentEvent(event);
          if (normalized) await upstreamProgress(normalized);
        } : null,
      });
      return { ...result, resolved: { ...resolved, capabilities } };
    } catch (error) {
      throw normalizeProviderError(error, resolved.providerName);
    }
  }

  async function listModels(providerName) {
    const provider = providerFor(providerName);
    return provider.listModels?.() ?? config.providers[providerName]?.models ?? [];
  }

  async function close() {
    await Promise.allSettled([...providers.values()].map((provider) => provider.close?.()));
    providers.clear();
  }

  return { resolveRole, invokeRole, listModels, close };
}

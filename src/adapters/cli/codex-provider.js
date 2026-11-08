import { randomUUID } from 'node:crypto';
import { unavailableCapabilities } from '../../application/configuration/catalog.js';
import { prepareCodexLaunch } from './codex-launch.js';
import { startCodexProcess } from './codex-output.js';
import { renderCodexPrompt } from './codex-prompt.js';
import { receiveCodexResult, unstartedCodexResult } from './codex-result.js';

/** @import {ProviderConfig} from '../../application/configuration/decode-config.js' */
/** @import {Capability, Profile, ProviderPort, ProviderSession} from '../../core/ports.js' */

const interactiveApprovalDetail = 'Codex CLI headless mode has no host channel for interactive approval.';

/** @type {Readonly<Record<string, Capability>>} */
const capabilities = Object.freeze({
  'input.text': { support: 'supported', source: 'configured' },
  'input.image': { support: 'unsupported', source: 'configured', detail: 'This adapter accepts text only.' },
  'input.attachments': { support: 'unsupported', source: 'configured', detail: 'This adapter cannot transfer attachments.' },
  'output.decision': { support: 'supported', source: 'configured', detail: 'Validated JSON in the final model message.' },
  'tools.command_exit': { support: 'supported', source: 'configured', detail: 'Provider-reported command exits when available.' },
  'tools.visibility': { support: 'unknown', source: 'configured', detail: 'Command events provide partial tool visibility.' },
  'tools.bridge': { support: 'unsupported', source: 'configured', detail: 'Codex CLI headless mode exposes no host tool bridge.' },
  'permissions.interactive': { support: 'unsupported', source: 'configured', detail: interactiveApprovalDetail },
  cancel: { support: 'supported', source: 'configured' },
  usage: { support: 'supported', source: 'configured', detail: 'Token counts when reported; cost is unknown.' },
  'session.resume': { support: 'unsupported', source: 'configured', detail: 'This adapter opens a fresh CLI process for each call.' },
  'attempt.status': { support: 'unsupported', source: 'configured' },
});

/**
 * Compose a Codex CLI endpoint from trusted configuration.
 * Each ProviderPort session owns at most one process.
 * @param {{providerId: string, configuration: ProviderConfig, environment?: NodeJS.ProcessEnv}} options
 * @returns {ProviderPort}
 */
export function createCodexProvider({ providerId, configuration, environment = process.env }) {
  /** @type {Map<ProviderSession, {profile: Pick<Profile, 'profileId' | 'model'>, invoked: boolean, closing: boolean,
   *   call?: {attemptId: string, process: ReturnType<typeof startCodexProcess>}}>} */
  const sessions = new Map();
  return {
    async describe() {
      return { providerId, maxConcurrency: null, capabilities: Object.fromEntries(
        Object.entries(capabilities).map(([key, value]) => [key, { ...value }]),
      ) };
    },
    async open(profile, signal) {
      signal.throwIfAborted();
      if (profile.providerId !== providerId) throw new Error('Profile belongs to a different provider');
      const session = Object.freeze({ sessionId: randomUUID() });
      sessions.set(session, { profile: { profileId: profile.profileId, model: profile.model }, invoked: false, closing: false });
      return session;
    },
    async invoke(session, request, observe) {
      const state = sessions.get(session);
      if (!state || state.closing || state.invoked || request.profile.providerId !== providerId ||
        request.profile.profileId !== state.profile.profileId || request.profile.model !== state.profile.model) {
        return unstartedCodexResult(request.attemptId, 'PROTOCOL_ERROR');
      }
      state.invoked = true;
      if (request.signal.aborted) return unstartedCodexResult(request.attemptId, 'CANCELLED');
      const required = new Set(request.requiredCapabilities);
      for (const { mediaType } of request.attachments ?? []) {
        required.add(mediaType.toLowerCase().startsWith('image/') ? 'input.image' : 'input.attachments');
      }
      const missing = unavailableCapabilities(capabilities, required);
      if (missing.length) {
        const result = unstartedCodexResult(request.attemptId, 'CAPABILITY_UNAVAILABLE');
        const ref = observe({ ref: 'codex-capability', kind: 'host_transport', sourceId: request.attemptId,
          completeness: 'complete', value: { profileId: state.profile.profileId, missing } });
        result.outcome.diagnostics[0].ref = ref;
        return result;
      }

      const prompt = renderCodexPrompt(request, interactiveApprovalDetail);
      let launch;
      try {
        launch = prepareCodexLaunch(configuration, { model: state.profile.model, cwd: request.workspaceContext?.cwd, prompt }, environment);
      } catch (error) {
        if (!(error instanceof TypeError)) throw error;
        const result = unstartedCodexResult(request.attemptId, 'PROVIDER_START_FAILED');
        const ref = observe({ ref: 'codex-launch', kind: 'host_transport', sourceId: request.attemptId,
          completeness: 'complete', value: { message: error.message } });
        result.outcome.diagnostics[0].ref = ref;
        return result;
      }
      const process = startCodexProcess(launch, { timeoutMs: request.timeoutMs, signal: request.signal });
      state.call = { attemptId: request.attemptId, process };
      return receiveCodexResult(await process.finished, request, observe);
    },
    async cancel(session, attemptId) {
      const call = sessions.get(session)?.call;
      if (call?.attemptId === attemptId) call.process.cancel();
    },
    async close(session) {
      const state = sessions.get(session);
      if (!state) return;
      state.closing = true;
      await state.call?.process.close();
      sessions.delete(session);
    },
  };
}

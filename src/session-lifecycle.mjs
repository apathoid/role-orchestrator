// Host-neutral session lifecycle: repository binding, materialized role state,
// persistence and context restoration. Hosts handle UI, transport, and controls.
import { randomUUID } from 'node:crypto';
import { resolveRepoRoot } from './repo.mjs';
import { loadSession, saveSession } from './session-store.mjs';
import { ensureSessionConfigState } from './session-config.mjs';

export function createSessionLifecycle({ getConfig }) {
  const sessions = new Map();
  return {
    sessions,
    async create(params) {
      const repoRoot = await resolveRepoRoot(params.cwd);
      const config = await getConfig(repoRoot);
      const sessionId = randomUUID();
      const session = {
        cwd: params.cwd,
        repoRoot,
        createdAt: new Date().toISOString(),
        history: [],
        transcript: [],
        title: null,
        mcpServers: Array.isArray(params.mcpServers) ? params.mcpServers : [],
        additionalDirectories: Array.isArray(params.additionalDirectories) ? params.additionalDirectories : [],
      };
      ensureSessionConfigState(session, config, { newSession: true });
      await saveSession(sessionId, session);
      sessions.set(sessionId, session);
      return { sessionId, session, config };
    },
    async restore(params, { allowLegacyAdoption = true } = {}) {
      const sessionId = params.sessionId;
      let session = sessions.get(sessionId) ?? await loadSession(sessionId);
      if (!session && allowLegacyAdoption) {
        // Preserve compatibility with ACP-hosted sessions from before the
        // orchestrator had durable persistence. Do not invent their history.
        const repoRoot = await resolveRepoRoot(params.cwd);
        session = {
          cwd: params.cwd, repoRoot,
          createdAt: new Date().toISOString(),
          history: [], transcript: [], title: null, legacyRecovered: true,
        };
        await saveSession(sessionId, session);
      }
      if (!session) throw new Error(`Unknown session: ${sessionId}`);
      const repoRoot = session.repoRoot ?? await resolveRepoRoot(session.cwd);
      if (typeof params.cwd === 'string' && params.cwd) {
        const requestedRepo = await resolveRepoRoot(params.cwd);
        if (requestedRepo !== repoRoot) {
          throw new Error(`Persisted session ${sessionId} belongs to ${repoRoot}, not ${requestedRepo}. Start a new orchestrator session for the other repository.`);
        }
        session.cwd = params.cwd;
      }
      session.repoRoot = repoRoot;
      if (Array.isArray(params.mcpServers)) session.mcpServers = params.mcpServers;
      if (Array.isArray(params.additionalDirectories)) session.additionalDirectories = params.additionalDirectories;
      session.mcpServers ??= [];
      session.additionalDirectories ??= [];
      session.title = typeof session.title === 'string' && session.title.trim() ? session.title.trim() : null;
      ensureSessionConfigState(session, await getConfig(repoRoot));
      sessions.set(sessionId, session);
      return session;
    },
    persist: saveSession,
  };
}

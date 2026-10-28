// Thin outer-session mirrors of codex-acp@1.12.0 controls.
// These values are transport metadata only: codex-acp remains the owner of
// approval/sandbox and collaboration-mode semantics.

export const CODEX_AGENT_MODE_CONFIG_ID = 'mode';
export const CODEX_COLLABORATION_MODE_CONFIG_ID = 'collaboration_mode';
const DEFAULT_CODEX_AGENT_MODE = 'agent';
export const DEFAULT_CODEX_COLLABORATION_MODE = 'default';
export const PLAN_CODEX_COLLABORATION_MODE = 'plan';

export const CODEX_AGENT_MODES = [
  {
    id: 'read-only',
    name: 'Ask for approval',
    description: 'Always ask to edit external files and use the internet',
    _meta: { kind: 'standard' },
  },
  {
    id: 'agent',
    name: 'Approve for me',
    description: 'Only ask for actions detected as potentially unsafe',
    _meta: { kind: 'auto_review' },
  },
  {
    id: 'agent-full-access',
    name: 'Full access',
    description: 'Unrestricted access to the internet and any file on your computer',
    _meta: { kind: 'full_access' },
  },
];

export function ensureCodexNativeControlState(session) {
  if (!CODEX_AGENT_MODES.some((mode) => mode.id === session.codexAgentMode)) {
    session.codexAgentMode = DEFAULT_CODEX_AGENT_MODE;
  }
  if (![DEFAULT_CODEX_COLLABORATION_MODE, PLAN_CODEX_COLLABORATION_MODE].includes(session.codexCollaborationMode)) {
    session.codexCollaborationMode = DEFAULT_CODEX_COLLABORATION_MODE;
  }
  return session;
}

export function codexAgentModeState(session) {
  ensureCodexNativeControlState(session);
  return {
    currentModeId: session.codexAgentMode,
    availableModes: CODEX_AGENT_MODES.map((mode) => ({ ...mode, _meta: { ...mode._meta } })),
  };
}

function codexAgentModeConfigOption(session) {
  ensureCodexNativeControlState(session);
  return {
    id: CODEX_AGENT_MODE_CONFIG_ID,
    name: 'Mode',
    description: 'Approval and sandboxing preset for the session',
    category: 'mode',
    type: 'select',
    currentValue: session.codexAgentMode,
    options: CODEX_AGENT_MODES.map((mode) => ({
      value: mode.id,
      name: mode.name,
      description: mode.description,
      _meta: { ...mode._meta },
    })),
  };
}

function codexCollaborationModeConfigOption(session) {
  ensureCodexNativeControlState(session);
  return {
    id: CODEX_COLLABORATION_MODE_CONFIG_ID,
    name: 'Collaboration mode',
    description: 'How Codex collaborates for subsequent turns',
    category: 'collaboration_mode',
    type: 'select',
    currentValue: session.codexCollaborationMode,
    options: [
      { value: 'default', name: 'Default' },
      { value: 'plan', name: 'Plan', description: 'Produce a read-only execution plan without applying changes' },
    ],
  };
}

export function buildCodexNativeConfigOptions(session) {
  // codex-acp returns both legacy `modes` and the native mode config option.
  // Mirror both exactly; clients such as Zed decide how to present/deduplicate them.
  return [codexAgentModeConfigOption(session), codexCollaborationModeConfigOption(session)];
}

export function setCodexAgentMode(session, value) {
  if (!CODEX_AGENT_MODES.some((mode) => mode.id === value)) {
    throw new Error(`Unknown Codex agent mode: ${String(value)}`);
  }
  session.codexAgentMode = value;
}

export function setCodexNativeConfigOption(session, configId, rawValue) {
  const value = unwrapConfigValue(rawValue);
  if (configId === CODEX_AGENT_MODE_CONFIG_ID) {
    setCodexAgentMode(session, value);
    return true;
  }
  if (configId === CODEX_COLLABORATION_MODE_CONFIG_ID) {
    if (![DEFAULT_CODEX_COLLABORATION_MODE, PLAN_CODEX_COLLABORATION_MODE].includes(value)) {
      throw new Error(`Unknown Codex collaboration mode: ${String(value)}`);
    }
    session.codexCollaborationMode = value;
    return true;
  }
  return false;
}

function unwrapConfigValue(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    if ('value' in value) return value.value;
    if ('valueId' in value) return value.valueId;
    if ('value_id' in value) return value.value_id;
  }
  return value;
}

export function collaborationModeForRole(role, selectedMode) {
  // Machine/control roles and post-workflow responders stay in Default so they
  // cannot accidentally start a second native Plan flow. The selected native
  // collaboration mode belongs only to the role actually executing the user's
  // current task: investigator for read-only work, coder for writable work.
  if (role === 'investigator' || role.startsWith('coder')) {
    return selectedMode;
  }
  return DEFAULT_CODEX_COLLABORATION_MODE;
}


// Outer-turn control snapshot: never re-read mutable session configuration
// after accepting a user prompt. The outer Plan route owns planning; inner
// agents must use Default rather than starting a competing native Plan flow.
export function snapshotCodexTurnControls(session) {
  ensureCodexNativeControlState(session);
  const agentMode = session.codexAgentMode;
  const collaborationMode = session.codexCollaborationMode;
  const planOnly = collaborationMode === PLAN_CODEX_COLLABORATION_MODE;
  return Object.freeze({
    agentMode,
    planOnly,
    collaborationModeForRole: (role) => planOnly
      ? DEFAULT_CODEX_COLLABORATION_MODE
      : collaborationModeForRole(role, collaborationMode),
  });
}

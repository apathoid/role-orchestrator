import assert from 'node:assert/strict';
import {
  CODEX_AGENT_MODE_CONFIG_ID,
  CODEX_COLLABORATION_MODE_CONFIG_ID,
  buildCodexNativeConfigOptions,
  codexAgentModeState,
  collaborationModeForRole,
  ensureCodexNativeControlState,
  setCodexAgentMode,
  setCodexNativeConfigOption,
  snapshotCodexTurnControls,
} from '../src/codex-native-controls.mjs';

const session = {};
ensureCodexNativeControlState(session);
assert.equal(session.codexAgentMode, 'agent');
assert.equal(session.codexCollaborationMode, 'default');
assert.deepEqual(codexAgentModeState(session).availableModes.map((mode) => [mode.id, mode.name]), [
  ['read-only', 'Ask for approval'],
  ['agent', 'Approve for me'],
  ['agent-full-access', 'Full access'],
]);

let options = buildCodexNativeConfigOptions(session);
assert.equal(options.find((x) => x.id === CODEX_AGENT_MODE_CONFIG_ID)?.currentValue, 'agent');
assert.equal(options.find((x) => x.id === CODEX_COLLABORATION_MODE_CONFIG_ID)?.currentValue, 'default');
assert.deepEqual(options.find((x) => x.id === CODEX_COLLABORATION_MODE_CONFIG_ID)?.options.map((x) => x.value), ['default', 'plan']);

setCodexAgentMode(session, 'agent-full-access');
assert.equal(codexAgentModeState(session).currentModeId, 'agent-full-access');
assert.equal(setCodexNativeConfigOption(session, CODEX_COLLABORATION_MODE_CONFIG_ID, 'plan'), true);
assert.equal(session.codexCollaborationMode, 'plan');
assert.equal(setCodexNativeConfigOption(session, 'orchestrator_model', 'something'), false);
assert.throws(() => setCodexAgentMode(session, 'invented'), /Unknown Codex agent mode/);
assert.throws(() => setCodexNativeConfigOption(session, CODEX_COLLABORATION_MODE_CONFIG_ID, 'invented'), /Unknown Codex collaboration mode/);

assert.equal(collaborationModeForRole('router', 'plan'), 'default');
assert.equal(collaborationModeForRole('explorer', 'plan'), 'default');
assert.equal(collaborationModeForRole('investigator', 'plan'), 'plan');
assert.equal(collaborationModeForRole('coderMedium', 'plan'), 'plan');
assert.equal(collaborationModeForRole('responderMedium', 'plan'), 'default');

const selectedPlan = snapshotCodexTurnControls(session);
assert.equal(selectedPlan.planOnly, true);
assert.equal(selectedPlan.agentMode, 'agent-full-access');
assert.equal(selectedPlan.collaborationModeForRole('investigator'), 'default');
assert.equal(selectedPlan.collaborationModeForRole('coderHigh'), 'default');
setCodexNativeConfigOption(session, CODEX_COLLABORATION_MODE_CONFIG_ID, 'default');
setCodexAgentMode(session, 'read-only');
assert.equal(selectedPlan.planOnly, true, 'in-flight turn must not observe later UI changes');
assert.equal(selectedPlan.agentMode, 'agent-full-access');
const selectedDefault = snapshotCodexTurnControls(session);
assert.equal(selectedDefault.planOnly, false);
assert.equal(selectedDefault.agentMode, 'read-only');
assert.equal(selectedDefault.collaborationModeForRole('investigator'), 'default');

console.log('codex-native-controls: passed');

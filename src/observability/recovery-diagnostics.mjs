// Strict, bounded projection. No prompts, paths, tool arguments or provider
// messages may enter the persisted trace through diagnostics.
const updateTypes = new Set(['agent_message_chunk', 'agent_thought_chunk', 'tool_call', 'tool_call_update',
  'tool_call_content_chunk', 'plan', 'available_commands_update', 'current_mode_update',
  'session_info_update', 'usage_update', 'config_option_update', 'user_message_chunk',
  'agent_message', 'agent_thought', 'mode_update']);
const num = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const allowedTimeouts = new Set(['idle', 'deadline']);
const allowedCancelReasons = new Set(['idle_timeout', 'turn_deadline', 'outer_cancelled', 'orchestrator_cancelled', 'session_cancelled', 'outer_signal']);
const allowedNotifications = new Set(['pending', 'submitted', 'failed', 'connection_unavailable']);
export function acpFailureProjection(diagnostics) {
  const inner = diagnostics?.innerAcp;
  if (!inner || typeof inner !== 'object' || Array.isArray(inner)) return null;
  return {
    turnNumber: num(inner.turnNumber),
    acpUpdateCount: num(inner.acpUpdateCount),
    msSinceLastAcpUpdate: num(inner.msSinceLastAcpUpdate),
    turnElapsedMs: num(inner.turnElapsedMs),
    lastAcpUpdateType: updateTypes.has(inner.lastAcpUpdateType) ? inner.lastAcpUpdateType : null,
    outgoingCancelCount: num(inner.outgoingCancelCount),
    localTimeoutKind: allowedTimeouts.has(inner.localTimeout?.kind) ? inner.localTimeout.kind : null,
    outgoingCancels: Array.isArray(inner.outgoingCancels) ? inner.outgoingCancels.slice(-4).map(row => ({
      reason: allowedCancelReasons.has(row?.reason) ? row.reason : null,
      notificationStatus: allowedNotifications.has(row?.notificationStatus) ? row.notificationStatus : null,
      turnNumber: num(row?.turnNumber),
    })) : [],
  };
}

// Stable, allowlisted classification of *outer* Router-contract failures.
// No model-provided text, path, prompt or raw error message is persisted.
export const ROUTING_OUTPUT_FAILURE_CODES = Object.freeze([
  'invalid_routing_root', 'invalid_routing_mode', 'invalid_routing_write_intent',
  'invalid_routing_complexity', 'invalid_routing_risk', 'invalid_routing_reason',
  'invalid_routing_title', 'invalid_routing_extra_fields',
]);
const allowed = new Set(ROUTING_OUTPUT_FAILURE_CODES);
export function routingOutputFailureCode(value) {
  const code = typeof value === 'string' ? value : value?.routingOutputFailureCode;
  return allowed.has(code) ? code : null;
}
export function routingShapeError(code, message) {
  const error = new Error(message);
  error.routingOutputFailureCode = routingOutputFailureCode(code);
  return error;
}

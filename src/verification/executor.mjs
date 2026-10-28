// Host-approved verification adapter. This module NEVER constructs shell commands
// from model output, and its result never completes a review obligation itself.
import { createHash } from 'node:crypto';
const sha = text => createHash('sha256').update(text).digest('hex');
export async function executeVerificationDecision({ decision, configuredCommands = [], approvedCommands = [],
  run, sourceKey, invocationId, allowed = false } = {}) {
  if (decision?.strategy !== 'targeted_test' || decision.required !== true)
    return { disposition:'not_applicable', observations:[] };
  if (!allowed) return { disposition:'disabled', observations:[] };
  if (typeof run !== 'function' || typeof sourceKey !== 'string' || !sourceKey ||
      typeof invocationId !== 'string' || !invocationId)
    throw new Error('Invalid targeted verification context');
  const configured = [...new Set(configuredCommands.map(command =>
    Array.isArray(command) && command.every(x => typeof x === 'string') ? command.join(' ') : null).filter(Boolean))];
  const permitted = configured.filter(command => approvedCommands.includes(command) &&
    /(?:^|\s)(?:test|vitest|jest|pytest)(?:\s|$)|(?:npm|pnpm|yarn)\s+(?:run\s+)?test(?::[\w-]+)?(?:\s|$)/i.test(command));
  if (!permitted.length) return { disposition:'no_operator_approved_command', observations:[] };
  // Execute one targeted command; running a full suite or an uncertain command
  // needs a separate host decision, not LLM policy inference.
  const command = permitted[0];
  const result = await run([command]);
  const observations = (result?.results ?? []).filter(item => item?.command === command).map(item => ({
    kind:'tool_result',level:'tool_observed',sourceKey,invocationId,
    origin:'review_verification_executor',exitCode:item.exitCode,
    inputDigest:item.inputsStable === true && item.inputBinding?.kind === 'paths' &&
      item.inputBinding.completeness === 'complete' ? sha(JSON.stringify(item.inputBinding)) : null,
    commandDigest:sha(command),passed:item.status === 'PASS' && item.exitCode === 0,
    status:['PASS','TEST_FAILED','TOOL_UNAVAILABLE','ENVIRONMENT_ERROR','INFRA_FAILURE'].includes(item.status)
      ? item.status : 'UNKNOWN',
  }));
  return { disposition:observations.length ? 'executed' : 'unverified', observations,
    // The raw tool output is not part of the model prompt by default.
    commandDigest:sha(command) };
}

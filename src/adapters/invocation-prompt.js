/** @import {Invocation} from '../core/ports.js' */

import { decisionContract } from '../application/decision-instructions.js';

/** @param {Invocation} request @param {string} transportDetail */
export function renderInvocationPrompt(request, transportDetail) {
  const { kind, operationId, attemptId, actionId, profile: { profileId }, objective,
    instructions, skillInstructions, userConstraints, context, expectedResult, continuationReference } = request;
  const output = kind === 'controller' ? 'Return exactly one JSON object as the final Controller message, with no Markdown fences. Intermediate progress and native tool calls are allowed.' :
    'Return the requested result in your final message. Plain text or the structured text specified by the task is accepted.';
  const prefix = output + '\n' + transportDetail;
  if (kind !== 'controller') {
    return prefix + '\n\nInvocation (JSON):\n' + JSON.stringify({
      kind, operationId, attemptId, actionId, profileId, objective,
      instructions, skillInstructions, userConstraints, context, expectedResult, continuationReference,
    });
  }
  // Split only the text presentation, never the Invocation or the authority
  // of its contents. JSON framing keeps arbitrary data inside its own record.
  const referenceAt = instructions.indexOf(decisionContract);
  const before = referenceAt < 0 ? [] : instructions.slice(0, referenceAt);
  const after = (referenceAt < 0 ? instructions : instructions.slice(referenceAt + 1))
    .filter(instruction => instruction !== decisionContract);
  const last = context.at(-1);
  const correction = last?.ref === 'host:decision-error' && last.source === 'host_observed' ? last : undefined;
  const history = correction ? context.slice(0, -1) : context;
  return [
    prefix,
    'Controller Invocation (sectioned JSON):',
    '## Invocation identity\n' + JSON.stringify({kind, operationId, attemptId, actionId, profileId}),
    '## Original objective and user constraints\n' + JSON.stringify({objective, userConstraints, expectedResult, continuationReference}),
    '## Role instructions before Decision reference\n' + jsonRecords(before),
    '## Decision v1 reference\n' + decisionContract,
    '## Remaining role instructions and materialized skills\n' + JSON.stringify({instructions: after, skillInstructions}),
    '## Orchestration context and history (RO-managed Catalog is not native capability inventory)\n' + jsonRecords(history),
    ...(correction ? ['## Active technical correction\n' + JSON.stringify(correction)] : []),
  ].join('\n\n');
}

/** @param {readonly unknown[]} records */
function jsonRecords(records) {
  return '[\n' + records.map(record => JSON.stringify(record)).join(',\n') + '\n]';
}

/** @param {string} message @returns {Pick<import('../core/ports.js').ProviderResult, 'output' | 'decisionTextError'>} */
export function parseDecisionText(message) {
  /** @type {unknown} */
  let value;
  try {
    value = JSON.parse(message);
  } catch {
    return { output: message, decisionTextError: 'invalid_json' };
  }
  // Preserve deeply nested input as text, never recursively admit arbitrary JSON.
  if (!withinDecisionDepth(value, 16)) return { output: message, decisionTextError: 'depth' };
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { output: value, decisionTextError: 'non_object' };
  }
  return { output: value };
}

/** @param {unknown} value @param {number} remaining @returns {boolean} */
function withinDecisionDepth(value, remaining) {
  return value === null || typeof value !== 'object' ||
    (remaining > 0 && Object.values(value).every(item => withinDecisionDepth(item, remaining - 1)));
}

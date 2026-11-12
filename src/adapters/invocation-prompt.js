/** @import {Invocation} from '../core/ports.js' */

import { decisionContract } from '../application/decision-instructions.js';

/** @param {Invocation} request @param {string} transportDetail */
export function renderInvocationPrompt(request, transportDetail) {
  const { kind, operationId, attemptId, actionId, profile: { profileId }, objective,
    instructions, skillInstructions, userConstraints, context, expectedResult, continuationReference } = request;
  const output = kind === 'controller' ? 'Return exactly one JSON object as the final Controller message, with no Markdown fences. Intermediate progress and native tool calls are allowed.' :
    'Return the requested result in your final message. Plain text or the structured text specified by the task is accepted.';
  return output + '\n' + transportDetail + '\n\nInvocation (JSON):\n' + JSON.stringify({
    kind, operationId, attemptId, actionId, profileId, objective,
    instructions: kind === 'controller' && !instructions.includes(decisionContract) ? [decisionContract, ...instructions] : instructions, skillInstructions,
    userConstraints, context, expectedResult, continuationReference,
  });
}

/** @param {string} message @returns {unknown} */
export function parseDecisionText(message) {
  try {
    /** @type {unknown} */
    const value = JSON.parse(message);
    // A v1 Decision is shallow. Preserve excessively nested input as text so
    // it can be recorded without recursive admission of arbitrary JSON.
    return withinDecisionDepth(value, 16) ? value : message;
  } catch {
    return message;
  }
}

/** @param {unknown} value @param {number} remaining @returns {boolean} */
function withinDecisionDepth(value, remaining) {
  return value === null || typeof value !== 'object' ||
    (remaining > 0 && Object.values(value).every(item => withinDecisionDepth(item, remaining - 1)));
}

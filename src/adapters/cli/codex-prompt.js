import { renderInvocationPrompt } from '../invocation-prompt.js';

/** @param {import('../../core/ports.js').Invocation} request @param {string} approvalDetail */
export function renderCodexPrompt(request, approvalDetail) {
  return renderInvocationPrompt(request, approvalDetail +
    '\nContext retrieval is unavailable in this transport. Use the supplied context and report missing evidence explicitly.');
}

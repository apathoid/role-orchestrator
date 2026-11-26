import { retrievalDetail } from '../mcp-bridge.js';
import { renderInvocationPrompt } from '../invocation-prompt.js';

/** @param {import('../../core/ports.js').Invocation} request @param {string} approvalDetail @param {boolean} [retrieval] @param {(sizes:Record<string,number>)=>void} [measure] */
export function renderCodexPrompt(request, approvalDetail, retrieval = false, measure) {
  return renderInvocationPrompt(request, approvalDetail +
    '\n' + retrievalDetail(retrieval), measure);
}

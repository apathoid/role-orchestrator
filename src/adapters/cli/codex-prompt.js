import { retrievalDetail } from '../mcp-bridge.js';
import { renderInvocationPrompt } from '../invocation-prompt.js';

/** @param {import('../../core/ports.js').Invocation} request @param {string} approvalDetail @param {boolean} [retrieval] @param {(sizes:Record<string,number>)=>void} [measure] @param {Parameters<typeof retrievalDetail>[1]} [names] */
export function renderCodexPrompt(request, approvalDetail, retrieval = false, measure, names) {
  return renderInvocationPrompt(request, approvalDetail +
    '\n' + retrievalDetail(retrieval, names, request.kind), measure);
}

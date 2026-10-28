# ACP notification ingestion: provider-progress regression (revision 2)

## Reproduced report

On Node.js 24.21.0 with the project's installed ACP SDK, `npm run test:provider-progress` returned a provider result whose `structuredOutput.format` was `text`, with `parseError: No candidate JSON object was found.` The fake agent's Router path emits a JSON `agent_message_chunk`; this error therefore indicates no usable final answer reached the structured-output parser. It does **not** establish that the model produced invalid JSON.

The prior attempt only queued notification handling and waited for the queue when `session/prompt` returned. It was insufficient: `handleSessionUpdate` still awaited a potentially slow `onProgress` callback **before** appending final text to the session state. A delayed notification handler could also look up session state after the invocation had removed it.

## Corrective design

* `src/providers/acp/notification-state.mjs` captures model response text, unphased fallback text, usage updates, and tool events **synchronously at notification arrival**, before optional asynchronous presentation. Phase recognition and usage normalization are supplied by the provider adapter, so the collector does not depend on Zed or Codex.
* `src/providers/codex-acp.mjs` keeps an ordered, non-rejecting progress delivery queue but no longer waits on presentation before capturing final JSON. Delivery closures retain the correct inner-session state even after the session map is cleaned up. Progress callback failures cannot discard the provider's final answer.
* `test/acp-notification-state.mjs` verifies that split final JSON is available while a host progress promise is still unresolved, that commentary is excluded from the final answer, and that usage/tool events and unphased fallbacks are preserved.
* `test/provider-progress.mjs` retains its deliberately slow progress callback and asserts native final chunks are present. On failure, it reports only safe diagnostic counts (notifications received, final chunks, unphased characters, progress errors), not private prompt or tool content.

These changes are provider-boundary corrections. No Review Quality Gate, routing schema, authority policy, or general workflow algorithm is changed.

## Test status and remaining verification

In the available sandbox, `npm run check`, `npm run test:acp-notification-state`, `test/structured-output.mjs`, `test/provider-contract.mjs`, `test/turn-timing.mjs`, `test/review-quality-depth.mjs`, `test/review-quality-workflow.mjs`, and `test/review-efficiency.mjs` pass. The actual `test:provider-progress` integration cannot be run here because `node_modules/@agentclientprotocol/sdk` has no installed package files and the container cannot access the npm registry. Accordingly, it would be incorrect to declare the user's integration failure confirmed fixed.

In an environment with the installed SDK and Node >=22.20.0, run:

```sh
npm ci
npm run test:acp-notification-state
npm run test:provider-progress
npm test
```

If the integration still fails, the safe `acpNotificationDiagnostics` counter now distinguishes **no received notifications**, **received but no final chunks**, and **host progress errors**, which pinpoints the remaining transport boundary without speculating about the review workflow.

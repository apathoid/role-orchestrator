# Audit 2 — ACP Response Handling and Provider Reliability

## Production paths

- Codex ACP: `captureAcpSessionUpdate()` captures `final_answer` chunks synchronously, isolates `commentary`, keeps unphased chunks for compatibility and waits for the notification update queue before parsing. Final candidate text is prioritized. Last `session.prompt` stop reason is retained as metadata.
- Generic ACP: provider-tagged `commentary` is excluded from answer accumulation, tagged `final_answer` and unphased text remain separate; `stopReason` is reported. The unphased fallback is used only for a standalone (optionally fenced) JSON object when no explicit final appears; embedded JSON in unphased commentary is not sufficient authority.
- Codex CLI: full final text is parsed by the same shared extraction function; successful process exit is reported distinctly.
- All three adapters use the same `parseStructuredStateOrText` and existing SDK integration points. There is no extra parser or second Router.

## Test and audit outcomes

- **CONFIRMED / FIXED**: First-valid embedded-fragment selection was ambiguous for control decisions. The Router-only path now rejects multiple complete objects; commentary surrounding one object remains acceptable.
- **CONFIRMED / FIXED**: Presence of final and unphased content previously prompted concatenated candidate attempts. The Router-only path now prefers the authoritative final channel.
- **CONFIRMED / FIXED**: Generic ACP previously combined phase-tagged commentary and final content; it now separates them when phase metadata is provided.
- **PASS (deterministic)**: Multi-chunk final, reasoning before final, commentary before final, unphased fallback, empty completion, malformed and incomplete outputs, duplicate answers, competing JSON fragments and privacy checks.
- **ENVIRONMENT_BLOCKED**: Actual `@agentclientprotocol/sdk` 2.0.2 integration (`test:generic-acp`, `smoke`) was not runnable here because `npm ci` failed and the dependency was absent. Do not infer compatibility from syntactic verification alone.
- **NEEDS_MORE_DATA**: How provider-originated partial streams, duplicate notifications and real cancellation/timeout conditions behave with a live 2.0.2 SDK session across all providers.

## Reliability boundary

Provider failures (cancel, crash, timeout) continue to originate from invocation error handling, not router contract parsing. A successful `session.prompt` is *not* a validated task. The sanitizer reports only known `stopReason` labels; unknown provider statuses remain null. No automatic contract retry was added.

# Semantic Routing Observability — version 1

The existing execution observer records `route`, `route_validation`, `semantic_intent_validation`, `authorization_resolution`, `routing_outcome`, `trusted_continuation`, `role_router_context`, `role_start`, `role_done`, `role_error`, `role_cancelled`. New projections use `data.schemaVersion=1` while retaining the established JSONL envelope `version=1`.

A real Router invocation exists iff `role_start.role=router`. A trusted persisted Review continuation is recorded separately without inventing an invocation. `route` contains normalized `mode`, `writeIntent`, target kind, selector *type* (not raw refs or paths), continuation mode, ambiguity indicator and applied policy. Only identifier-shaped provider/model/profile strings, bounded usage observations, timing and normalized reasons enter storage. Missing usage is `null`, never zero. Raw tasks, prompts, instructions, tool outputs, Git refs, untrusted reason descriptions and chain-of-thought are excluded.

The observer applies its existing O_NOFOLLOW, 0600/0700, retention, JSONL bounded size and projection rules. When an append fails, in-memory trace.degraded is set; post-restart interrupted/incomplete traces are treated as partial evidence. 3000-event and 2MB quotas mean reports must check coverage. No telemetry result is ever used for routing, permissions, authorization or model selection.

`/routing report [run-id]` and `npm run routing:report -- [--root traceDir] [--session ID] [--run ID] [--from ISO] [--to ISO]` are read-only. The latter emits machine-readable JSON. Neither creates a model registry nor invokes the Router.

Limitations: the report reads at most 20 runs per session and 100 sessions by default. Entries exceeding that bound are not represented in totals. Old traces without new schema fields remain accepted, with unknown fields reported as unavailable.

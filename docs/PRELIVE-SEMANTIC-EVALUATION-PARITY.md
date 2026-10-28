# Semantic Evaluation Parity Report

## Original behavior

Production `src/workflow.mjs` built Router input from the current user text, trusted host mode, skills, saved operation metadata, project context, session history and `buildRouterContext`. Standalone `tools/semantic-evaluate.mjs` previously sent a short `roleInstructions.router + user text` string. Consequently its classifications could not fairly be compared to production.

## New shared path

```
  Production runWorkflow ----> buildSemanticRouterRequest ----> compileRouterPrompt
                                       |                         |
  Semantic evaluator ----------> same function -----------------+
                                           ---> Router provider (read-only)
```

`src/routing/request.mjs` owns the body and context construction. It delegates manifest/strict-digest projection to `src/routing/context.mjs`; schema is `schemas.routing`. `roleSessionContext('router')` is resolved before projection; the Router invocation must not overwrite context after construction. Evaluation uses the identical compiled prompt and the same schema kind, schema, sandbox, provided prompt blocks, MCP servers and additional directories. Both resolve the configured `router` role through the normal model registry when using a real provider; offline mode does not invoke a provider.

### Reproduction / equivalence cases

`node test/router-request-parity.mjs` compares captured actual workflow Router requests with freshly constructed evaluation requests. It covers normal Investigate, host Change, plan-only, saved Plan metadata, saved Review metadata, session history, role callback history, skill names, project instructions, malicious project modification, `observe`/`optimized` projection and nonempty prompt blocks. It asserts prompt bytes, typed schema and read-only sandbox for the captured cases. It separately tests that a reviewed manifest with a matching digest selects `optimized`, and a changed project document falls back to `legacy` without granting authority.

**Evidence:** `router-parity-final.log`, `final-npm_run_test_router-request-parity.log`. This is local fixture equivalence; it is not a statistical proof that all host/environment combinations are equivalent. Real provider selection and ACP negotiation require live acceptance.

### Offline evaluation correctness

`node test/semantic-evaluator-offline.mjs` exercises a 10-item synthetic corpus: valid task, top-level/nested contradiction, missing task, timeout, crash, cancellation, partial valid result, false-positive Change, invalid Git selector and wrong continuation. It also tests omitted fixture responses. A failed provider attempt is not a failed semantic classification. Semantic accuracy denominators include only validated typed responses. The invalid-contract rate divides by typed responses *attempting* validation, not by transport failures. Missing offline fixtures do not count as model invocations. Token usage may be observed even for a semantically invalid response. Real accuracy is not verified by offline data.

### Commands

```bash
npm run test:router-request-parity
npm run test:semantic-evaluator-offline
node tools/semantic-evaluate.mjs "$PWD" test/evaluation/semantic-intent-corpus.json --run
node tools/semantic-evaluate.mjs /repo/path corpus.json --offline fixture.json
```

Offline file contract: `{ "version": 1, "responses": { "case_id": { "result": { "outputFormat": "structured", "output": { "mode": "investigate", "writeIntent": "not_requested", "task": { /* v1 */ } } }, "latencyMs": 12 } } }`; an error case may supply `{"error":{"code":"TIMEOUT","message":"..."}}`. Existing corpus expectations stay intact.

**Caveat:** The original corpus contains plain-text requests and has no actual production Zed session/attachment history. To claim representative model accuracy, supply matching trusted host context in each scenario and verify provider calls and route outcomes. A test with synthetic Router responses cannot substitute for that measurement.

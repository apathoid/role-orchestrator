# C12.0.1 — Migration inventory and verified baseline

Source branch: `greenfield/model-first-core`; reviewed HEAD: `cbd8e70baca3ab380a2ed3d43ae1fdd667616412` (2026-11-10).
Last pre-migration GitHub Actions result: [run 42868825084](https://github.com/apathoid/role-orchestrator/actions/runs/42868825084), conclusion **success**, on this exact HEAD. This is historical source-layout evidence, **not** migrated-layout verification.
Earlier detailed suite baseline: [run 42821614211](https://github.com/apathoid/role-orchestrator/actions/runs/42821614211), commit `949292a`, 4 foundation + 25 core + 52 contracts + 217 integration = 298 tests, all PASS. Compare test identities and their contracts during migration, not counts alone.

## Reproducible pre-migration commands

`nix develop --no-update-lock-file --command npm ci --ignore-scripts --no-audit --no-fund`
`nix develop --no-update-lock-file --command npm --prefix development ci --ignore-scripts --no-audit --no-fund`
`nix develop --no-update-lock-file --command npm --prefix development run check`
`nix develop --no-update-lock-file --command npm --prefix development run test:foundation`
`nix develop --no-update-lock-file --command npm --prefix development run test:core`
`nix develop --no-update-lock-file --command npm --prefix development run test:contracts`
`nix develop --no-update-lock-file --command npm --prefix development run test:integration`
`nix develop --no-update-lock-file --command npm --prefix development run check:package`
`nix develop --no-update-lock-file --command npm --prefix development run check:removal`
`nix flake check --no-update-lock-file`

No acceptance/native suite test files exist in the source tree: `run-suite.mjs` refuses empty suites. Real Codex CLI model, independent native ACP model, Zed client, and NixOS deployment remain UNVERIFIED. Historical Codex native probe returned HTTP 401; ACP handshake alone did not establish model success. Do not label those as PASS.

## Inventory and disposition

Every Git-tracked source file under `development/` at the recorded HEAD is listed below; Git history retains retired content. The target column is the **single active destination or archival disposition**. Source links in README/AGENTS/docs, npm/Nix/CI, scripts, tests, and relative imports must be updated before removal. No old files are deleted in C12.0.1.

| Old path | Destination / disposition |
|---|---|
| `development/LAYOUT_AND_RETENTION.md` | Git history + D16 (superseded) |
| `development/START_HERE.md` | replace with AGENTS.md + docs/roadmap/README.md |
| `development/STATUS.md` | docs/roadmap/STATUS.md (condensed current + verified evidence) |
| `development/agent/REASONING.md` | .agents/REASONING.md |
| `development/agent/engineering/README.md` | .agents/engineering/README.md |
| `development/agent/engineering/decision-process.md` | .agents/engineering/decision-process.md |
| `development/agent/engineering/final-validation-checkpoint.md` | .agents/engineering/final-validation-checkpoint.md |
| `development/agent/engineering/hard-invariants.md` | .agents/engineering/hard-invariants.md |
| `development/agent/engineering/implementation-checkpoints.md` | .agents/engineering/implementation-checkpoints.md |
| `development/agent/engineering/kernel.md` | .agents/engineering/kernel.md |
| `development/agent/engineering/planning-checkpoint.md` | .agents/engineering/planning-checkpoint.md |
| `development/agent/engineering/review-checkpoint.md` | .agents/engineering/review-checkpoint.md |
| `development/agent/engineering/review-rubric.md` | .agents/engineering/review-rubric.md |
| `development/jsconfig.json` | root jsconfig.json |
| `development/package-lock.json` | merge npm scripts/devDependencies into root package.json/package-lock.json; retire duplicate |
| `development/package.json` | merge npm scripts/devDependencies into root package.json/package-lock.json; retire duplicate |
| `development/plan/IMPLEMENTATION_PLAN.md` | docs/roadmap/IMPLEMENTATION_PLAN.md (active stages only) |
| `development/plan/clusters/C00_FOUNDATION.md` | Git history; confirm current contracts in docs/ (completed plan) |
| `development/plan/clusters/C01_CORE_CONTRACTS.md` | Git history; confirm current contracts in docs/ (completed plan) |
| `development/plan/clusters/C02_COORDINATOR.md` | Git history; confirm current contracts in docs/ (completed plan) |
| `development/plan/clusters/C03_MULTI_MODEL.md` | Git history; confirm current contracts in docs/ (completed plan) |
| `development/plan/clusters/C04_CONFIGURATION_AUTHORITY.md` | Git history; confirm current contracts in docs/ (completed plan) |
| `development/plan/clusters/C05_DURABILITY.md` | Git history; confirm current contracts in docs/ (completed plan) |
| `development/plan/clusters/C06_CONTEXT_FINDINGS.md` | Git history; confirm current contracts in docs/ (completed plan) |
| `development/plan/clusters/C07_CLI_PROVIDER.md` | Git history; confirm current contracts in docs/ (completed plan) |
| `development/plan/clusters/C08_ACP_PROVIDER.md` | Git history; confirm current contracts in docs/ (completed plan) |
| `development/plan/clusters/C09_EXTENSIBILITY.md` | Git history; confirm current contracts in docs/ (completed plan) |
| `development/plan/clusters/C10_PUBLIC_HOSTS.md` | Git history; confirm current contracts in docs/ (completed plan) |
| `development/plan/clusters/C11R_REASONING_EFFORT.md` | Git history; confirm current contracts in docs/ (completed plan) |
| `development/plan/clusters/C11_DIAGNOSTICS_HARDENING.md` | Git history; confirm current contracts in docs/ (completed plan) |
| `development/plan/clusters/C12_ACCEPTANCE_DELIVERY.md` | docs/roadmap/C12_ACCEPTANCE_DELIVERY.md |
| `development/quality/ACCEPTANCE_MATRIX.md` | tests/ACCEPTANCE_MATRIX.md |
| `development/quality/fixtures/acp-contract-agent.js` | tests/fixtures/acp-contract-agent.js |
| `development/quality/fixtures/application.js` | tests/fixtures/application.js |
| `development/quality/fixtures/boundaries/adapters/provider.js` | tests/fixtures/boundaries/adapters/provider.js |
| `development/quality/fixtures/boundaries/core/invalid.js` | tests/fixtures/boundaries/core/invalid.js |
| `development/quality/fixtures/boundaries/core/portable.js` | tests/fixtures/boundaries/core/portable.js |
| `development/quality/fixtures/codex-contract-child.js` | tests/fixtures/codex-contract-child.js |
| `development/quality/fixtures/codex-durable-child.js` | tests/fixtures/codex-durable-child.js |
| `development/quality/fixtures/codex-durable-host.js` | tests/fixtures/codex-durable-host.js |
| `development/quality/fixtures/codex-mcp-child.js` | tests/fixtures/codex-mcp-child.js |
| `development/quality/fixtures/core.js` | tests/fixtures/core.js |
| `development/quality/fixtures/dispatch-crash.js` | tests/fixtures/dispatch-crash.js |
| `development/quality/fixtures/echo-plugin.js` | tests/fixtures/echo-plugin.js |
| `development/quality/fixtures/host-plugin.js` | tests/fixtures/host-plugin.js |
| `development/quality/fixtures/mcp-client.js` | tests/fixtures/mcp-client.js |
| `development/quality/fixtures/provider-contract.js` | tests/fixtures/provider-contract.js |
| `development/quality/fixtures/skills-plugin.js` | tests/fixtures/skills-plugin.js |
| `development/quality/fixtures/state-writer.js` | tests/fixtures/state-writer.js |
| `development/quality/fixtures/tools-plugin.js` | tests/fixtures/tools-plugin.js |
| `development/quality/fixtures/types/invalid.js` | tests/fixtures/types/invalid.js |
| `development/quality/fixtures/types/jsconfig.json` | tests/fixtures/types/jsconfig.json |
| `development/quality/scripts/check-boundaries.mjs` | scripts/check-boundaries.mjs |
| `development/quality/scripts/check-javascript.mjs` | scripts/check-javascript.mjs |
| `development/quality/scripts/check-nix-install.sh` | scripts/check-nix-install.sh |
| `development/quality/scripts/check-package.mjs` | scripts/check-package.mjs |
| `development/quality/scripts/check-specification.mjs` | scripts/check-specification.mjs |
| `development/quality/scripts/owned-run.mjs` | scripts/owned-run.mjs |
| `development/quality/scripts/run-suite.mjs` | scripts/run-suite.mjs |
| `development/quality/tests/contracts/acp-provider.test.js` | tests/contracts/acp-provider.test.js |
| `development/quality/tests/contracts/acp-v1-surface.test.js` | tests/contracts/acp-v1-surface.test.js |
| `development/quality/tests/contracts/external-tools.test.js` | tests/contracts/external-tools.test.js |
| `development/quality/tests/contracts/plugin-api.test.js` | tests/contracts/plugin-api.test.js |
| `development/quality/tests/contracts/provider-port.test.js` | tests/contracts/provider-port.test.js |
| `development/quality/tests/core/action-graph.test.js` | tests/core/action-graph.test.js |
| `development/quality/tests/core/core.test.js` | tests/core/core.test.js |
| `development/quality/tests/core/diagnostics-taxonomy.test.js` | tests/core/diagnostics-taxonomy.test.js |
| `development/quality/tests/core/reasoning-effort.test.js` | tests/core/reasoning-effort.test.js |
| `development/quality/tests/core/reasoning-snapshot.test.js` | tests/core/reasoning-snapshot.test.js |
| `development/quality/tests/core/snapshot.test.js` | tests/core/snapshot.test.js |
| `development/quality/tests/foundation/foundation.test.js` | tests/foundation/foundation.test.js |
| `development/quality/tests/integration/assessment.test.js` | tests/integration/assessment.test.js |
| `development/quality/tests/integration/cli-process.test.js` | tests/integration/cli-process.test.js |
| `development/quality/tests/integration/codex-durable.test.js` | tests/integration/codex-durable.test.js |
| `development/quality/tests/integration/codex-launch.test.js` | tests/integration/codex-launch.test.js |
| `development/quality/tests/integration/codex-output.test.js` | tests/integration/codex-output.test.js |
| `development/quality/tests/integration/codex-provider.test.js` | tests/integration/codex-provider.test.js |
| `development/quality/tests/integration/configuration.test.js` | tests/integration/configuration.test.js |
| `development/quality/tests/integration/context-quality.test.js` | tests/integration/context-quality.test.js |
| `development/quality/tests/integration/context.test.js` | tests/integration/context.test.js |
| `development/quality/tests/integration/delegation.test.js` | tests/integration/delegation.test.js |
| `development/quality/tests/integration/diagnostic-bounds.test.js` | tests/integration/diagnostic-bounds.test.js |
| `development/quality/tests/integration/diagnostic-export.test.js` | tests/integration/diagnostic-export.test.js |
| `development/quality/tests/integration/diagnostic-races.test.js` | tests/integration/diagnostic-races.test.js |
| `development/quality/tests/integration/diagnostic-redaction.test.js` | tests/integration/diagnostic-redaction.test.js |
| `development/quality/tests/integration/diagnostic-sink.test.js` | tests/integration/diagnostic-sink.test.js |
| `development/quality/tests/integration/durable-dispatch.test.js` | tests/integration/durable-dispatch.test.js |
| `development/quality/tests/integration/evidence-addressing.test.js` | tests/integration/evidence-addressing.test.js |
| `development/quality/tests/integration/extension-compatibility.test.js` | tests/integration/extension-compatibility.test.js |
| `development/quality/tests/integration/extensions.test.js` | tests/integration/extensions.test.js |
| `development/quality/tests/integration/external-tool-review.test.js` | tests/integration/external-tool-review.test.js |
| `development/quality/tests/integration/handoff.test.js` | tests/integration/handoff.test.js |
| `development/quality/tests/integration/host-acp.test.js` | tests/integration/host-acp.test.js |
| `development/quality/tests/integration/host-cli-permissions.test.js` | tests/integration/host-cli-permissions.test.js |
| `development/quality/tests/integration/host-cli.test.js` | tests/integration/host-cli.test.js |
| `development/quality/tests/integration/local-control.test.js` | tests/integration/local-control.test.js |
| `development/quality/tests/integration/local-store.test.js` | tests/integration/local-store.test.js |
| `development/quality/tests/integration/mcp-context.test.js` | tests/integration/mcp-context.test.js |
| `development/quality/tests/integration/mutable-context.test.js` | tests/integration/mutable-context.test.js |
| `development/quality/tests/integration/orchestrator.test.js` | tests/integration/orchestrator.test.js |
| `development/quality/tests/integration/permissions.test.js` | tests/integration/permissions.test.js |
| `development/quality/tests/integration/reasoning-config.test.js` | tests/integration/reasoning-config.test.js |
| `development/quality/tests/integration/reasoning-controller.test.js` | tests/integration/reasoning-controller.test.js |
| `development/quality/tests/integration/reasoning-delegation.test.js` | tests/integration/reasoning-delegation.test.js |
| `development/quality/tests/integration/reasoning-diagnostics.test.js` | tests/integration/reasoning-diagnostics.test.js |
| `development/quality/tests/integration/reasoning-end-to-end.test.js` | tests/integration/reasoning-end-to-end.test.js |
| `development/quality/tests/integration/reasoning-failure.test.js` | tests/integration/reasoning-failure.test.js |
| `development/quality/tests/integration/reasoning-recovery.test.js` | tests/integration/reasoning-recovery.test.js |
| `development/quality/tests/integration/resume.test.js` | tests/integration/resume.test.js |
| `development/quality/tests/integration/retention.test.js` | tests/integration/retention.test.js |
| `development/quality/tests/integration/retry.test.js` | tests/integration/retry.test.js |
| `development/quality/tests/integration/runtime.test.js` | tests/integration/runtime.test.js |
| `development/quality/tests/integration/worker-request-identity.test.js` | tests/integration/worker-request-identity.test.js |
| `development/reports/C07/CLI_CONTROLLER_AND_WORKER.md` | Git history; transfer durable findings into topical docs/DECISIONS (do not duplicate raw reports) |
| `development/reports/C07/CLI_DURABLE_RUN.md` | Git history; transfer durable findings into topical docs/DECISIONS (do not duplicate raw reports) |
| `development/reports/C07/CLI_LAUNCH.md` | Git history; transfer durable findings into topical docs/DECISIONS (do not duplicate raw reports) |
| `development/reports/C07/CLI_NATIVE_PROBE.md` | Git history; transfer durable findings into topical docs/DECISIONS (do not duplicate raw reports) |
| `development/reports/C07/CLI_OUTPUT_FRAMING.md` | Git history; transfer durable findings into topical docs/DECISIONS (do not duplicate raw reports) |
| `development/reports/C07/CLI_PERMISSIONS.md` | Git history; transfer durable findings into topical docs/DECISIONS (do not duplicate raw reports) |
| `development/reports/C07/CLI_PROCESS_OWNERSHIP.md` | Git history; transfer durable findings into topical docs/DECISIONS (do not duplicate raw reports) |
| `development/reports/C07/PROVIDER_PORT_CONTRACT.md` | Git history; transfer durable findings into topical docs/DECISIONS (do not duplicate raw reports) |
| `development/reports/C08/ACP_ADAPTER.md` | Git history; transfer durable findings into topical docs/DECISIONS (do not duplicate raw reports) |
| `development/reports/C08/ACP_V1_PROTOCOL_MAPPING.md` | Git history; transfer durable findings into topical docs/DECISIONS (do not duplicate raw reports) |
| `development/reports/C09/ACCEPTANCE.md` | Git history; transfer durable findings into topical docs/DECISIONS (do not duplicate raw reports) |
| `development/reports/C09/MCP_TRANSPORT.md` | Git history; transfer durable findings into topical docs/DECISIONS (do not duplicate raw reports) |
| `development/reports/C11R/INTEGRATION.md` | Git history; transfer durable findings into topical docs/DECISIONS (do not duplicate raw reports) |
| `development/reports/JAVASCRIPT_NIX_CI_FOUNDATION.md` | Git history; transfer durable findings into topical docs/DECISIONS (do not duplicate raw reports) |
| `development/reports/SPECIFICATION_REVIEW.md` | Git history; transfer durable findings into topical docs/DECISIONS (do not duplicate raw reports) |

## Known knowledge and migration gaps

- Normative product contracts live in `docs/`; older plans/reports can contain context or unresolved assertions, not independent active requirements. Reconcile C07/C08/C11R provider constraints and D10/D11/D14/D15/R25 with current contracts and A01/A37/A42/A43.
- A01–A54 and R01–R33 need an explicit single mapping to test files, actual evidence and remaining native gaps; M01–M04 are engineering migration conditions, not product behavior.
- New active roadmap/status must be readable directly via AGENTS.md after C12.0, and the source tree must retain regression tools while the published package excludes them.
- `check-specification.mjs` depends on old plan headings and matrix; `check-javascript.mjs` depends on development cwd; `owned-run.mjs` creates development/runs. CI currently conditionally skips suites when development is absent. Each is an obligatory fix.
- Provenance gap: environment executing this migration has GitHub repository API access but no local Node 24/Nix execution of the checkout. GitHub CI on new commits must be separately checked; never present unexecuted local commands as observed.

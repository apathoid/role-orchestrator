#!/usr/bin/env bash
set -euo pipefail

checkout=$(pwd)
temporary=$(mktemp -d)
trap 'rm -rf "$temporary"' EXIT
export XDG_CONFIG_HOME="$temporary/config"
export XDG_STATE_HOME="$temporary/state"
mkdir -p "$temporary/work" "$temporary/bin" "$XDG_CONFIG_HOME/role-orchestrator"

nix build --no-update-lock-file --no-link "$checkout#role-orchestrator"
package=$(nix path-info "$checkout#role-orchestrator")
test ! -e "$package/lib/node_modules/role-orchestrator/development"
node "$package/lib/node_modules/role-orchestrator/node_modules/@openai/codex/bin/codex.js" --version | grep "codex-cli"
nix profile add --profile "$temporary/profile" "$checkout#role-orchestrator"

cat > "$temporary/bin/fixture-path-command" <<'COMMAND'
#!/bin/sh
printf '%s\n' "$PWD"
COMMAND
chmod +x "$temporary/bin/fixture-path-command"
export PATH="$temporary/bin:$PATH"

cat > "$XDG_CONFIG_HOME/role-orchestrator/config.json" <<'CONFIG'
{
  "schemaVersion": 1,
  "controllerProfile": "primary",
  "profiles": { "primary": { "provider": "fixture", "model": "fixture" } },
  "providers": { "fixture": { "adapter": "fixture", "launch": { "command": "fixture-path-command" } } },
  "plugins": [{ "id": "fixture", "module": "./fixture.mjs" }]
}
CONFIG

cat > "$XDG_CONFIG_HOME/role-orchestrator/fixture.mjs" <<'PLUGIN'
import { execFileSync } from 'node:child_process';
export const manifest = { id: 'fixture', version: '1', apiVersion: 1, exports: ['createProvider'] };
export function createProvider({ providerId }) {
  return {
    async describe() { return { providerId, maxConcurrency: null, capabilities: {} }; },
    async open() { return { sessionId: 'fixture' }; },
    async invoke(_session, invocation) {
      const answer = execFileSync('fixture-path-command', { cwd: invocation.workspaceContext.cwd, encoding: 'utf8' }).trim();
      return {
        dispatchCertainty: 'sent',
        outcome: { schemaVersion: 1, attemptId: invocation.attemptId, terminal: 'completed', effect: 'none',
          diagnostics: [], outputRefs: [], usage: { inputTokens: null, outputTokens: null, cost: null } },
        output: { schemaVersion: 1, decisionId: 'fixture', operationId: invocation.operationId, contextCursor: 0,
          additions: [], cancellations: [], finalAssessment: { author: invocation.profile.profileId, overall: 'complete',
            answer, requirements: [], observationRefs: [], findingRefs: [], unresolvedQuestions: [] } },
      };
    },
    async cancel() {},
    async close() {},
  };
}
PLUGIN

cd "$temporary/work"
test ! -e .git
nix run --no-update-lock-file "$checkout#role-orchestrator" -- --help | grep 'Usage: role-orchestrator'
nix run --no-update-lock-file "$checkout" -- --help | grep 'Usage: role-orchestrator'
"$temporary/profile/bin/role-orchestrator" acp --help | grep 'acp'
test "$("$temporary/profile/bin/role-orchestrator" run fixture)" = "$(pwd -P)"
test -f "$XDG_STATE_HOME/role-orchestrator/.writer.sqlite"

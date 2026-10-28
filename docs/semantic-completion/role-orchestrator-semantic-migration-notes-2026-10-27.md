# Migration notes

- **User configuration, model presets and provider definitions:** no mandatory file changes introduced by the patch. An existing provider must now correctly return `task.version=1`, so a model that omits it produces an incomplete result; test configured Router models before rollout.
- **Session storage:** no manual JSON migration. Existing implementation Plans remain available, but selection requires validated current intent, repository and plan digest checks.
- **Review checkpoints:** legacy checkpoints without a validated `taskSpec` are retained as diagnostic state but cannot be auto-resumed. Start a new review for them. This is an intentional limitation and can affect existing users.
- **Implementation checkpoints:** Plan digest and repository identity verification remain; do not rewrite old checkpoint bytes. Test restoration on a copy of state before production rollout.
- **Git review API:** `resolveReviewScope` no longer parses natural-language strings. External code using the former string signature must supply typed selector(s).
- **Injected workflow API:** a dependency-injected workflow now receives `onSelectSavedImplementation` and must use it after typed interpretation. It will no longer get preselected `authoritativePlan` from user text. This is a required API adaptation.
- **Executables:** `test/fake-codex.mjs` must be executable on Unix for the local CLI test; the patch sets this file to mode 755.
- **Production rollout:** blocked pending supported Node, locked dependencies, successful full suite, measurable live semantic evaluation and Zed validation.

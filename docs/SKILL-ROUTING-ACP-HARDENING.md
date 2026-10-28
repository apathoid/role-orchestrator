# Skill Invocation, Routing & ACP Presentation hardening

## Scope

These changes extend the generic orchestration core; no dedicated `/changed`, Zed, OpenCode, GPT-OSS or Codex branch is introduced.

### Skill command interpretation

- `/name <arguments>` and `/skill name <arguments>` resolve the selected skill before running the Router. Registered skill names are resolved from `~/.agents/skills` and `<repo>/.agents/skills`; the latter takes precedence.
- Explicit affirmative phrases (`Используй skill /name`, `Примени скилл name`, `Use skill /name`) are recognized while negative instructions, questions and examples inside Markdown code spans/fences are not treated as commands.
- An unregistered explicit skill request yields `SKILL_NOT_FOUND`; an unknown leading slash command yields `UNKNOWN_COMMAND`, rather than silently being treated as an independent task.
- `skillInvocation` carries the original user request, skill name, arguments and source separately from `invocation.task`. The workflow injects an explicit execution directive into `modelTask` for Router, Explorer and subsequent roles. The normal `ACTIVE SKILL` context still contains the actual skill body. Existing callers without `skillInvocation` retain their normal behavior.
- A skill may optionally declare `orchestrator-mode: investigate` or `orchestrator-mode: review` in `SKILL.md` frontmatter. This is a read-only routing hint, not an authorization to write. For legacy skills, the route guard may use an unambiguous skill *description*, but never the skill name.

### Routing

- The Router remains the semantic classifier. A host-specified mode wins. The independent guard corrects only high-confidence conflicts, such as an explicit description request being classified as `review` or an explicit code-review request being classified as `investigate`.
- Selecting a skill without clear write authorization cannot itself initiate `change`. Existing authorization and Plan-only restrictions still apply.
- The guard uses conservative text checks; ambiguous requests are left to the Router rather than being coerced into a new mode. `route_validation` emits an allowlisted status/reason (not the task text).

### Review progress

- Two consecutive batches with no verified Units and the same *structurally identifiable* failure class (`UNSTRUCTURED_REVIEW_OUTPUT`, `MISSING_REVIEW_UNIT_RESULTS`, `REPEATED_MISSING_EVIDENCE`, `REPEATED_INVALID_FILE_EVIDENCE`) stop the current attempt early.
- A single unsuccessful batch is not enough. Uncertain, independent or mixed failures do not trigger a speculative stop.
- Existing verified evidence and checkpoints are preserved. Pending Units remain pending. `review_progress_blocked` is sent to user-facing progress and P3.

### Generic ACP and Markdown

- Generic ACP buffers `agent_message_chunk` text as the inner provider's final-answer candidate; the *outer* ACP agent publishes that final text exactly once. Reasoning, tools, plans and non-text media updates are still propagated.
- A complete text response is normalized only when it consists of one enclosing `markdown` or `md` code fence that contains a recognizably structured Markdown document. Ordinary code blocks, responses containing examples, and requests for literal Markdown source are left unchanged.
- Structured JSON contracts bypass this normalization.
- Buffered final text is unavailable to the outer client until the inner invocation finishes. This trades immediate text streaming for a single reliable publication boundary, especially for smaller models.

### P3

The run-level, allowlisted measurements now include `skillInvocationSource`, `skillResolutionStatus`, `routeValidationStatus`, `routeCorrectionReason`, `reviewStopReason`, `reviewNoProgressBatches`. The export does not contain the skill body, name, task text, paths or provider output. Older run records continue to deserialize with `null` for missing optional fields.

## Important limitations

- This patch does not configure the OpenCode read-only ACP mode. Map it to a safe provider agent with actual restricted permissions; `plan` can impose conflicting instructions, and `build` is not a substitute for read-only security isolation.
- The route guard deliberately does not make an LLM's semantic accuracy provable: ambiguous tasks, misleading skill descriptions, and content without a declared semantic purpose can still be misrouted. The guard is not a replacement for model evaluations.
- Final-answer buffering is implemented for Generic ACP text. Other provider implementations retain their own stream/delivery contracts.
- No production invocation against a live OpenCode/GPT-OSS endpoint was available during the local checks. The Generic ACP SDK integration test requires installing `@agentclientprotocol/sdk` and was not run in the supplied environment.

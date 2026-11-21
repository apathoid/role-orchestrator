# C15R — observed transcript and measurement evidence

Implementation `9c09318f729b20fa989e1d4c6474a7eea7c0eff5`; [CI 43713292671](https://github.com/apathoid/role-orchestrator/actions/runs/43713292671), job `132809348120`, Node 24.21.0, 2026-11-15. Source: actual SDK subprocess and Linux PTY fixture output, decoded from the CI log JSON fields. No real LLM or graphical client acceptance. Operation/attempt/event IDs are as captured. The non-TTY probe captures stderr independently; the separately asserted stdout is `Version updated.\n`. No cross-sink ordering is claimed. PTY captures merged human-terminal output.

## Baseline compact stderr (red witness)

```text
Role Orchestrator · compact · Operation 404fd0f2-849a-4828-9c95-5a6771391530
[Controller #1 · primary] Invocation dispatched · selector=fixture · native effort
[Controller #1 · primary] Thinking: Inspect the commit.
Read the diff.
[Controller #1 · primary] Tool shell · pending
[Controller #1 · primary] Tool git show HEAD · in_progress
[Controller #1 · primary] Tool git show HEAD · in_progress
[Controller #1 · primary] Tool tool_call_update · completed
[Controller #1 · primary] Tool Read package.json · in_progress
[Controller #1 · primary] Tool tool_call_update · failed
[Controller #1 · primary] Thinking: Version only.
[Controller #1 · primary] Outcome recorded · reported terminal=completed · reported effect=unknown
[Operation 404fd0f2-849a-4828-9c95-5a6771391530] Assessment recorded · complete
[Operation 404fd0f2-849a-4828-9c95-5a6771391530] complete · invocations 1/40 · workers 0 · recorded findings 0 · unknown effects/outcomes
```

## Current compact stderr (green witness)

```text
Role Orchestrator · compact · 8cbdbe5b

● Controller #1 · primary
  Invocation dispatched · selector=fixture · native effort

  Thinking · Controller #1 · primary
  Inspect the commit.
  Read the diff.
  ◇ git show HEAD · in_progress
  ✓ git show HEAD · completed
  ◇ Read package.json · in_progress
  ✗ Read package.json · failed

  Thinking · Controller #1 · primary
  Version only.
  ◇ Outcome reported · completed · effect=unknown

◇ Assessment recorded · complete

✓ Operation complete
  1 Controller attempt · 0 Worker attempts · 0 recorded findings
  Unknown effects/outcomes remain.
```

## Current detailed stderr (green witness)

```text
Role Orchestrator · detailed · 174699f2

● Controller #1 · primary
  Invocation dispatched · selector=fixture · native effort

  Thinking · Controller #1 · primary
  Inspect the commit.
  Read the diff.
  ◇ shell · pending
  ◇ git show HEAD · in_progress
  ✓ git show HEAD · completed
  ◇ Read package.json · in_progress
  ✗ Read package.json · failed

  Thinking · Controller #1 · primary
  Version only.

[Controller #1 · primary] Outcome recorded · reported terminal=completed · reported effect=unknown

[Operation 174699f2-1294-452f-9754-e09275d5f4f1] Assessment recorded · complete

✓ Operation complete
  1 Controller attempt · 0 Worker attempts · 0 recorded findings
  Unknown effects/outcomes remain.
  Operation 174699f2-1294-452f-9754-e09275d5f4f1 · dispatch records 1/1 · budget charged 1/40
  Controller f28e7db6-e12c-4c31-8cc7-d3731dc44a79 · primary · completed · dispatch=sent · effect=unknown
```

## Current debug stderr (green witness)

```text
Role Orchestrator · debug · Operation 169f0a33-0af4-466e-a2d5-d38138cf9f86

[Controller #1] attempt.reserved · RESERVED event=81311525-d477-4221-bc46-e8ce007789c0 seq=1 at=1794745345448 attempt=60f01377-b48f-40f4-93c9-9cc3915587bf

● Controller #1 · primary
  Invocation dispatched · selector=fixture · native effort
  attempt=60f01377-b48f-40f4-93c9-9cc3915587bf event=45fe47ba-6600-4de7-944c-d495d57f1180 seq=2 at=1794745345454 reason=DISPATCH_STARTED

[Controller 60f01377-b48f-40f4-93c9-9cc3915587bf] context.host_prepared · SERIALIZED event=faa4aca9-ebda-43db-8ca5-3442f9f658de seq=2 at=1794745345457

[Controller 60f01377-b48f-40f4-93c9-9cc3915587bf] controller.requested · DISPATCH_STARTED event=3cc80a3a-8194-4650-88f9-a7e83dcd7701 seq=2 at=1794745345457

Controller #1 · primary

  Thinking · Controller #1 · primary [test agent_thought_chunk]
  Inspect the commit.
  Read the diff.
  ◇ shell · pending [tool_call shell seq=3]
  ◇ git show HEAD · in_progress [tool_call_update shell seq=4]
  ◇ git show HEAD · in_progress [tool_call_update shell seq=5]
  ✓ git show HEAD · completed [tool_call_update shell seq=6]
  ◇ Read package.json · in_progress [tool_call read seq=7]
  ✗ Read package.json · failed [tool_call_update read seq=8]

  Thinking · Controller #1 · primary [test agent_thought_chunk]
  Version only.

[Controller 60f01377-b48f-40f4-93c9-9cc3915587bf] provider.reply_observed · PROVIDER_REPLIED event=b2f908da-4432-443c-971f-f23546ac08ac seq=1 at=1794745345654

[Controller #1 · primary] attempt.outcome · reported terminal=completed · reported effect=unknown · COMPLETED event=c770fa75-9560-4ed1-8e0b-214894d529ee seq=3 at=1794745345655 attempt=60f01377-b48f-40f4-93c9-9cc3915587bf

[Controller #1 · primary] controller.responded · ACCEPTED event=5b83bd9e-5fc2-4bf0-b84f-2d6fea8c2628 seq=4 at=1794745345659 attempt=60f01377-b48f-40f4-93c9-9cc3915587bf

[Operation 169f0a33-0af4-466e-a2d5-d38138cf9f86] operation.finished · complete · ASSESSMENT_RECORDED event=3ab52e72-3f62-4f53-94f3-2f09c8e469d1 seq=5 at=1794745345661

✓ Operation complete
  1 Controller attempt · 0 Worker attempts · 0 recorded findings
  Unknown effects/outcomes remain.
  Operation 169f0a33-0af4-466e-a2d5-d38138cf9f86 · dispatch records 1/1 · budget charged 1/40
  Controller 60f01377-b48f-40f4-93c9-9cc3915587bf · primary · completed · dispatch=sent · effect=unknown
```

## Direct actual PTY (NO_COLOR, shared terminal)

```text
Role Orchestrator · compact · b6004053

● Controller #1 · primary
  Invocation dispatched · selector=fixture · native effort

  Thinking · Controller #1 · primary
  Inspect the commit.
  Read the diff.
  ◇ git show HEAD · in_progress
  ✓ git show HEAD · completed
  ◇ Read package.json · in_progress
  ✗ Read package.json · failed

  Thinking · Controller #1 · primary
  Version only.
  ◇ Outcome reported · completed · effect=unknown

◇ Assessment recorded · complete
Version updated.

✓ Operation complete
  1 Controller attempt · 0 Worker attempts · 0 recorded findings
  Unknown effects/outcomes remain.
```

## Attached actual PTY (shared terminal)

```text
Role Orchestrator · compact · 62a4c58b

● Controller #1 · primary
  Invocation dispatched · selector=fixture · native effort

  Thinking · Controller #1 · primary
  Inspect the commit.
  Read the diff.
  ◇ git show HEAD · in_progress
  ✓ git show HEAD · completed
  ◇ Read package.json · in_progress
  ✗ Read package.json · failed

  Thinking · Controller #1 · primary
  Version only.
  ◇ Outcome reported · completed · effect=unknown

◇ Assessment recorded · complete
Version updated.

✓ Operation complete
  1 Controller attempt · 0 Worker attempts · 0 recorded findings
  Unknown effects/outcomes remain.
```

## Colored PTY — raw escaped capture

JSON string encoding preserves ANSI and CRLF; escape sequences are shown, not executed.

```text
"\u001b[1;36mRole Orchestrator · compact · 125e55be\u001b[0m\r\n\u001b[1;36m\r\n● Controller #1 · primary\r\n  Invocation dispatched · selector=fixture · native effort\u001b[0m\r\n\u001b[2;3m\r\n  Thinking · Controller #1 · primary\r\n\u001b[0m\u001b[2;3m  Inspect\u001b[0m\u001b[2;3m the commit.\r\n  Read the diff.\u001b[0m\r\n\u001b[36m  ◇ git show HEAD · in_progress\u001b[0m\r\n\u001b[32m  ✓ git show HEAD · completed\u001b[0m\r\n\u001b[36m  ◇ Read package.json · in_progress\u001b[0m\r\n\u001b[1;31m  ✗ Read package.json · failed\u001b[0m\r\n\u001b[2;3m\r\n  Thinking · Controller #1 · primary\r\n\u001b[0m\u001b[2;3m  Version only.\u001b[0m\r\n  ◇ Outcome reported · completed · effect=unknown\r\n\r\n◇ Assessment recorded · complete\r\nVersion updated.\r\n\u001b[32m\r\n✓ Operation complete\r\n  1 Controller attempt · 0 Worker attempts · 0 recorded findings\r\n  Unknown effects/outcomes remain.\u001b[0m\r\n"
```

## Three-round medians (ms, UTF-8 bytes)

| Mode | First | Total | Bytes | Lines |
|---|---:|---:|---:|---:|
| baseline | 162.96 | 392.96 | 970 | 14 |
| compact | 161.05 | 392.65 | 625 | 22 |
| detailed | 159.79 | 387.44 | 948 | 26 |
| debug | 157.75 | 389.22 | 2417 | 40 |

| Mode | First | Total | Presentation bytes | History median | History updates | History bytes |
|---|---:|---:|---:|---:|---:|---:|
| baseline-cli-headless | 223.83 | 229.13 | 0 | — | — | — |
| current-cli-headless | 212.43 | 217.44 | 0 | — | — | — |
| baseline-cli-compact | 175.22 | 226.76 | 949 | — | — | — |
| current-cli-compact | 162.53 | 222.91 | 757 | — | — | — |
| current-cli-detailed | 159.48 | 218.4 | 1443 | — | — | — |
| current-cli-debug | 158.47 | 216.91 | 4412 | — | — | — |
| baseline-acp-inline | 8.25 | 466.61 | 12513 | 6.58 | 108 | 56268 |
| baseline-acp-notices | 8.11 | 472.56 | 11045 | 4.89 | 18 | 1575 |
| current-acp-inline | 8.07 | 472.04 | 12513 | 7.5 | 108 | 56268 |
| current-acp-notices | 8.07 | 464.62 | 11045 | 5.05 | 18 | 1575 |

Small deterministic fixture; no native model performance or quality inference. Compact bytes fell from 970 to 625 while blank lines/structure increase line count 14→22. Inline history 6.58→7.50 ms, unchanged 108 updates/56,268 bytes; notices 4.89→5.05 ms, unchanged 18/1,575. Exact full Operation/Invocation/diagnostic equivalence in deterministic presentation modes retained in CI.

---
refs:
  id: fr:02-orchestration-api
  kind: fr
  title: "Orchestration API"
  spec: ai-workflow-engine
  related:
    - fr:01-workflow-model
    - fr:03-cli-adapters
    - fr:05-permission-escalation
  modules:
    - src/runtime/orchestration.ts
    - src/runtime/limiter.ts
    - src/runtime/budget.ts
---

# FR 02: Orchestration API

> The body globals a workflow receives: `agent()` spawns one fresh-context CLI agent; `parallel()` and `pipeline()` fan work out under a shared concurrency cap; `phase()`/`log()` narrate progress; `budget` tracks token spend; `args` carries the CLI input.

## Purpose

Workflow authors need deterministic primitives for fan-out and sequencing that never consume model tokens themselves. This API is the engine's mirror of the Claude Code Workflow tool surface, so scripts written for one run on the other.

## User-visible Behavior

- `agent(prompt, opts?) → Promise<result>` — spawns one CLI agent (default `claude`; `opts.cli` selects another adapter). `result` carries `text`, `data` (when `opts.schema` was given), `raw`, `usage {inputTokens, outputTokens}`, and `sessionId` when the adapter reports one. Options: `cli`, `model`, `schema`, `instructions` (system prompt), `tools`, `cwd`, `label`, `phase`, `escalation` (FR 05).
- `parallel(thunks) → Promise<Array<T | null>>` — runs thunks concurrently and acts as a barrier. A thunk that throws resolves to `null` in the result array (the failure is logged); the call itself never rejects.
- `pipeline(items, ...stages) → Promise<Array<unknown | null>>` — runs each item through all stages independently with **no barrier between stages**. Each stage receives `(prev, originalItem, index)`. A stage that throws drops that item to `null` and skips its remaining stages.
- `phase(title)` — labels subsequent `log()` lines with the phase title and emits a `=== title ===` marker.
- `log(message)` — emits a narrator line through the run's log sink (the CLI prefixes `[wf] ` on stderr).
- `budget` — `{ total, spent(), remaining() }`. With no `--budget`, `total` is `null` and `remaining()` is `Infinity`. `remaining()` clamps at zero.
- `args` — the parsed `--args` JSON, verbatim; `undefined` when not provided.

Failure cases:

- `agent()` with an unknown `cli` id throws `unknown cli adapter: <id>`.
- When a budget is set and exhausted, the next `agent()` call throws `budget exhausted`. The check happens before the call, so an in-flight call may overshoot the target; the target is a pre-call gate, not a mid-call abort.

## Capabilities

- Shared concurrency cap across all `agent()` calls (default 8, configurable per run); `parallel`/`pipeline` launch eagerly and rely on that cap, so passing many items is safe.
- Token accounting: each agent result's `inputTokens + outputTokens` is added to the budget.
- Per-call adapter selection lets one workflow mix CLIs (e.g. claude and codex legs side by side).
- Per-call escalation policy overrides (`escalation: { timeoutMs, onTimeout, disabled }`, see FR 05).

## Boundaries

- No `workflow()` nesting — running another workflow as a sub-step is not implemented.
- No retry logic: a failed thunk/stage is reported as `null`, and retrying is the script's responsibility.
- Schema-validated output is available only where the adapter supports it (FR 03); there is no engine-side prompt-instructed JSON fallback yet.
- Budget figures come from each adapter's usage envelope; cross-CLI token accounting is additive with no normalization.

## Traceability

- **Spec**: `docs/superpowers/specs/2026-06-10-ai-workflow-engine-design.md` § 3 (Core API)
- **Related FR**: 01-workflow-model.md, 03-cli-adapters.md, 05-permission-escalation.md

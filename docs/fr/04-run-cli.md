---
refs:
  id: fr:04-run-cli
  kind: fr
  title: "Run CLI"
  spec: ai-workflow-engine
  related:
    - fr:01-workflow-model
    - fr:05-permission-escalation
  modules:
    - src/cli.ts
---

# FR 04: Run CLI

> `ai-workflow-engine run <workflow-file>` executes one workflow headlessly: result JSON on stdout, `[wf]` narration on stderr, exit code says what happened.

## Purpose

The engine is externally triggerable: cron jobs, hooks, or other agents start a run with one command and consume its result from stdout. The CLI is the only entry point; there is no daemon.

## User-visible Behavior

```
ai-workflow-engine run <workflow-file> [--args <json>] [--budget <n>] [--escalate agentbus:<to>]
```

- `--args <json>` — parsed JSON exposed to the workflow body as `args`.
- `--budget <n>` — token target for the run; exhaustion makes the next `agent()` call throw (FR 02).
- `--escalate agentbus:<to>` — opt the run into permission escalation toward bus address `<to>` (FR 05).

Streams and exit codes:

- Normal case: the workflow's return value is printed to stdout as pretty-printed JSON; progress lines go to stderr prefixed `[wf] `; exit 0.
- Usage errors (missing subcommand/file, non-numeric `--budget`, invalid `--args` JSON, malformed `--escalate` value) print an `error:`/`usage:` line on stderr and exit 2 without running anything.
- Runtime errors (load failure, workflow throw, adapter failure) print `error: <message>` and exit 1.

## Capabilities

- Registers the built-in adapters per run: `claude` (default) and `codex` (with `danger-full-access` sandbox; see FR 03).
- Generates a short random run id for escalation-enabled runs (used as the engine's bus identity, FR 05).
- Resolves the workflow path against the invoking cwd, so relative paths work from anywhere.

## Boundaries

- `run` is the only subcommand; there is no `list`, `validate`, or daemon mode.
- Concurrency is not CLI-configurable (fixed at the runner default of 8); set it via the programmatic `runWorkflow` API if embedding.
- The only escalation channel accepted is `agentbus:`; other channel ids are rejected at parse time.

## Traceability

- **Spec**: `docs/superpowers/specs/2026-06-10-ai-workflow-engine-design.md` § 1 (Motivation), § 5 (Run modes)
- **Spec**: `docs/superpowers/specs/2026-06-10-permission-escalation-design.md` § 3.5 (API surface)
- **Related FR**: 01-workflow-model.md, 05-permission-escalation.md

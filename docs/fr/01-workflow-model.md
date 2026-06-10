---
refs:
  id: fr:01-workflow-model
  kind: fr
  title: "Workflow Model"
  spec: ai-workflow-engine
  related:
    - fr:02-orchestration-api
    - fr:04-run-cli
  modules:
    - src/runtime/runner.ts
    - src/types.ts
---

# FR 01: Workflow Model

> A workflow is a plain JS/TS module — a pure `meta` literal plus a default async function — whose loops, conditionals, and fan-out are deterministic JavaScript; the model only does leaf work inside `agent()` calls, each in its own fresh context.

## Purpose

Run AI agent orchestrations ("armies") headlessly on one machine without a framework or daemon. All control flow lives in operator-authored JavaScript so orchestration spends zero model tokens and behaves the same each run (aside from agent nondeterminism). The format deliberately mirrors Claude Code's Workflow tool so scripts stay portable and Claude-authorable.

## User-visible Behavior

A workflow file exports two things:

```js
export const meta = {
  name: 'my-workflow',          // required, non-empty string
  description: 'what it does',  // required, non-empty string
  whenToUse: '...',             // optional
  phases: [{ title: 'Scan' }],  // optional
};

export default async function (wf) {
  // wf provides agent / parallel / pipeline / phase / log / budget / args
  return await wf.agent('do the leaf work');
}
```

- Normal case: the engine imports the file, validates `meta`, runs the default function with the injected orchestration API, and prints the returned value as JSON.
- Failure case: a missing default export, or a `meta` without non-empty `name` and `description`, fails loading with a descriptive error before any agent is spawned.
- A thrown error inside the body propagates out as a run failure (exit code 1 from the CLI).

## Capabilities

- Loads a workflow module from any local path (resolved against the engine's cwd, imported via file URL).
- Validates the `meta` contract before execution: `name` and `description` are required non-empty strings.
- Executes the body with a fully injected API — workflows import nothing from the engine.
- Mirrors the Claude Code Workflow tool script shape (meta literal + body using the same globals), keeping scripts portable in both directions.

## Boundaries

- No determinism sandbox: `Date.now()` / `Math.random()` are not blocked (unlike the Claude Code Workflow tool). Trusted, self-authored scripts are assumed.
- No orchestration journal or resume; a run is fire-and-forget.
- No daemon and no cross-run durability; fleets are per-trigger and ephemeral.
- The orchestration primitives themselves are FR 02; how the engine is invoked is FR 04.

## Traceability

- **Spec**: `docs/superpowers/specs/2026-06-10-ai-workflow-engine-design.md` § 2 (Model), § 3 (Core API), § 7 (Out of scope)
- **Related FR**: 02-orchestration-api.md, 04-run-cli.md

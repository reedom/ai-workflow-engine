# Functional Requirements (FR)

`docs/fr/` collects the **Functional Requirements documents** for ai-workflow-engine.

## Position in the documentation stack

The **per-feature narrative** layer:

| Layer | Location | Axis | Primary readers |
|---|---|---|---|
| **FR (this directory)** | `docs/fr/<NN>-<feature>.md` | **Per-feature (Feature) narrative** | Operators, new contributors, spec authors |
| **Specs** | [`docs/superpowers/specs/`](../superpowers/specs/) | Design decisions and rationale per work stream | Implementers |
| **Plans** | [`docs/superpowers/plans/`](../superpowers/plans/) | Task-level implementation plans | Implementers |

FR is designed so that **someone who wants to understand a feature can read just one file** and be done.
FR boundaries do not match spec boundaries: a single spec may span several FR pages, and one FR page may draw from several specs.

## Layout

```
docs/fr/
├── README.md             (this file)
├── _template.md          (skeleton for one file)
├── index.md              (generated; regenerate with `kusara index`)
└── NN-<feature>.md ...   (one file per feature, flat layout)
```

| File | Topic |
|---|---|
| [01-workflow-model.md](01-workflow-model.md) | Workflow file format, `meta` literal, deterministic JS orchestration model |
| [02-orchestration-api.md](02-orchestration-api.md) | Body globals: `agent` / `parallel` / `pipeline` / `phase` / `log` / `budget` / `args` |
| [03-cli-adapters.md](03-cli-adapters.md) | Adapter seam; claude and codex adapters, capability flags |
| [04-run-cli.md](04-run-cli.md) | `ai-workflow-engine run` invocation, flags, output, exit codes |
| [05-permission-escalation.md](05-permission-escalation.md) | Escalating uncovered tool calls to a human over agentbus |

## What to write / what not to write

Decision rule: **FR fixes the contracts where a workflow author or operator becomes a "reader" or "writer"**.
Internal type definitions, wire-format details, and library choices belong to the spec/design layer.

### Write

- **Purpose**: Why this feature is needed
- **User-visible Behavior**: How the feature appears from the workflow-author / operator perspective
- **Capabilities**: The main behaviors the feature provides (bullet list in prose)
- **Boundaries**: What it does NOT do, and the boundary against neighboring features
- **Traceability**: References to the specs under `docs/superpowers/specs/`

### Do not write

- Internal type definitions, wire-level serialization details, chosen libraries (→ spec)
- Implementation task breakdowns (→ plan)

## Update flow

When adding a new feature:

1. Brainstorm/spec the feature under `docs/superpowers/specs/` (existing workflow).
2. After implementation, write or update `docs/fr/NN-<feature>.md`.
3. Regenerate the index: `kusara index`, then `kusara validate`.

When changing an existing feature, update the **Capabilities** / **Boundaries** / **Traceability** of the corresponding FR page.

## Language

FR is written in **English**.

## Traceability conventions

- References to a spec use its path plus a section title, e.g. `docs/superpowers/specs/2026-06-10-permission-escalation-design.md § 5`.

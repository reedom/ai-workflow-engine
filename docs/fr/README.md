# Functional Requirements (FR)

`docs/fr/` collects the **Functional Requirements documents** for ai-workflow-engine.

## Position in the documentation stack

The **per-feature narrative** layer:

| Layer | Location | Axis | Primary readers |
|---|---|---|---|
| **FR (this directory)** | `docs/fr/<NN>-<feature>.html` | **Per-feature (Feature) narrative** | Operators, new contributors, spec authors |

FR is designed so that **someone who wants to understand a feature can read just one file** and be done.

## Layout

```
docs/fr/
├── README.md             (this file)
├── _template.md          (skeleton for one file)
├── index.md              (generated; regenerate with `kusara index`)
└── NN-<feature>.html ... (one file per feature, flat layout)
```

| File | Topic |
|---|---|
| [01-workflow-model.html](01-workflow-model.html) | Workflow file format, `meta` literal, deterministic JS orchestration model |
| [02-orchestration-api.html](02-orchestration-api.html) | Body globals: `agent` / `parallel` / `pipeline` / `phase` / `log` / `budget` / `args` |
| [03-cli-adapters.html](03-cli-adapters.html) | Adapter seam; claude and codex adapters, capability flags |
| [04-run-cli.html](04-run-cli.html) | `ai-workflow-engine run` invocation, flags, output, exit codes |
| [05-permission-escalation.html](05-permission-escalation.html) | Escalating uncovered tool calls to a human over agentbus |

## What to write / what not to write

Decision rule: **FR fixes the contracts where a workflow author or operator becomes a "reader" or "writer"**.
Internal type definitions, wire-format details, and library choices are out of scope.

### Write

- **Purpose**: Why this feature is needed
- **User-visible Behavior**: How the feature appears from the workflow-author / operator perspective
- **Capabilities**: The main behaviors the feature provides (bullet list in prose)
- **Boundaries**: What it does NOT do, and the boundary against neighboring features
- **Traceability**: References to related FR pages

### Diagrams

FR pages are HTML, so diagrams are welcome where they clarify a flow, state machine, or boundary: hand-drawn inline SVG inside `<figure>` with a `<figcaption>`, no external JS (no Mermaid CDN) and no image files — pages stay self-contained and offline-readable.

### Do not write

- Internal type definitions, wire-level serialization details, chosen libraries
- Implementation task breakdowns

## Update flow

When adding a new feature:

1. After implementation, draft `docs/fr/NN-<feature>.md` from `_template.md`, then convert it to `docs/fr/NN-<feature>.html` (FR pages are stored as HTML; the `refs:` metadata moves into a `<script type="application/kusara+yaml">` block).
2. Regenerate the index: `kusara index`, then `kusara validate`.

When changing an existing feature, update the **Capabilities** / **Boundaries** / **Traceability** of the corresponding FR page.

## Language

FR is written in **English**.

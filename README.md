# ai-workflow-engine

A standalone runtime for **deterministic, JavaScript-orchestrated agent
workflows**. The loops, conditionals, and fan-out are plain JavaScript; the model
only does the leaf work inside `agent()` calls, each in its own fresh context.
`agent()` spawns a local agent CLI — `claude` (default), `codex`, `antigravity`,
... — selected per call, so one workflow can mix CLIs.

- Same-machine, headless, externally triggerable. No framework dependency, no daemon.
- Mirrors Claude Code's Workflow tool API, so scripts stay portable and
  Claude-authorable.
- Optional `--cmux` mode runs each agent in a cmux surface for human observability (roadmap).

Status: **MVP implemented** (claude adapter + core orchestration + CLI). `--cmux`,
the codex/antigravity adapters, and the durable-agent escape hatch are roadmap, not
yet built. See
[`docs/superpowers/specs/2026-06-10-ai-workflow-engine-design.md`](docs/superpowers/specs/2026-06-10-ai-workflow-engine-design.md)
and [`docs/superpowers/plans/2026-06-10-ai-workflow-engine-mvp.md`](docs/superpowers/plans/2026-06-10-ai-workflow-engine-mvp.md).

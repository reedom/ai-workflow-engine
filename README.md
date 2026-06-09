# ai-workflow-engine

A standalone runtime for **deterministic, JavaScript-orchestrated agent
workflows**. The loops, conditionals, and fan-out are plain JavaScript; the model
only does the leaf work inside `agent()` calls, each in its own fresh context.
`agent()` spawns a local agent CLI — `claude` (default), `codex`, `antigravity`,
... — selected per call, so one workflow can mix CLIs.

- Same-machine, headless, externally triggerable. No framework dependency, no daemon.
- Mirrors Claude Code's Workflow tool API, so scripts stay portable and
  Claude-authorable.
- Optional `--cmux` mode runs each agent in a cmux surface for human observability.

Status: **design phase.** See
[`docs/superpowers/specs/2026-06-10-ai-workflow-engine-design.md`](docs/superpowers/specs/2026-06-10-ai-workflow-engine-design.md).

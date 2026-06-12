# ai-workflow-engine

A standalone runtime for **deterministic, JavaScript-orchestrated agent
workflows**. The loops, conditionals, and fan-out are plain JavaScript; the model
only does the leaf work inside `agent()` calls, each in its own fresh context.
`agent()` spawns a local agent CLI — `claude` (default), `codex`, `antigravity`,
... — selected per call, so one workflow can mix CLIs.

- Same-machine, headless, externally triggerable. No framework dependency, no daemon.
- Embeddable as a library: import `runWorkflow`, `loadWorkflow`, the
  claude/codex adapter factories, and the escalation types from the package
  root to run workflows from a host process without the CLI. `RunOptions.cwd`
  sets the working directory for a whole run (agent spawns and `.claude`
  defer-rule loading); `escalation.trustCwdSettings: false` skips an
  unreviewed checkout's settings.
- Mirrors Claude Code's Workflow tool API, so scripts stay portable and
  Claude-authorable.
- Optional `--cmux` mode runs each agent in a cmux surface for human observability (roadmap).
- Optional `--escalate agentbus:<to>` routes permission requests from
  headless agents to a human over agentbus with a full approve/deny
  round-trip (Claude agents; Codex support is roadmap). See
  [`docs/fr/05-permission-escalation.html`](docs/fr/05-permission-escalation.html).

Status: **MVP implemented** (claude + codex adapters, core orchestration, CLI, embeddable library API; escalation implemented for claude + agentbus).
`--cmux`, the antigravity adapter, and the durable-agent escape hatch are roadmap,
not yet built. See the functional requirements under
[`docs/fr/`](docs/fr/).

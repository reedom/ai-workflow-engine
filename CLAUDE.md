# ai-workflow-engine

A standalone runtime for deterministic, JavaScript-orchestrated agent workflows.
Workflow control flow is plain JavaScript; the model only does the leaf work
inside `agent()` calls, each spawning a local agent CLI (claude, codex) in a
fresh context.

## Commands

- `pnpm build` -- compile TypeScript (tsc)
- `pnpm test` -- run tests (vitest)

## Layout

- `src/cli.ts` -- `ai-workflow-engine run` entry point
- `src/index.ts` -- public library surface for embedders (package root exports)
- `src/runtime/` -- orchestration globals (`agent`/`parallel`/`pipeline`), runner, budget, concurrency limiter
- `src/adapters/` -- per-CLI adapters (claude, codex)
- `src/escalation/` -- permission escalation broker (agentbus)
- `examples/` -- sample workflow scripts
- `docs/fr/` -- functional requirements (see below)

## Documentation

Functional requirements live in [docs/fr/](docs/fr/README.md), one
self-contained HTML page per feature:

- [01-workflow-model.html](docs/fr/01-workflow-model.html) -- workflow file format, `meta` literal, deterministic JS orchestration model
- [02-orchestration-api.html](docs/fr/02-orchestration-api.html) -- body globals: `agent` / `parallel` / `pipeline` / `phase` / `log` / `budget` / `args`
- [03-cli-adapters.html](docs/fr/03-cli-adapters.html) -- adapter seam; claude and codex adapters, capability flags
- [04-run-cli.html](docs/fr/04-run-cli.html) -- `ai-workflow-engine run` invocation, flags, output, exit codes
- [05-permission-escalation.html](docs/fr/05-permission-escalation.html) -- escalating uncovered tool calls to a human over agentbus

When changing user-visible behavior, update the corresponding FR page
(Capabilities / Boundaries / Traceability sections), then run
`kusara index` and `kusara validate`. Docs carry kusara `refs:` metadata;
the kinds manifest is `docs/kinds.md`.

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. When in doubt, invoke the skill.

Key routing rules:
- Product ideas/brainstorming → invoke /office-hours
- Strategy/scope → invoke /plan-ceo-review
- Architecture → invoke /plan-eng-review
- Design system/plan review → invoke /design-consultation or /plan-design-review
- Full review pipeline → invoke /autoplan
- Bugs/errors → invoke /investigate
- QA/testing site behavior → invoke /qa or /qa-only
- Code review/diff check → invoke /review
- Visual polish → invoke /design-review
- Ship/deploy/PR → invoke /ship or /land-and-deploy
- Save progress → invoke /context-save
- Resume context → invoke /context-restore
- Author a backlog-ready spec/issue → invoke /spec

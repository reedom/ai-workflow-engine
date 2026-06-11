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

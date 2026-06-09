# Design: ai-workflow-engine

Status: **draft for review** (2026-06-10)

A standalone runtime that runs **deterministic, JavaScript-orchestrated agent
workflows** by spawning local agent CLIs (claude, codex, antigravity, ...) in
fresh contexts. Same-machine, headless, externally triggerable. No framework
dependency, no daemon.

## 1. Motivation

Run AI agent orchestrations ("armies") that can be triggered headlessly. The
substrate is **local agent CLIs** — primarily `claude`, but also `codex`,
`antigravity`, etc. Everything runs on one machine.

### Decisions reached (and what they rule out)
- **Deterministic JS orchestration**, modeled on Claude Code's (unreleased)
  Workflow tool: the loops/conditionals/fan-out are plain JavaScript; the model
  only does leaf work inside `agent()` calls, each in its own fresh context.
- **Drop Flue.** Its value is runtime portability + sandboxes + its own harness;
  none apply to a same-machine, CLI-native target, and it's explicitly
  experimental.
- **No daemon.** Fleets are per-trigger/ephemeral; no cross-run durability is
  needed, so a long-lived process buys nothing.
- **agentbus demoted.** The stateless model passes data through JavaScript, not a
  bus. agentbus survives only behind the optional durable-agent escape hatch
  (genuine inter-agent messaging).
- **Mirror the Workflow tool's script API deliberately**, so Claude can author
  workflows with the existing `claude-code-workflow-creator` skill and scripts
  stay portable to/from Anthropic's native tool when it ships.

## 2. Model

A workflow is a JS/TS file: a `meta` literal followed by a body with injected
orchestration globals. Leaf `agent()` calls spawn fresh-context CLI agents; JS
owns all control flow; orchestration spends zero model tokens and (aside from
agent nondeterminism) behaves the same each run.

## 3. Core API (mirrors the Workflow tool)

- `meta` — pure literal: `{ name, description, whenToUse?, phases? }`.
- Body globals: `agent()`, `parallel()`, `pipeline()`, `phase()`, `log()`,
  `budget`, `args`, `workflow()` (nesting).
- `agent(prompt, opts) => result` — `result` is text, or a schema-validated
  object when `opts.schema` is given.
- `parallel(thunks)` / `pipeline(items, ...stages)` with a concurrency cap;
  `budget` reads token usage from each adapter's result envelope.

Mirroring is a hard requirement, not a convenience: it is what keeps scripts
portable and Claude-authorable.

## 4. CLI adapter layer (the multi-CLI seam)

The orchestration core is **agent-CLI-agnostic**. Each CLI gets a thin adapter:

```
interface CliAdapter {
  readonly id: string;                      // 'claude' | 'codex' | 'antigravity'
  readonly caps: { schema: boolean; resume: boolean; tools: boolean };
  run(spec: AgentSpec): Promise<AgentResult>;       // headless one-shot
  resume?(sessionId: string, spec: AgentSpec): Promise<AgentResult>;  // escape hatch
}

interface AgentSpec {
  prompt: string;
  model?: string;
  schema?: unknown;          // JSON Schema
  instructions?: string;     // system prompt
  tools?: string[];
  cwd?: string;
}
interface AgentResult { text: string; raw: unknown; usage?: unknown; sessionId?: string }
```

- **claude** (default): `claude -p --output-format json [--json-schema <s>]
  [--model <m>] [--append-system-prompt <i>] [--allowedTools ...]
  [--settings <f>]`, spawned in `cwd`. Native structured output via
  `--json-schema`; native multi-turn via `-p --resume <sessionId>`.
- **codex**: `codex exec ...` (non-interactive). Flag/output mapping TBD.
- **antigravity** / others: own adapters, added as needed.

`agent(prompt, { cli?, model?, schema?, instructions?, tools?, cwd? })` selects
the adapter per call (default `claude`), so a single workflow can **mix** CLIs.
Where an adapter lacks `caps.schema`, the runtime falls back to prompt-instructed
JSON + client-side validation with a bounded retry.

## 5. Run modes

- **default (headless)** — each `agent()` is a child process; capture its
  stdout/JSON result.
- **`--cmux`** — each agent's CLI process runs inside a cmux surface for human
  observability instead of a bare child process; the result is captured via a
  hook / screen read-back. cmux is a *skin*, orthogonal to the adapter axis.

So there are two pluggable axes over one orchestration model: **which CLI**
(adapter) and **cmux skin or not**.

## 6. Durable-agent escape hatch (secondary)

Alongside stateless `agent()`, a `durableAgent(name, spec) => handle` exposing
`ask` / `tell` for the occasional long-lived, multi-turn agent. Implemented via:
- native session **resume** for multi-turn (`claude -p --resume`, per-adapter), and
- **agentbus** only when agents must message each other.
Per-run lifetime; used sparingly.

## 7. Out of scope (initially — YAGNI)

- The determinism sandbox and orchestration journal/resume. Justified for
  trusted, self-authored, same-machine use; add later if running
  untrusted/Claude-authored scripts or long jobs that must resume.
- Cross-run durability / persistent daemon.
- Flue and any framework dependency.

## 8. Stack & reuse

- **TypeScript / Node.** Shells out to the agent CLIs; mirrors the JS workflow
  format.
- Reuse: the `agentbus` CLI (durable/inter-agent case); cmux know-how ported
  from `cmux-bellhop` (see its
  `docs/superpowers/specs/2026-06-09-cmux-backend-internals-backlog.md`:
  rename-workspace, group anchor, default-pane, cwd/TTY quirks); TS scaffolding
  ideas from `flue-bellhop`.

## 9. Open questions for the plan

- Exact `codex` / `antigravity` headless interfaces (flags, output, resume) —
  verify each before writing its adapter.
- Result-capture mechanism in `--cmux` mode (hook that writes the JSON result vs.
  screen read-back).
- Concurrency-cap default and budget accounting across heterogeneous CLIs.

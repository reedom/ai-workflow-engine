---
refs:
  id: fr:03-cli-adapters
  kind: fr
  title: "CLI Adapter Layer"
  spec: ai-workflow-engine
  related:
    - fr:02-orchestration-api
    - fr:05-permission-escalation
  modules:
    - src/adapters/
---

# FR 03: CLI Adapter Layer

> The orchestration core is agent-CLI-agnostic; each local agent CLI gets a thin adapter that maps one `agent()` call to one headless child process and parses the result back into a common envelope.

## Purpose

The engine's substrate is local agent CLIs (`claude`, `codex`, others later). Keeping each CLI behind a small adapter lets one workflow mix CLIs per call and keeps the core free of CLI-specific knowledge.

## User-visible Behavior

An adapter exposes `id`, capability flags `caps { schema, resume, tools }`, and `run(spec)`. The capability flags tell authors what an `agent()` call can use on that adapter.

| Adapter | Invocation | schema | tools | Notes |
|---|---|---|---|---|
| `claude` (default) | `claude -p <prompt> --output-format json [--json-schema <s>] [--model <m>] [--append-system-prompt <i>] [--allowedTools ...] [--settings <f>]` | yes | yes | stdin is ignored (avoids the `-p` stdin wait); `--settings` is injected only for escalation (FR 05) |
| `codex` | `codex exec <prompt> --json --skip-git-repo-check --ephemeral --sandbox <mode> [--model <m>]` | no | no | `instructions` are folded into the prompt (no separate system-prompt flag); sandbox mode is adapter configuration |

- Normal case: the child exits 0 and the adapter returns `{ text, data?, raw, usage, sessionId? }`. For claude, `data` is the structured output when a schema was requested; for codex, `text` is the final agent message from the JSONL event stream.
- Failure case: non-zero exit throws `<cli> exited <code>: <stderr excerpt>`. A claude `is_error` envelope or a codex `turn.failed` event throws with the reported detail. Empty stdout throws.
- Requesting `schema` on the codex adapter throws immediately (`codex adapter does not support schema output yet`) before spawning anything.

## Capabilities

- One fresh child process per `agent()` call, spawned in the call's `cwd`.
- Common result envelope across CLIs, including token usage parsed from each CLI's native format (claude `usage`, codex `turn.completed` usage).
- Codex JSONL parsing tolerates interleaved plain-text notices between events.
- Codex sandbox level is configurable when constructing the adapter (`read-only` / `workspace-write` / `danger-full-access`); the bundled CLI registers codex with `danger-full-access` to match the trust level the claude adapter grants via unrestricted Bash.
- Injectable spawn function for testing (adapters are unit-tested without real CLIs).

## Boundaries

- No `antigravity` (or other) adapters yet; the seam is `CliAdapter`, added as needed.
- `caps.resume` is informational: native session resume (`claude -p --resume <sessionId>`) is not wired into the API yet.
- No engine-side schema fallback for adapters without `caps.schema` — the design's prompt-instructed JSON + client-side validation fallback is not implemented; the codex adapter rejects schema requests instead.
- The `--cmux` observability skin from the design is roadmap, not built.
- Codex agents do not participate in permission escalation (FR 05); they keep sandbox-or-fail behavior.

## Traceability

- **Spec**: `docs/superpowers/specs/2026-06-10-ai-workflow-engine-design.md` § 4 (CLI adapter layer), § 5 (Run modes)
- **Related FR**: 02-orchestration-api.md, 05-permission-escalation.md

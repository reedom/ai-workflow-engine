# Design: permission escalation via external channels

Status: **approved** (2026-06-10)

When a managed agent is about to ask for permission, route the question to the
human over an external channel (agentbus first, Slack later) with a full
approve/deny round-trip, so headless workflow runs can escalate instead of
silently denying or failing.

## 1. Motivation

Today both adapters are strictly one-shot headless: `claude -p` with stdin
ignored, `codex exec --sandbox`. Neither can surface a permission prompt; a
blocked action fails or is silently sandboxed. This feature adds an escalation
path out of headless agents: the human approves or denies from anywhere on the
bus (or, later, from Slack), and the agent continues accordingly.

### Decisions reached

- **Full round-trip**, not notify-only: the external reply carries the
  allow/deny decision back to the agent.
- **Two-seam abstraction** (chosen over "agentbus as the universal bus" and
  over ad-hoc per-service wiring):
  - *Agent seam* — each CLI adapter normalizes its native escalation dialect
    into one engine-level request/decision protocol.
  - *Channel seam* — services implement one `ApprovalChannel` interface; the
    middle (routing, timeout policy, logging) is service- and CLI-agnostic.
  - The bus topology is not foreclosed: configuring only the agentbus
    connector plus an external bridge process reproduces it without engine
    changes.
- **Claude first, Codex later.** V1 delivers the round-trip for Claude agents
  only; the broker exposes the seam (`decide()`) the future Codex app-server
  adapter plugs into. Codex agents keep current sandbox-or-fail behavior.
- **Opt-in per run.** Escalation is off unless the run configures a channel
  (`--escalate ...`). When on, it applies to all `agent()` calls; per-call
  opts can override.
- **Per-call timeout policy.** Default: deny after a 5-minute timeout; a call
  can opt into `onTimeout: 'wait'`.

## 2. Protocol (service-agnostic core)

New module `src/escalation/`. `types.ts` defines:

```ts
interface PermissionRequest {
  runId: string;
  agentLabel: string;
  cli: string;               // 'claude' | 'codex' | ...
  toolName: string;
  toolInput: unknown;
  cwd?: string;
}

interface PermissionDecision {
  behavior: 'allow' | 'deny';
  reason?: string;
}

interface EscalationPolicy {
  timeoutMs: number;          // default 300_000
  onTimeout: 'deny' | 'wait'; // default 'deny'
}

interface ApprovalChannel {
  readonly id: string;        // 'agentbus' | 'slack' | ...
  request(req: PermissionRequest): Promise<PermissionDecision>;
}
```

## 3. Components

### 3.1 EscalationBroker (`src/escalation/broker.ts`)

One per run, created by the runner when escalation is configured.

- Owns a unix socket in the run's temp dir; accepts JSON `PermissionRequest`s
  from hook helpers and replies with `PermissionDecision`s.
- Routes each request through the configured `ApprovalChannel`, racing it
  against the effective `EscalationPolicy` timer.
- Logs every request and decision through the run's `log()` so the transcript
  shows all escalations.
- Exposes `decide(req): Promise<PermissionDecision>` directly for in-process
  callers — this is the Codex seam: the future app-server adapter calls
  `decide()` from its JSON-RPC `execCommandApproval`/`applyPatchApproval`
  handlers, no socket needed.
- Shutdown (in a `finally`, even when the workflow throws): denies in-flight
  requests, closes the socket, unregisters from the channel.

### 3.2 agentbus connector (`src/escalation/channels/agentbus.ts`)

V1's only connector.

- On broker start: `agentbus register awe-<runId>` (non-persistent).
- `request()`: `agentbus ask <to>` with the request payload as JSON; parses
  the reply into a `PermissionDecision`. `<to>` (the human's bus address)
  comes from run config.
- The human replies from anywhere on the bus:
  `agentbus reply awe-<runId> ... '{"behavior":"allow"}'`.
- A Slack connector later is a second file implementing `ApprovalChannel`.

### 3.3 Hook helper (CLI subcommand)

`ai-workflow-engine escalate-hook --socket <path> --agent <label>`

- Reads the Claude Code hook stdin JSON, forwards a `PermissionRequest` over
  the socket, blocks for the decision, prints the `PermissionRequest` hook
  output JSON (`hookSpecificOutput.decision`).
- On any failure: prints nothing, exits non-zero — Claude Code falls back to
  its normal headless deny. Escalation failure can never make a run more
  permissive than today.

### 3.4 Claude adapter change (`src/adapters/claude.ts`)

When `spec.escalation` is present:

- Write a temp `--settings` JSON file containing a `PermissionRequest` hook
  whose command invokes the hook helper with the broker's socket path and the
  agent label.
- Add `--settings <file>` to the spawn args. No other change to the one-shot
  spawn model. The temp file is removed after the process exits.

### 3.5 API surface

- Run level: `--escalate <channel>[:<target>]` CLI flag (e.g.
  `--escalate agentbus:tohru`) plus the equivalent in engine config.
- Per call: `agent(prompt, { escalation: { timeoutMs?, onTimeout?,
  disabled? } })`. `disabled: true` opts a call out of an escalation-enabled
  run.
- `AgentSpec` grows `escalation?: { broker: EscalationBroker }`, set by the
  runner; adapters that lack escalation support ignore it (codex, for now).

## 4. Data flow (happy path)

1. Run starts with `--escalate agentbus:tohru`; runner creates the broker
   (socket up, bus registration done).
2. `agent()` spawns `claude -p` with the injected settings file.
3. Claude hits a permission boundary; the `PermissionRequest` hook fires the
   helper.
4. Helper forwards the request over the socket; broker calls the agentbus
   connector; `agentbus ask tohru` delivers
   `{agentLabel, toolName, toolInput, cwd}`.
5. The human replies `agentbus reply ... '{"behavior":"allow"}'` from any
   shell or agent on the bus.
6. Decision flows back through the socket; helper prints the hook output;
   Claude proceeds. Broker logs request and decision.

## 5. Error handling

Rule: **failure is never more permissive than today.**

- Timeout with `onTimeout: 'deny'` (default): broker returns deny with reason
  `escalation timeout`; a late reply is never fetched. With
  `onTimeout: 'wait'` the broker holds until reply or agent-process exit.
- Channel failure (agentbus binary missing, ask fails): treated exactly like
  a timeout — policy applies, error logged.
- Helper/socket failure: helper exits non-zero with no output; Claude Code's
  native headless deny applies.
- Run end: in-flight requests denied at shutdown; socket closed; bus
  registration removed.

## 6. Testing

- Unit: broker with a fake `ApprovalChannel` (decision, timeout,
  channel-throw, shutdown-denies-inflight); claude adapter
  arg/settings-file building via the existing `spawnFn` fake; helper against
  a stub socket server.
- Integration: agentbus connector against the real `agentbus` binary in a
  temp `--dir`, with a scripted `agentbus reply` answering the ask.
- E2E: an `examples/` workflow that needs an unallowed tool, run manually
  with the human replying on the bus; doubles as living documentation.

## 7. Verification items for the plan phase

- Confirm the exact `PermissionRequest` hook output schema and that the hook
  fires in `claude -p` mode. If it does not, the fallback is
  `--permission-prompt-tool` with a small stdio MCP server, which slots
  behind the same broker without changing anything else.
- Confirm hook-bearing `--settings` files compose with the user's own
  settings chain when spawned by the engine.

## 8. Out of scope (V2+)

- Codex app-server adapter (plugs into `broker.decide()`).
- Slack connector (second `ApprovalChannel`; needs token/auth design).
- Allow-with-modified-input decisions.
- "Always allow this pattern" memory across requests or runs.

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

// What the broker returns to the hook helper. 'defer' means "no opinion,
// let Claude Code's normal permission evaluation proceed".
interface BrokerDecision {
  behavior: 'allow' | 'deny' | 'defer';
  reason?: string;
}

interface ApprovalChannel {
  readonly id: string;        // 'agentbus' | 'slack' | ...
  request(req: PermissionRequest): Promise<PermissionDecision>;
  close?(): Promise<void>;
}
```

### Hook mechanism (verified 2026-06-10)

The original draft used a `PermissionRequest` hook. Verification against
current Claude Code docs found that **`PermissionRequest` hooks do not fire
in `-p` (headless) mode**, and the old `--permission-prompt-tool` flag no
longer exists. The documented mechanism for programmatic permission
decisions in headless mode is a **`PreToolUse` hook** returning
`hookSpecificOutput.permissionDecision` (`allow` / `deny`).

Consequence: a PreToolUse hook fires on *every* tool call, not only on
would-be permission prompts. To avoid escalating calls that would have been
allowed (or explicitly denied) anyway, the broker first matches each call
against known permission rules and answers `defer` for matches; only
unmatched calls — exactly the set that headless mode would silently deny —
escalate to the human. For `defer`, the helper prints nothing and exits 0,
so normal permission evaluation proceeds untouched.

## 3. Components

### 3.1 EscalationBroker (`src/escalation/broker.ts`)

One per run, created by the runner when escalation is configured.

- Owns a unix socket in the run's temp dir; accepts JSON `PermissionRequest`s
  from hook helpers and replies with `BrokerDecision`s (one JSON line each
  way per connection).
- **Rule matching first:** a call matching the per-call allow rules (the
  `tools` the engine passed as `--allowedTools`) or the allow/deny rules
  loaded from the user's settings chain (`~/.claude/settings.json`,
  `.claude/settings.json`, `.claude/settings.local.json`) returns `defer`
  immediately — no human traffic. The matcher implements simplified,
  conservative semantics (exact tool name, `Tool`, `Tool(*)`,
  `Bash(prefix:*)` command-prefix); anything it cannot interpret does not
  match, i.e. escalates. `ask`-rule matches escalate by design.
- Only unmatched calls route through the configured `ApprovalChannel`,
  racing it against the effective `EscalationPolicy` timer.
- Logs every request and decision through the run's `log()` so the transcript
  shows all escalations.
- Exposes `decide(req): Promise<PermissionDecision>` directly for in-process
  callers — this is the Codex seam: the future app-server adapter calls
  `decide()` from its JSON-RPC `execCommandApproval`/`applyPatchApproval`
  handlers, no socket needed.
- Shutdown (in a `finally`, even when the workflow throws): denies in-flight
  requests, closes the socket, unregisters from the channel.

### 3.2 agentbus connector (`src/escalation/channels/agentbus.ts`)

V1's only connector. CLI contract verified empirically 2026-06-10:

- No engine-side registration needed: asks are sent as
  `agentbus ask <to> --from ext:awe-<runId> --timeout-ms <ms> -f <payload>`;
  `ext:*` senders work unregistered. Only the human's address `<to>` must be
  registered (`agentbus register <to> --persistent`, done once by the human).
- `ask` blocks until the reply and prints
  `{"request_id": "msg_...", "payload": {<reply>}}` on stdout; on timeout it
  exits 2. `--timeout-ms` is derived from the call's policy (effectively
  infinite for `onTimeout: 'wait'`).
- The human sees asks via `agentbus check-inbox <to>` and answers with
  `agentbus reply <msg-id> <to>` with payload
  `{"behavior":"allow"|"deny","reason":"..."}`. Anything but an explicit
  allow parses as deny.
- A Slack connector later is a second file implementing `ApprovalChannel`.

### 3.3 Hook helper (standalone node script)

`node <engine>/dist/escalation/hook-helper.js --socket <path> --meta <file>`

- Reads the Claude Code PreToolUse hook stdin JSON (`tool_name`,
  `tool_input`, `cwd`), merges the per-call metadata file (`agentLabel`,
  `policy`, `rules`), forwards the request over the socket, blocks for the
  `BrokerDecision`.
- Prints `{"hookSpecificOutput": {"hookEventName": "PreToolUse",
  "permissionDecision": "allow" | "deny", "permissionDecisionReason": ...}}`
  for allow/deny; for `defer` it prints nothing and exits 0 so normal
  permission evaluation proceeds.
- On any failure: prints nothing, exits non-zero — Claude Code falls back to
  its normal headless deny. Escalation failure can never make a run more
  permissive than today.

### 3.4 Claude adapter change (`src/adapters/claude.ts`)

When `spec.escalation` is present:

- Write a temp dir containing (a) a metadata JSON file with the call's
  `agentLabel`, `policy`, and defer `rules`, and (b) a `--settings` JSON
  file defining a PreToolUse hook (matcher `*`) whose command invokes the
  hook helper with the broker's socket path and the metadata file. The hook
  `timeout` is set comfortably above the escalation timeout (or very large
  for `onTimeout: 'wait'`).
- Add `--settings <file>` to the spawn args (hooks merge additively with the
  user's settings chain). No other change to the one-shot spawn model. The
  temp dir is removed after the process exits.

### 3.5 API surface

- Run level: `--escalate <channel>[:<target>]` CLI flag (e.g.
  `--escalate agentbus:tohru`) plus the equivalent in engine config.
- Per call: `agent(prompt, { escalation: { timeoutMs?, onTimeout?,
  disabled? } })`. `disabled: true` opts a call out of an escalation-enabled
  run.
- `AgentSpec` grows `escalation?: { socketPath, agentLabel, policy, rules,
  helperCommand? }`, built per call by the orchestration layer from the
  run's broker and the call's opts; adapters that lack escalation support
  ignore it (codex, for now). In-process adapters (the future codex
  app-server one) bypass the socket and call `broker.decide()` directly.

## 4. Data flow (happy path)

1. Run starts with `--escalate agentbus:tohru`; runner creates the broker
   (socket up, bus registration done).
2. `agent()` spawns `claude -p` with the injected settings file.
3. Claude makes a tool call; the `PreToolUse` hook fires the helper.
4. Helper forwards the request over the socket; the broker rule-matches it —
   calls covered by `--allowedTools` or the user's settings chain defer
   silently; an uncovered call goes to the agentbus connector;
   `agentbus ask tohru` delivers `{agentLabel, toolName, toolInput, cwd}`.
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

## 7. Verification items — resolved (2026-06-10)

- `PermissionRequest` hooks do **not** fire in `claude -p` mode, and
  `--permission-prompt-tool` no longer exists in the current CLI. Pivoted to
  a `PreToolUse` hook with `permissionDecision` plus broker-side rule
  matching (see "Hook mechanism" in section 2).
- `--settings` files merge **additively** with the user's settings chain;
  hooks from all scopes coexist.
- `agentbus` contract verified empirically (see section 3.2): `ext:*`
  senders need no registration; `ask` prints `{request_id, payload}` and
  exits 2 on timeout.

## 8. Out of scope (V2+)

- Codex app-server adapter (plugs into `broker.decide()`).
- Slack connector (second `ApprovalChannel`; needs token/auth design).
- Allow-with-modified-input decisions.
- "Always allow this pattern" memory across requests or runs.

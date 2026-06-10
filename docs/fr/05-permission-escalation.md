---
refs:
  id: fr:05-permission-escalation
  kind: fr
  title: "Permission Escalation"
  spec: permission-escalation
  related:
    - fr:02-orchestration-api
    - fr:03-cli-adapters
    - fr:04-run-cli
  modules:
    - src/escalation/
---

# FR 05: Permission Escalation

> When a headless Claude agent makes a tool call its grants don't cover, the run escalates the call to a human over agentbus and blocks on a full approve/deny round-trip — instead of silently denying it.

## Purpose

Headless agents (`claude -p`) cannot show a permission prompt; a blocked action just fails. Escalation gives the operator a way to approve or deny exactly those calls from anywhere on the bus, without babysitting a terminal, while keeping every failure path at least as restrictive as today.

## User-visible Behavior

Escalation is opt-in per run: `--escalate agentbus:<to>` (FR 04). The operator registers their bus address once: `agentbus register <to> --persistent`.

- Normal case (allow): an agent calls a tool outside its grants → the run logs `escalating <label>: <tool> <input>` → an ask appears in the operator's inbox (`agentbus check-inbox <to>`) carrying `agentLabel`, `cli`, `toolName`, `toolInput`, `cwd` → the operator replies `echo '{"behavior":"allow"}' | agentbus reply <msg-id> <to>` → the run logs `decision for <label>: allow` and the agent proceeds.
- Deny: a reply with anything other than an explicit `"behavior": "allow"` denies the call; the agent continues without it.
- Timeout: with the default policy the call is denied after 5 minutes (`decision: deny (escalation timeout)`); a late reply is ignored.
- Covered calls never ping the operator: anything matched by the call's `tools` grant or by the allow/deny rules in the operator's Claude settings chain defers to Claude Code's normal permission evaluation silently.

Per-call policy (FR 02): `agent(p, { escalation: { timeoutMs?, onTimeout?: 'deny' | 'wait', disabled? } })`. `'wait'` blocks indefinitely for an answer; `disabled: true` opts a call out of an escalation-enabled run.

## Capabilities

- Full approve/deny round-trip over agentbus `ask`/`reply`; the engine needs no bus registration (it sends as `ext:awe-<runId>`).
- Conservative rule matching before any human traffic: exact tool name, `Tool(*)`, `Bash(prefix:*)`, `Bash(exact)`; anything the matcher cannot interpret escalates. `ask`-rules escalate by design.
- Per-run broker with one unix socket; per-call policy and grants travel with each request, so concurrent agents with different policies are safe.
- Every escalation request and decision is narrated through the run log (`[wf]` lines), so the transcript shows the full audit trail.
- Failure is never more permissive: channel errors, timeouts, malformed requests, helper crashes, and run shutdown all resolve to deny (or to Claude Code's native headless deny).

## Boundaries

- Claude agents only. Codex agents keep sandbox-or-fail behavior; the broker exposes the seam (`decide()`) a future codex app-server adapter plugs into.
- agentbus is the only channel; a Slack connector is a planned second `ApprovalChannel` implementation.
- Approve/deny only — no allow-with-modified-input, and no "always allow this pattern" memory across requests or runs.
- The decision happens **before** the tool runs; the escalation channel does not report the tool's output back to the operator afterwards.

## Traceability

- **Spec**: `docs/superpowers/specs/2026-06-10-permission-escalation-design.md` (entire document; § 2 hook mechanism, § 5 error handling, § 8 out of scope)
- **Related FR**: 02-orchestration-api.md, 03-cli-adapters.md, 04-run-cli.md

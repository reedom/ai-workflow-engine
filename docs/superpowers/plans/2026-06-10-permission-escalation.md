# Permission Escalation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a headless Claude agent makes a tool call its grants don't cover, escalate to the human over agentbus with a full approve/deny round-trip instead of silently denying.

**Architecture:** A per-run `EscalationBroker` owns a unix socket and an `ApprovalChannel` (agentbus in V1). The claude adapter injects a `--settings` file with a `PreToolUse` hook; the hook helper forwards each tool call to the broker, which defers rule-covered calls and escalates the rest. Spec: `docs/superpowers/specs/2026-06-10-permission-escalation-design.md`.

**Tech Stack:** TypeScript (ESM, Node 22), vitest, `node:net` unix sockets, the `agentbus` CLI.

**Branch:** `feat/permission-escalation`

**Conventions (from repo + user CLAUDE.md):** never use `>` or `>=` in comparisons (write `0 < x`, `x <= max`); functions small and focused; tests live flat in `test/*.test.ts`; run a single file with `pnpm test test/<file>.test.ts`; build with `pnpm build`.

---

### Task 1: Escalation protocol types

**Files:**
- Create: `src/escalation/types.ts`

- [ ] **Step 1: Write the types file**

```typescript
// src/escalation/types.ts
export interface EscalationPolicy {
  timeoutMs: number;
  onTimeout: 'deny' | 'wait';
}

export const DEFAULT_POLICY: EscalationPolicy = { timeoutMs: 300_000, onTimeout: 'deny' };

export interface PermissionRequest {
  runId: string;
  agentLabel: string;
  cli: string; // 'claude' | 'codex' | ...
  toolName: string;
  toolInput: unknown;
  cwd?: string;
  policy?: EscalationPolicy; // per-call override carried by the hook helper
  rules?: string[]; // per-call defer rules (the call's --allowedTools)
}

// What a channel (a human) answers.
export interface PermissionDecision {
  behavior: 'allow' | 'deny';
  reason?: string;
}

// What the broker returns to the hook helper. 'defer' means "no opinion,
// let Claude Code's normal permission evaluation proceed".
export interface BrokerDecision {
  behavior: 'allow' | 'deny' | 'defer';
  reason?: string;
}

export interface ApprovalChannel {
  readonly id: string; // 'agentbus' | 'slack' | ...
  request(req: PermissionRequest): Promise<PermissionDecision>;
  close?(): Promise<void>;
}
```

- [ ] **Step 2: Verify it compiles**

Run: `pnpm build`
Expected: exit 0, `dist/escalation/types.js` exists.

- [ ] **Step 3: Commit**

```bash
git add src/escalation/types.ts
git commit -m "feat: escalation protocol types"
```

---

### Task 2: Permission rule matcher

**Files:**
- Create: `src/escalation/rules.ts`
- Test: `test/escalation-rules.test.ts`

Simplified, conservative semantics: exact tool name (`Read`), `Tool(*)`,
`Bash(prefix:*)` command-prefix, `Bash(exact command)`. Anything the matcher
cannot interpret does NOT match — unmatched calls escalate, so a
conservative matcher is safe (worst case: an extra ask for the human).

- [ ] **Step 1: Write the failing test**

```typescript
// test/escalation-rules.test.ts
import { it, expect } from 'vitest';
import { matchesAnyRule, matchesRule } from '../src/escalation/rules.js';

it('matches bare tool name against any input', () => {
  expect(matchesRule('Read', { file_path: '/x' }, 'Read')).toBe(true);
  expect(matchesRule('Write', { file_path: '/x' }, 'Read')).toBe(false);
});

it('matches Tool(*) wildcard', () => {
  expect(matchesRule('WebSearch', {}, 'WebSearch(*)')).toBe(true);
});

it('matches Bash(prefix:*) as a command prefix', () => {
  expect(matchesRule('Bash', { command: 'git add -A' }, 'Bash(git add:*)')).toBe(true);
  expect(matchesRule('Bash', { command: 'git add' }, 'Bash(git add:*)')).toBe(true);
  expect(matchesRule('Bash', { command: 'git addx' }, 'Bash(git add:*)')).toBe(false);
  expect(matchesRule('Bash', { command: 'git push' }, 'Bash(git add:*)')).toBe(false);
});

it('matches Bash(exact) only exactly', () => {
  expect(matchesRule('Bash', { command: 'go version' }, 'Bash(go version)')).toBe(true);
  expect(matchesRule('Bash', { command: 'go version -m' }, 'Bash(go version)')).toBe(false);
});

it('is conservative: unknown arg patterns never match', () => {
  expect(matchesRule('Read', { file_path: '/x' }, 'Read(~/secrets/**)')).toBe(false);
  expect(matchesRule('Bash', { command: 'ls' }, 'not a rule!!')).toBe(false);
});

it('matchesAnyRule checks the whole list', () => {
  expect(matchesAnyRule('Bash', { command: 'ls -la' }, ['Read', 'Bash(ls:*)'])).toBe(true);
  expect(matchesAnyRule('Bash', { command: 'rm -rf /' }, ['Read', 'Bash(ls:*)'])).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test test/escalation-rules.test.ts`
Expected: FAIL — cannot find module `../src/escalation/rules.js`.

- [ ] **Step 3: Write the implementation**

```typescript
// src/escalation/rules.ts

// Simplified, conservative permission-rule matcher. Anything it cannot
// interpret does not match — unmatched calls escalate to the human.
export function matchesRule(toolName: string, toolInput: unknown, rule: string): boolean {
  const m = /^([A-Za-z][\w]*)(?:\((.*)\))?$/.exec(rule.trim());
  if (!m) return false;
  const ruleTool = m[1];
  const arg = m[2];
  if (ruleTool !== toolName) return false;
  if (arg === undefined || arg === '*') return true;
  if (toolName === 'Bash') return matchesBashArg(toolInput, arg);
  return false;
}

function matchesBashArg(toolInput: unknown, arg: string): boolean {
  const input = toolInput as Record<string, unknown> | null;
  const command = typeof input?.['command'] === 'string' ? (input['command'] as string) : '';
  if (arg.endsWith(':*')) {
    const prefix = arg.slice(0, -2);
    return command === prefix || command.startsWith(`${prefix} `);
  }
  return command === arg;
}

export function matchesAnyRule(toolName: string, toolInput: unknown, rules: string[]): boolean {
  return rules.some((rule) => matchesRule(toolName, toolInput, rule));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test test/escalation-rules.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/escalation/rules.ts test/escalation-rules.test.ts
git commit -m "feat: conservative permission rule matcher"
```

---

### Task 3: Settings-chain rule loading

**Files:**
- Modify: `src/escalation/rules.ts` (append)
- Test: `test/escalation-rules.test.ts` (append)

Loads allow+deny rules from the user/project settings chain so calls the
chain already covers defer silently (allow → normal flow allows; deny →
normal flow denies; neither should ping the human). `ask` rules are NOT
loaded — those should escalate.

- [ ] **Step 1: Write the failing test (append to test file)**

```typescript
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSettingsDeferRules } from '../src/escalation/rules.js';

it('loads allow and deny rules from a settings chain, skipping ask rules', () => {
  const home = mkdtempSync(join(tmpdir(), 'awe-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'awe-cwd-'));
  mkdirSync(join(home, '.claude'), { recursive: true });
  mkdirSync(join(cwd, '.claude'), { recursive: true });
  writeFileSync(
    join(home, '.claude', 'settings.json'),
    JSON.stringify({ permissions: { allow: ['Bash(ls:*)'], deny: ['Bash(sudo:*)'], ask: ['Bash(curl:*)'] } }),
  );
  writeFileSync(
    join(cwd, '.claude', 'settings.json'),
    JSON.stringify({ permissions: { allow: ['Read'] } }),
  );
  const rules = loadSettingsDeferRules(cwd, home);
  expect(rules).toContain('Bash(ls:*)');
  expect(rules).toContain('Bash(sudo:*)');
  expect(rules).toContain('Read');
  expect(rules).not.toContain('Bash(curl:*)');
});

it('returns empty rules when settings files are missing or invalid', () => {
  const empty = mkdtempSync(join(tmpdir(), 'awe-empty-'));
  expect(loadSettingsDeferRules(empty, empty)).toEqual([]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test test/escalation-rules.test.ts`
Expected: FAIL — `loadSettingsDeferRules` is not exported.

- [ ] **Step 3: Append the implementation to `src/escalation/rules.ts`**

```typescript
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// (imports go at the top of the file)

// Rules from the settings chain that should DEFER (allow: normal flow
// allows; deny: normal flow denies). `ask` rules are intentionally not
// loaded — they escalate.
export function loadSettingsDeferRules(cwd: string, home: string = homedir()): string[] {
  const files = [
    join(home, '.claude', 'settings.json'),
    join(cwd, '.claude', 'settings.json'),
    join(cwd, '.claude', 'settings.local.json'),
  ];
  const rules: string[] = [];
  for (const file of files) {
    const perms = readPermissions(file);
    rules.push(...(perms.allow ?? []), ...(perms.deny ?? []));
  }
  return rules;
}

function readPermissions(file: string): { allow?: string[]; deny?: string[] } {
  try {
    const json = JSON.parse(readFileSync(file, 'utf8')) as {
      permissions?: { allow?: string[]; deny?: string[] };
    };
    return json.permissions ?? {};
  } catch {
    return {};
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test test/escalation-rules.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/escalation/rules.ts test/escalation-rules.test.ts
git commit -m "feat: load defer rules from settings chain"
```

---

### Task 4: EscalationBroker — decide()

**Files:**
- Create: `src/escalation/broker.ts`
- Test: `test/escalation-broker.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// test/escalation-broker.test.ts
import { it, expect, vi } from 'vitest';
import { EscalationBroker } from '../src/escalation/broker.js';
import type { ApprovalChannel, PermissionRequest } from '../src/escalation/types.js';

function req(over: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    runId: 'r1',
    agentLabel: 'worker',
    cli: 'claude',
    toolName: 'Bash',
    toolInput: { command: 'rm -rf build' },
    ...over,
  };
}

function fakeChannel(impl: ApprovalChannel['request']): ApprovalChannel {
  return { id: 'fake', request: impl };
}

it('defers calls matching per-call rules without touching the channel', async () => {
  const request = vi.fn();
  const broker = new EscalationBroker({ runId: 'r1', channel: fakeChannel(request) });
  const d = await broker.decide(req({ rules: ['Bash(rm -rf:*)'] }));
  expect(d.behavior).toBe('defer');
  expect(request).not.toHaveBeenCalled();
});

it('defers calls matching settings rules', async () => {
  const request = vi.fn();
  const broker = new EscalationBroker({
    runId: 'r1',
    channel: fakeChannel(request),
    settingsRules: ['Bash(rm -rf:*)'],
  });
  const d = await broker.decide(req());
  expect(d.behavior).toBe('defer');
  expect(request).not.toHaveBeenCalled();
});

it('escalates unmatched calls and returns the channel decision', async () => {
  const broker = new EscalationBroker({
    runId: 'r1',
    channel: fakeChannel(async () => ({ behavior: 'allow', reason: 'ok' })),
  });
  const d = await broker.decide(req());
  expect(d).toEqual({ behavior: 'allow', reason: 'ok' });
});

it('denies on timeout when onTimeout is deny', async () => {
  const broker = new EscalationBroker({
    runId: 'r1',
    channel: fakeChannel(() => new Promise(() => {})), // never answers
  });
  const d = await broker.decide(req({ policy: { timeoutMs: 20, onTimeout: 'deny' } }));
  expect(d.behavior).toBe('deny');
  expect(d.reason).toBe('escalation timeout');
});

it('keeps waiting past timeoutMs when onTimeout is wait', async () => {
  const broker = new EscalationBroker({
    runId: 'r1',
    channel: fakeChannel(
      () => new Promise((resolve) => setTimeout(() => resolve({ behavior: 'allow' }), 60)),
    ),
  });
  const d = await broker.decide(req({ policy: { timeoutMs: 10, onTimeout: 'wait' } }));
  expect(d.behavior).toBe('allow');
});

it('denies when the channel throws', async () => {
  const broker = new EscalationBroker({
    runId: 'r1',
    channel: fakeChannel(async () => {
      throw new Error('bus down');
    }),
  });
  const d = await broker.decide(req());
  expect(d.behavior).toBe('deny');
  expect(d.reason).toContain('bus down');
});

it('denies in-flight requests on close and calls channel.close', async () => {
  const close = vi.fn(async () => {});
  const broker = new EscalationBroker({
    runId: 'r1',
    channel: { id: 'fake', request: () => new Promise(() => {}), close },
  });
  const pending = broker.decide(req({ policy: { timeoutMs: 60_000, onTimeout: 'wait' } }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  await broker.close();
  const d = await pending;
  expect(d).toEqual({ behavior: 'deny', reason: 'run shutdown' });
  expect(close).toHaveBeenCalled();
});

it('logs escalations and decisions', async () => {
  const lines: string[] = [];
  const broker = new EscalationBroker({
    runId: 'r1',
    channel: fakeChannel(async () => ({ behavior: 'deny', reason: 'nope' })),
    log: (m) => lines.push(m),
  });
  await broker.decide(req());
  expect(lines.some((l) => l.includes('escalating') && l.includes('worker'))).toBe(true);
  expect(lines.some((l) => l.includes('deny'))).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test test/escalation-broker.test.ts`
Expected: FAIL — cannot find module `../src/escalation/broker.js`.

- [ ] **Step 3: Write the implementation (decide/close only; socket comes in Task 5)**

```typescript
// src/escalation/broker.ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ApprovalChannel,
  BrokerDecision,
  EscalationPolicy,
  PermissionRequest,
} from './types.js';
import { DEFAULT_POLICY } from './types.js';
import { matchesAnyRule } from './rules.js';

export interface BrokerOptions {
  runId: string;
  channel: ApprovalChannel;
  settingsRules?: string[];
  defaultPolicy?: EscalationPolicy;
  log?: (msg: string) => void;
}

type Settle = (d: BrokerDecision) => void;

export class EscalationBroker {
  readonly runId: string;
  readonly socketPath: string;
  private readonly opts: BrokerOptions;
  private readonly inflight = new Set<Settle>();

  constructor(opts: BrokerOptions) {
    this.opts = opts;
    this.runId = opts.runId;
    this.socketPath = join(mkdtempSync(join(tmpdir(), 'awe-esc-')), 'broker.sock');
  }

  async decide(req: PermissionRequest): Promise<BrokerDecision> {
    const rules = [...(req.rules ?? []), ...(this.opts.settingsRules ?? [])];
    if (matchesAnyRule(req.toolName, req.toolInput, rules)) return { behavior: 'defer' };
    const policy = req.policy ?? this.opts.defaultPolicy ?? DEFAULT_POLICY;
    this.log(`escalating ${req.agentLabel}: ${req.toolName} ${summarize(req.toolInput)}`);
    const decision = await this.escalate(req, policy);
    this.log(`decision for ${req.agentLabel}: ${decision.behavior}${decision.reason ? ` (${decision.reason})` : ''}`);
    return decision;
  }

  private escalate(req: PermissionRequest, policy: EscalationPolicy): Promise<BrokerDecision> {
    return new Promise((resolve) => {
      const settle: Settle = (d) => {
        if (!this.inflight.has(settle)) return;
        this.inflight.delete(settle);
        resolve(d);
      };
      this.inflight.add(settle);
      if (policy.onTimeout === 'deny') {
        const timer = setTimeout(
          () => settle({ behavior: 'deny', reason: 'escalation timeout' }),
          policy.timeoutMs,
        );
        timer.unref();
      }
      this.opts.channel.request(req).then(
        (d) => settle({ behavior: d.behavior, reason: d.reason }),
        // Channel failure must never be more permissive than today; a hung
        // channel is also useless to wait on, so deny immediately.
        (err) => settle({ behavior: 'deny', reason: `channel error: ${String(err)}` }),
      );
    });
  }

  async close(): Promise<void> {
    for (const settle of [...this.inflight]) settle({ behavior: 'deny', reason: 'run shutdown' });
    await this.opts.channel.close?.();
  }

  private log(msg: string): void {
    this.opts.log?.(msg);
  }
}

function summarize(toolInput: unknown): string {
  const text = JSON.stringify(toolInput) ?? '';
  return text.length <= 120 ? text : `${text.slice(0, 120)}...`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test test/escalation-broker.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/escalation/broker.ts test/escalation-broker.test.ts
git commit -m "feat: escalation broker decision core"
```

---

### Task 5: EscalationBroker — unix socket server

**Files:**
- Modify: `src/escalation/broker.ts`
- Test: `test/escalation-broker.test.ts` (append)

Wire protocol: one connection per request; client writes one JSON line
(`PermissionRequest`), server replies one JSON line (`BrokerDecision`) and
ends the connection. Malformed requests get a deny line.

- [ ] **Step 1: Write the failing test (append)**

```typescript
import { connect } from 'node:net';
import type { BrokerDecision } from '../src/escalation/types.js';

function roundTrip(socketPath: string, payload: string): Promise<BrokerDecision> {
  return new Promise((resolve, reject) => {
    const sock = connect(socketPath, () => sock.write(`${payload}\n`));
    let buf = '';
    sock.on('data', (d) => {
      buf += d;
      const nl = buf.indexOf('\n');
      if (0 <= nl) {
        sock.end();
        resolve(JSON.parse(buf.slice(0, nl)) as BrokerDecision);
      }
    });
    sock.on('error', reject);
  });
}

it('serves decisions over its unix socket', async () => {
  const broker = new EscalationBroker({
    runId: 'r1',
    channel: fakeChannel(async () => ({ behavior: 'allow', reason: 'remote ok' })),
  });
  await broker.start();
  try {
    const d = await roundTrip(broker.socketPath, JSON.stringify(req()));
    expect(d).toEqual({ behavior: 'allow', reason: 'remote ok' });
    const deferred = await roundTrip(
      broker.socketPath,
      JSON.stringify(req({ rules: ['Bash(rm -rf:*)'] })),
    );
    expect(deferred.behavior).toBe('defer');
  } finally {
    await broker.close();
  }
});

it('answers deny to malformed socket requests', async () => {
  const broker = new EscalationBroker({ runId: 'r1', channel: fakeChannel(vi.fn()) });
  await broker.start();
  try {
    const d = await roundTrip(broker.socketPath, 'not json');
    expect(d.behavior).toBe('deny');
  } finally {
    await broker.close();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test test/escalation-broker.test.ts`
Expected: FAIL — `broker.start` is not a function.

- [ ] **Step 3: Add the socket server to `EscalationBroker`**

Add imports and members:

```typescript
import { createServer, type Server, type Socket } from 'node:net';
```

```typescript
  private server?: Server;

  async start(): Promise<void> {
    this.server = createServer((sock) => this.handleConnection(sock));
    await new Promise<void>((resolve, reject) => {
      this.server?.once('error', reject);
      this.server?.listen(this.socketPath, resolve);
    });
  }

  private handleConnection(sock: Socket): void {
    let buf = '';
    sock.on('data', (d) => {
      buf += d;
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      void this.answer(sock, buf.slice(0, nl));
    });
    sock.on('error', () => {});
  }

  private async answer(sock: Socket, line: string): Promise<void> {
    let decision: BrokerDecision;
    try {
      decision = await this.decide(JSON.parse(line) as PermissionRequest);
    } catch (err) {
      decision = { behavior: 'deny', reason: `bad request: ${String(err)}` };
    }
    sock.end(`${JSON.stringify(decision)}\n`);
  }
```

And extend `close()` to stop the server before settling in-flight requests:

```typescript
  async close(): Promise<void> {
    for (const settle of [...this.inflight]) settle({ behavior: 'deny', reason: 'run shutdown' });
    if (this.server) {
      await new Promise<void>((resolve) => this.server?.close(() => resolve()));
      this.server = undefined;
    }
    await this.opts.channel.close?.();
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test test/escalation-broker.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add src/escalation/broker.ts test/escalation-broker.test.ts
git commit -m "feat: escalation broker unix socket server"
```

---

### Task 6: Hook helper

**Files:**
- Create: `src/escalation/hook-helper.ts`
- Test: `test/escalation-hook-helper.test.ts`

The helper is what the injected PreToolUse hook executes. Stdin: Claude
Code's hook JSON. Output: the PreToolUse `hookSpecificOutput` JSON for
allow/deny, NOTHING for defer (printing nothing + exit 0 lets normal
permission evaluation proceed). Any failure: exit non-zero, print nothing.

- [ ] **Step 1: Write the failing test**

```typescript
// test/escalation-hook-helper.test.ts
import { it, expect } from 'vitest';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EscalationBroker } from '../src/escalation/broker.js';
import { runHookHelper } from '../src/escalation/hook-helper.js';

function setup(decision: 'allow' | 'deny') {
  const broker = new EscalationBroker({
    runId: 'r1',
    channel: { id: 'fake', request: async () => ({ behavior: decision, reason: 'human said so' }) },
  });
  const metaPath = join(mkdtempSync(join(tmpdir(), 'awe-meta-')), 'meta.json');
  writeFileSync(
    metaPath,
    JSON.stringify({
      runId: 'r1',
      agentLabel: 'worker',
      policy: { timeoutMs: 5_000, onTimeout: 'deny' },
      rules: ['Read'],
    }),
  );
  return { broker, metaPath };
}

const hookStdin = JSON.stringify({
  hook_event_name: 'PreToolUse',
  tool_name: 'Bash',
  tool_input: { command: 'rm -rf build' },
  cwd: '/work',
});

it('prints a PreToolUse allow decision', async () => {
  const { broker, metaPath } = setup('allow');
  await broker.start();
  try {
    const out = await runHookHelper(['--socket', broker.socketPath, '--meta', metaPath], hookStdin);
    expect(out).not.toBeNull();
    expect(JSON.parse(out as string)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        permissionDecisionReason: 'human said so',
      },
    });
  } finally {
    await broker.close();
  }
});

it('prints a deny decision', async () => {
  const { broker, metaPath } = setup('deny');
  await broker.start();
  try {
    const out = await runHookHelper(['--socket', broker.socketPath, '--meta', metaPath], hookStdin);
    const parsed = JSON.parse(out as string) as {
      hookSpecificOutput: { permissionDecision: string };
    };
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
  } finally {
    await broker.close();
  }
});

it('returns null (prints nothing) for deferred calls', async () => {
  const { broker, metaPath } = setup('allow');
  await broker.start();
  try {
    const readStdin = JSON.stringify({ tool_name: 'Read', tool_input: { file_path: '/x' } });
    const out = await runHookHelper(['--socket', broker.socketPath, '--meta', metaPath], readStdin);
    expect(out).toBeNull();
  } finally {
    await broker.close();
  }
});

it('throws when the socket is unreachable', async () => {
  const { metaPath } = setup('allow');
  await expect(
    runHookHelper(['--socket', '/nonexistent/broker.sock', '--meta', metaPath], hookStdin),
  ).rejects.toThrow();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test test/escalation-hook-helper.test.ts`
Expected: FAIL — cannot find module `../src/escalation/hook-helper.js`.

- [ ] **Step 3: Write the implementation**

```typescript
// src/escalation/hook-helper.ts
import { readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { pathToFileURL } from 'node:url';
import type { BrokerDecision, EscalationPolicy, PermissionRequest } from './types.js';

interface HookStdin {
  tool_name?: string;
  tool_input?: unknown;
  cwd?: string;
}

interface HelperMeta {
  runId: string;
  agentLabel: string;
  policy: EscalationPolicy;
  rules: string[];
}

function takeArg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  return argv[i + 1];
}

// Returns the hook output JSON string for allow/deny, or null for defer
// (the caller prints nothing so normal permission evaluation proceeds).
export async function runHookHelper(argv: string[], stdinJson: string): Promise<string | null> {
  const socketPath = takeArg(argv, '--socket');
  const metaPath = takeArg(argv, '--meta');
  if (!socketPath || !metaPath) throw new Error('usage: hook-helper --socket <path> --meta <file>');
  const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as HelperMeta;
  const hook = JSON.parse(stdinJson) as HookStdin;
  const req: PermissionRequest = {
    runId: meta.runId,
    agentLabel: meta.agentLabel,
    cli: 'claude',
    toolName: hook.tool_name ?? '',
    toolInput: hook.tool_input,
    cwd: hook.cwd,
    policy: meta.policy,
    rules: meta.rules,
  };
  const decision = await requestDecision(socketPath, JSON.stringify(req));
  if (decision.behavior === 'defer') return null;
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision.behavior,
      permissionDecisionReason: decision.reason ?? `escalation: ${decision.behavior}`,
    },
  });
}

function requestDecision(socketPath: string, payload: string): Promise<BrokerDecision> {
  return new Promise((resolve, reject) => {
    const sock = connect(socketPath, () => sock.write(`${payload}\n`));
    let buf = '';
    sock.on('data', (d) => {
      buf += d;
      const nl = buf.indexOf('\n');
      if (0 <= nl) {
        sock.end();
        resolve(JSON.parse(buf.slice(0, nl)) as BrokerDecision);
      }
    });
    sock.on('error', reject);
  });
}

async function readAllStdin(): Promise<string> {
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  readAllStdin()
    .then((stdin) => runHookHelper(process.argv.slice(2), stdin))
    .then((out) => {
      if (out !== null) process.stdout.write(`${out}\n`);
      process.exit(0);
    })
    .catch((err) => {
      // Print nothing on stdout: Claude Code falls back to its normal
      // headless deny. Never more permissive than today.
      process.stderr.write(`escalate-hook: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test test/escalation-hook-helper.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/escalation/hook-helper.ts test/escalation-hook-helper.test.ts
git commit -m "feat: escalation hook helper"
```

---

### Task 7: Claude adapter — settings injection

**Files:**
- Modify: `src/types.ts` (add `AgentEscalation`, extend `AgentSpec`)
- Modify: `src/adapters/claude.ts`
- Test: `test/claude.test.ts` (append)

- [ ] **Step 1: Extend `src/types.ts`**

Add near the top (after the imports line, if any):

```typescript
import type { EscalationPolicy } from './escalation/types.js';

export interface AgentEscalation {
  runId: string;
  socketPath: string;
  agentLabel: string;
  policy: EscalationPolicy;
  rules: string[]; // per-call defer rules (mirrors the call's tools)
  helperCommand?: string; // test override; default: node + dist hook-helper
}
```

And add to `AgentSpec`:

```typescript
export interface AgentSpec {
  prompt: string;
  model?: string;
  schema?: unknown; // JSON Schema object
  instructions?: string; // system prompt
  tools?: string[];
  cwd?: string;
  escalation?: AgentEscalation;
}
```

- [ ] **Step 2: Write the failing test (append to `test/claude.test.ts`)**

```typescript
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildEscalationSettings } from '../src/adapters/claude.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

it('writes meta + settings files with a PreToolUse hook', () => {
  const dir = mkdtempSync(join(tmpdir(), 'awe-claude-test-'));
  const settingsPath = buildEscalationSettings(
    {
      runId: 'r1',
      socketPath: '/tmp/broker.sock',
      agentLabel: 'worker',
      policy: { timeoutMs: 60_000, onTimeout: 'deny' },
      rules: ['Read'],
      helperCommand: 'node /opt/helper.js',
    },
    dir,
  );
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
    hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ type: string; command: string; timeout: number }> }> };
  };
  const hook = settings.hooks.PreToolUse[0];
  expect(hook.matcher).toBe('*');
  expect(hook.hooks[0].type).toBe('command');
  expect(hook.hooks[0].command).toContain('node /opt/helper.js');
  expect(hook.hooks[0].command).toContain('--socket "/tmp/broker.sock"');
  expect(hook.hooks[0].command).toContain(`--meta "${join(dir, 'meta.json')}"`);
  // hook timeout must comfortably exceed the escalation timeout (seconds)
  expect(120 <= hook.hooks[0].timeout).toBe(true);
  const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) as {
    agentLabel: string;
    policy: { onTimeout: string };
    rules: string[];
  };
  expect(meta.agentLabel).toBe('worker');
  expect(meta.policy.onTimeout).toBe('deny');
  expect(meta.rules).toEqual(['Read']);
});

it('uses a very large hook timeout for onTimeout wait', () => {
  const dir = mkdtempSync(join(tmpdir(), 'awe-claude-test-'));
  const settingsPath = buildEscalationSettings(
    {
      runId: 'r1',
      socketPath: '/tmp/broker.sock',
      agentLabel: 'worker',
      policy: { timeoutMs: 60_000, onTimeout: 'wait' },
      rules: [],
      helperCommand: 'node /opt/helper.js',
    },
    dir,
  );
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
    hooks: { PreToolUse: Array<{ hooks: Array<{ timeout: number }> }> };
  };
  expect(86_400 <= settings.hooks.PreToolUse[0].hooks[0].timeout).toBe(true);
});

it('passes --settings when spec.escalation is set and cleans up the temp dir', async () => {
  let seenArgs: string[] = [];
  const adapter = makeClaudeAdapter({
    spawnFn: async (_cmd, args) => {
      seenArgs = args;
      return { stdout: JSON.stringify({ result: 'ok', usage: {} }), stderr: '', code: 0 };
    },
  });
  await adapter.run({
    prompt: 'hi',
    escalation: {
      runId: 'r1',
      socketPath: '/tmp/broker.sock',
      agentLabel: 'worker',
      policy: { timeoutMs: 1_000, onTimeout: 'deny' },
      rules: [],
      helperCommand: 'node /opt/helper.js',
    },
  });
  const i = seenArgs.indexOf('--settings');
  expect(0 <= i).toBe(true);
  expect(existsSync(dirname(seenArgs[i + 1]))).toBe(false); // temp dir removed
});
```

Add the needed imports at the top of the test file: `existsSync` from
`node:fs`, `dirname` from `node:path`, and ensure `makeClaudeAdapter` is
already imported (it is, for existing tests).

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm test test/claude.test.ts`
Expected: FAIL — `buildEscalationSettings` is not exported.

- [ ] **Step 4: Implement in `src/adapters/claude.ts`**

Add imports:

```typescript
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentEscalation, AgentResult, AgentSpec, CliAdapter } from '../types.js';
```

Add:

```typescript
export function buildEscalationSettings(esc: AgentEscalation, dir: string): string {
  const metaPath = join(dir, 'meta.json');
  writeFileSync(
    metaPath,
    JSON.stringify({
      runId: esc.runId,
      agentLabel: esc.agentLabel,
      policy: esc.policy,
      rules: esc.rules,
    }),
  );
  const helper = esc.helperCommand ?? defaultHelperCommand();
  const settings = {
    hooks: {
      PreToolUse: [
        {
          matcher: '*',
          hooks: [
            {
              type: 'command',
              command: `${helper} --socket "${esc.socketPath}" --meta "${metaPath}"`,
              timeout: hookTimeoutSeconds(esc.policy),
            },
          ],
        },
      ],
    },
  };
  const settingsPath = join(dir, 'settings.json');
  writeFileSync(settingsPath, JSON.stringify(settings));
  return settingsPath;
}

function hookTimeoutSeconds(policy: AgentEscalation['policy']): number {
  if (policy.onTimeout === 'wait') return 86_400;
  return Math.ceil(policy.timeoutMs / 1000) + 60;
}

function defaultHelperCommand(): string {
  // Resolves to dist/escalation/hook-helper.js next to the built adapter.
  const helper = fileURLToPath(new URL('../escalation/hook-helper.js', import.meta.url));
  return `"${process.execPath}" "${helper}"`;
}
```

Update `makeClaudeAdapter`'s `run`:

```typescript
    async run(spec: AgentSpec): Promise<AgentResult> {
      const args = buildClaudeArgs(spec);
      let tempDir: string | undefined;
      if (spec.escalation) {
        tempDir = mkdtempSync(join(tmpdir(), 'awe-claude-'));
        args.push('--settings', buildEscalationSettings(spec.escalation, tempDir));
      }
      try {
        const { stdout, stderr, code } = await run(bin, args, spec.cwd);
        if (code !== 0) throw new Error(`claude exited ${code}: ${stderr.trim().slice(0, 500)}`);
        return parseClaudeResult(stdout);
      } finally {
        if (tempDir) rmSync(tempDir, { recursive: true, force: true });
      }
    },
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test test/claude.test.ts`
Expected: PASS (existing tests plus 3 new).

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/adapters/claude.ts test/claude.test.ts
git commit -m "feat: claude adapter escalation settings injection"
```

---

### Task 8: Orchestration + runner plumbing

**Files:**
- Modify: `src/types.ts` (extend `AgentOptions`)
- Modify: `src/runtime/orchestration.ts`
- Modify: `src/runtime/runner.ts`
- Test: `test/runner.test.ts` (append)

- [ ] **Step 1: Extend `AgentOptions` in `src/types.ts`**

```typescript
export interface AgentEscalationOptions {
  timeoutMs?: number;
  onTimeout?: 'deny' | 'wait';
  disabled?: boolean;
}

export interface AgentOptions {
  cli?: string;
  model?: string;
  schema?: unknown;
  instructions?: string;
  tools?: string[];
  cwd?: string;
  label?: string;
  phase?: string;
  escalation?: AgentEscalationOptions;
}
```

- [ ] **Step 2: Write the failing test (append to `test/runner.test.ts`)**

```typescript
import type { AgentSpec, CliAdapter } from '../src/types.js';
import type { ApprovalChannel } from '../src/escalation/types.js';

function captureAdapter(specs: AgentSpec[]): CliAdapter {
  return {
    id: 'claude',
    caps: { schema: true, resume: true, tools: true },
    async run(spec) {
      specs.push(spec);
      return { text: 'ok', raw: {}, usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
}

const idleChannel: ApprovalChannel = {
  id: 'fake',
  request: async () => ({ behavior: 'deny' }),
};

it('wires escalation into agent specs and closes the broker after the run', async () => {
  const specs: AgentSpec[] = [];
  const mod = {
    meta: { name: 'wf', description: 'd' },
    default: async (wf: { agent: (p: string, o?: object) => Promise<unknown> }) => {
      await wf.agent('do work', { tools: ['Read'], label: 'worker' });
      await wf.agent('quiet work', { escalation: { disabled: true } });
      return null;
    },
  };
  await runWorkflow(mod as never, {
    adapters: { claude: captureAdapter(specs) },
    escalation: { channel: idleChannel, runId: 'r1' },
  });
  expect(specs[0].escalation).toBeDefined();
  expect(specs[0].escalation?.agentLabel).toBe('worker');
  expect(specs[0].escalation?.rules).toEqual(['Read']);
  expect(specs[0].escalation?.policy).toEqual({ timeoutMs: 300_000, onTimeout: 'deny' });
  expect(specs[0].escalation?.socketPath).toBeTruthy();
  expect(specs[1].escalation).toBeUndefined();
});

it('does not wire escalation when not configured', async () => {
  const specs: AgentSpec[] = [];
  const mod = {
    meta: { name: 'wf', description: 'd' },
    default: async (wf: { agent: (p: string) => Promise<unknown> }) => wf.agent('do work'),
  };
  await runWorkflow(mod as never, { adapters: { claude: captureAdapter(specs) } });
  expect(specs[0].escalation).toBeUndefined();
});
```

(`runWorkflow` is already imported by existing tests in this file.)

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm test test/runner.test.ts`
Expected: FAIL — `escalation` option not accepted / spec.escalation undefined.

- [ ] **Step 4: Implement orchestration support (`src/runtime/orchestration.ts`)**

Add imports and extend `OrchestrationDeps`:

```typescript
import type { AgentEscalation, AgentOptions, AgentResult, CliAdapter, Stage, WorkflowApi } from '../types.js';
import type { EscalationPolicy } from '../escalation/types.js';
import type { EscalationBroker } from '../escalation/broker.js';

export interface OrchestrationDeps {
  adapters: Record<string, CliAdapter>;
  args: unknown;
  budget: MutableBudget;
  concurrency: number;
  onLog?: (msg: string) => void;
  escalation?: { broker: EscalationBroker; defaultPolicy: EscalationPolicy };
}
```

Inside `createWorkflowApi`, add a helper and use it in `agent()`:

```typescript
  function buildEscalation(prompt: string, opts: AgentOptions): AgentEscalation | undefined {
    const esc = deps.escalation;
    if (!esc || opts.escalation?.disabled) return undefined;
    return {
      runId: esc.broker.runId,
      socketPath: esc.broker.socketPath,
      agentLabel: opts.label ?? prompt.slice(0, 40),
      policy: {
        timeoutMs: opts.escalation?.timeoutMs ?? esc.defaultPolicy.timeoutMs,
        onTimeout: opts.escalation?.onTimeout ?? esc.defaultPolicy.onTimeout,
      },
      rules: opts.tools ?? [],
    };
  }
```

And in `agent()`'s `adapter.run({...})` call, add the field:

```typescript
      const result = await adapter.run({
        prompt,
        model: opts.model,
        schema: opts.schema,
        instructions: opts.instructions,
        tools: opts.tools,
        cwd: opts.cwd,
        escalation: buildEscalation(prompt, opts),
      });
```

- [ ] **Step 5: Implement runner support (`src/runtime/runner.ts`)**

```typescript
import type { ApprovalChannel, EscalationPolicy } from '../escalation/types.js';
import { DEFAULT_POLICY } from '../escalation/types.js';
import { EscalationBroker } from '../escalation/broker.js';
import { loadSettingsDeferRules } from '../escalation/rules.js';

export interface RunOptions {
  adapters: Record<string, CliAdapter>;
  args?: unknown;
  budget?: number | null;
  concurrency?: number;
  onLog?: (msg: string) => void;
  escalation?: {
    channel: ApprovalChannel;
    runId: string;
    defaultPolicy?: Partial<EscalationPolicy>;
  };
}

export async function runWorkflow(mod: WorkflowModule, opts: RunOptions): Promise<unknown> {
  const escalation = opts.escalation ? await startEscalation(opts) : undefined;
  try {
    const api = createWorkflowApi({
      adapters: opts.adapters,
      args: opts.args,
      budget: makeBudget(opts.budget ?? null),
      concurrency: opts.concurrency ?? 8,
      onLog: opts.onLog,
      escalation,
    });
    return await mod.default(api);
  } finally {
    await escalation?.broker.close();
  }
}

async function startEscalation(
  opts: RunOptions,
): Promise<{ broker: EscalationBroker; defaultPolicy: EscalationPolicy }> {
  const cfg = opts.escalation;
  if (!cfg) throw new Error('unreachable');
  const defaultPolicy: EscalationPolicy = { ...DEFAULT_POLICY, ...cfg.defaultPolicy };
  const broker = new EscalationBroker({
    runId: cfg.runId,
    channel: cfg.channel,
    settingsRules: loadSettingsDeferRules(process.cwd()),
    defaultPolicy,
    log: opts.onLog,
  });
  await broker.start();
  return { broker, defaultPolicy };
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm test test/runner.test.ts`
Expected: PASS (existing plus 2 new).

- [ ] **Step 7: Run the whole suite and build**

Run: `pnpm test && pnpm build`
Expected: all green.

- [ ] **Step 8: Commit**

```bash
git add src/types.ts src/runtime/orchestration.ts src/runtime/runner.ts test/runner.test.ts
git commit -m "feat: wire escalation through orchestration and runner"
```

---

### Task 9: CLI `--escalate` flag

**Files:**
- Modify: `src/cli.ts`
- Test: `test/cli.test.ts` (append)

- [ ] **Step 1: Write the failing test (append to `test/cli.test.ts`)**

```typescript
import { parseEscalateFlag } from '../src/cli.js';

it('parses --escalate agentbus:<to>', () => {
  expect(parseEscalateFlag('agentbus:tohru')).toEqual({ channelId: 'agentbus', target: 'tohru' });
});

it('rejects unknown channels and missing targets', () => {
  expect(() => parseEscalateFlag('slack:me')).toThrow(/unsupported escalation channel/);
  expect(() => parseEscalateFlag('agentbus')).toThrow(/agentbus:<to>/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test test/cli.test.ts`
Expected: FAIL — `parseEscalateFlag` is not exported.

- [ ] **Step 3: Implement in `src/cli.ts`**

Add imports:

```typescript
import { randomUUID } from 'node:crypto';
import { makeAgentbusChannel } from './escalation/channels/agentbus.js';
```

Add:

```typescript
export function parseEscalateFlag(raw: string): { channelId: string; target: string } {
  const sep = raw.indexOf(':');
  const channelId = sep < 0 ? raw : raw.slice(0, sep);
  const target = sep < 0 ? '' : raw.slice(sep + 1);
  if (channelId !== 'agentbus') {
    throw new Error(`unsupported escalation channel: ${channelId}`);
  }
  if (!target) throw new Error('usage: --escalate agentbus:<to>');
  return { channelId, target };
}
```

In `main()`, after the `--args` parsing block, add:

```typescript
  const escalateRaw = takeFlag(rest, '--escalate');
  let escalation: { channel: ReturnType<typeof makeAgentbusChannel>; runId: string } | undefined;
  if (escalateRaw !== undefined) {
    let target: string;
    try {
      target = parseEscalateFlag(escalateRaw).target;
    } catch (err) {
      process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
      return 2;
    }
    const runId = randomUUID().slice(0, 8);
    escalation = { channel: makeAgentbusChannel({ to: target, runId }), runId };
  }
```

Pass it to `runWorkflow` and update the usage string:

```typescript
    process.stderr.write(
      'usage: ai-workflow-engine run <workflow-file> [--args <json>] [--budget <n>] [--escalate agentbus:<to>]\n',
    );
```

```typescript
  const result = await runWorkflow(mod, {
    adapters: { ... }, // unchanged
    args,
    budget,
    escalation,
    onLog: (m) => process.stderr.write(`[wf] ${m}\n`),
  });
```

NOTE: this step does not compile until Task 10 creates
`src/escalation/channels/agentbus.ts`. If executing tasks strictly in
order, swap Tasks 9 and 10, or commit them together; the plan keeps the
CLI task first because its test is independent (`parseEscalateFlag`).

- [ ] **Step 4: Run test (after Task 10 exists, or with the import temporarily stubbed)**

Run: `pnpm test test/cli.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit (may be combined with Task 10)**

```bash
git add src/cli.ts test/cli.test.ts
git commit -m "feat: --escalate flag"
```

---

### Task 10: agentbus channel connector

**Files:**
- Create: `src/escalation/channels/agentbus.ts`
- Test: `test/escalation-agentbus.test.ts`

- [ ] **Step 1: CLI contract (verified 2026-06-10 against the installed agentbus)**

No verification needed — the contract was confirmed empirically:

- The engine does NOT need to register: `agentbus ask <to> --from
  ext:awe-<runId> --timeout-ms <ms> -f <payload-file>` works from an
  unregistered `ext:*` sender, blocks until the reply, and prints
  `{"request_id": "msg_...", "payload": {<reply payload>}}` on stdout
  (exit 0). On timeout: exit 2,
  `error[timeout]: no reply within N ms ...` on stderr.
- The recipient must be registered (`agentbus register <to> --persistent`
  for a durable human address — the human does this once, not the engine).
- The human sees asks via `agentbus check-inbox <to>` (or `await <to>`),
  which prints `{"envelopes": [{"id": "msg_...", "kind": "ask",
  "payload": {...}, "from": ..., ...}]}`, and answers with
  `agentbus reply <request-id> <to> -f <file>` (or payload on stdin).
- The reply payload arrives verbatim under `.payload` in the ask's stdout.

- [ ] **Step 2: Write the failing test**

```typescript
// test/escalation-agentbus.test.ts
import { it, expect, vi } from 'vitest';
import { makeAgentbusChannel, parseReplyPayload } from '../src/escalation/channels/agentbus.js';
import type { SpawnFn } from '../src/adapters/claude.js';

const askStdout = JSON.stringify({
  request_id: 'msg_01X',
  payload: { behavior: 'allow', reason: 'go ahead' },
});

const req = {
  runId: 'r1',
  agentLabel: 'worker',
  cli: 'claude',
  toolName: 'Bash',
  toolInput: { command: 'rm -rf build' },
  policy: { timeoutMs: 60_000, onTimeout: 'deny' as const },
};

it('asks with from/timeout flags and parses the allow reply envelope', async () => {
  const calls: string[][] = [];
  const spawnFn: SpawnFn = async (_cmd, args) => {
    calls.push(args);
    return { stdout: `${askStdout}\n`, stderr: '', code: 0 };
  };
  const channel = makeAgentbusChannel({ to: 'tohru', runId: 'r1', spawnFn });
  const d = await channel.request(req);
  expect(d).toEqual({ behavior: 'allow', reason: 'go ahead' });
  const ask = calls[0];
  expect(ask[0]).toBe('ask');
  expect(ask[1]).toBe('tohru');
  expect(ask).toContain('--from');
  expect(ask).toContain('ext:awe-r1');
  expect(ask).toContain('--timeout-ms');
  expect(ask).toContain('60000');
});

it('uses a very large ask timeout when onTimeout is wait', async () => {
  const calls: string[][] = [];
  const spawnFn: SpawnFn = async (_cmd, args) => {
    calls.push(args);
    return { stdout: askStdout, stderr: '', code: 0 };
  };
  const channel = makeAgentbusChannel({ to: 'tohru', runId: 'r1', spawnFn });
  await channel.request({ ...req, policy: { timeoutMs: 1_000, onTimeout: 'wait' } });
  const i = calls[0].indexOf('--timeout-ms');
  expect(86_400_000 <= Number(calls[0][i + 1])).toBe(true);
});

it('treats anything but an explicit allow as deny', () => {
  expect(parseAskStdout('{"request_id":"m","payload":{"behavior":"deny","reason":"no"}}')).toEqual({
    behavior: 'deny',
    reason: 'no',
  });
  expect(parseAskStdout('{"request_id":"m","payload":{"behavior":"yes"}}').behavior).toBe('deny');
  expect(parseAskStdout('garbage').behavior).toBe('deny');
});

it('throws when ask fails (e.g. timeout exit 2) so the broker applies its policy', async () => {
  const spawnFn: SpawnFn = async () => ({
    stdout: '',
    stderr: 'error[timeout]: no reply within 60000 ms',
    code: 2,
  });
  const channel = makeAgentbusChannel({ to: 'ghost', runId: 'r1', spawnFn });
  await expect(channel.request(req)).rejects.toThrow(/agentbus ask failed/);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm test test/escalation-agentbus.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Write the implementation**

```typescript
// src/escalation/channels/agentbus.ts
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runProcess, type SpawnFn } from '../../adapters/claude.js';
import { DEFAULT_POLICY } from '../types.js';
import type { ApprovalChannel, PermissionDecision, PermissionRequest } from '../types.js';

export interface AgentbusChannelOptions {
  to: string; // the human's address on the bus (must be registered, e.g. `agentbus register <to> --persistent`)
  runId: string;
  bin?: string;
  spawnFn?: SpawnFn;
}

const WAIT_TIMEOUT_MS = 86_400_000; // effectively "forever" for onTimeout: 'wait'

// Parses `agentbus ask` stdout: {"request_id": "msg_...", "payload": {...}}.
// Anything but an explicit allow is a deny.
export function parseAskStdout(stdout: string): PermissionDecision {
  try {
    const parsed = JSON.parse(stdout) as { payload?: { behavior?: unknown; reason?: unknown } };
    const reply = parsed.payload ?? {};
    const reason = typeof reply.reason === 'string' ? reply.reason : undefined;
    if (reply.behavior === 'allow') return { behavior: 'allow', reason };
    return { behavior: 'deny', reason: reason ?? 'denied' };
  } catch {
    return { behavior: 'deny', reason: 'unparseable reply' };
  }
}

export function makeAgentbusChannel(opts: AgentbusChannelOptions): ApprovalChannel {
  const bin = opts.bin ?? 'agentbus';
  const run = opts.spawnFn ?? runProcess;
  // `ext:` senders need no registration; only the recipient must exist.
  const self = `ext:awe-${opts.runId}`;
  return {
    id: 'agentbus',
    async request(req: PermissionRequest): Promise<PermissionDecision> {
      const policy = req.policy ?? DEFAULT_POLICY;
      const timeoutMs = policy.onTimeout === 'wait' ? WAIT_TIMEOUT_MS : policy.timeoutMs;
      const payload = JSON.stringify({
        agentLabel: req.agentLabel,
        cli: req.cli,
        toolName: req.toolName,
        toolInput: req.toolInput,
        cwd: req.cwd,
        replyWith: 'agentbus reply <this ask id> <your-name> with payload {"behavior":"allow"|"deny","reason":"..."}',
      });
      const file = join(mkdtempSync(join(tmpdir(), 'awe-ask-')), 'payload.json');
      writeFileSync(file, payload);
      const r = await run(bin, [
        'ask', opts.to,
        '--from', self,
        '--timeout-ms', String(timeoutMs),
        '-f', file,
      ]);
      if (r.code !== 0) throw new Error(`agentbus ask failed: ${r.stderr.trim().slice(0, 300)}`);
      return parseAskStdout(r.stdout);
    },
  };
}
```

- [ ] **Step 5: Run unit tests**

Run: `pnpm test test/escalation-agentbus.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Integration test against the real binary (append to the same test file)**

```typescript
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const hasAgentbus = await new Promise<boolean>((resolve) => {
  const p = spawn('agentbus', ['--version']);
  p.on('error', () => resolve(false));
  p.on('close', (code) => resolve(code === 0));
});

it.skipIf(!hasAgentbus)('round-trips through a real agentbus store', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'awe-bus-'));
  const env = { ...process.env, AGENTBUS_DIR: dir };
  const sh = (args: string[], input?: string) =>
    new Promise<{ stdout: string; code: number }>((resolve) => {
      const p = spawn('agentbus', args, { env });
      let stdout = '';
      p.stdout.on('data', (d) => (stdout += d));
      if (input !== undefined) p.stdin.end(input);
      p.on('close', (code) => resolve({ stdout, code: code ?? -1 }));
    });

  await sh(['register', 'human', '--persistent']);
  // Scripted replier: poll the inbox for the ask envelope, then reply allow.
  const replier = (async () => {
    for (let i = 0; i < 100; i += 1) {
      const inbox = await sh(['check-inbox', 'human']);
      const parsed = JSON.parse(inbox.stdout || '{"envelopes":[]}') as {
        envelopes: Array<{ id: string; kind: string }>;
      };
      const ask = parsed.envelopes.find((e) => e.kind === 'ask');
      if (ask) {
        await sh(['reply', ask.id, 'human'], '{"behavior":"allow","reason":"itest"}');
        return;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('no ask arrived');
  })();

  const channel = makeAgentbusChannel({
    to: 'human',
    runId: 'itest',
    spawnFn: (cmd, args) =>
      new Promise((resolve) => {
        const p = spawn(cmd, args, { env });
        let stdout = '';
        let stderr = '';
        p.stdout.on('data', (d) => (stdout += d));
        p.stderr.on('data', (d) => (stderr += d));
        p.on('close', (code) => resolve({ stdout, stderr, code: code ?? -1 }));
      }),
  });
  const [decision] = await Promise.all([
    channel.request({
      runId: 'itest',
      agentLabel: 'w',
      cli: 'claude',
      toolName: 'Bash',
      toolInput: { command: 'x' },
      policy: { timeoutMs: 15_000, onTimeout: 'deny' },
    }),
    replier,
  ]);
  expect(decision.behavior).toBe('allow');
}, 20_000);
```

Note: `check-inbox` DRAINS the inbox; the replier reads it exactly once per
envelope, which is fine here since it acts on the first ask it sees.

- [ ] **Step 7: Run the whole suite and build**

Run: `pnpm test && pnpm build`
Expected: all green (Task 9's CLI import now resolves).

- [ ] **Step 8: Commit**

```bash
git add src/escalation/channels/agentbus.ts test/escalation-agentbus.test.ts src/cli.ts test/cli.test.ts
git commit -m "feat: agentbus approval channel"
```

---

### Task 11: Example workflow + docs

**Files:**
- Create: `examples/escalation-demo.js`
- Modify: `README.md`

- [ ] **Step 1: Write the example workflow**

```javascript
// examples/escalation-demo.js
// Demo: the agent is only granted Read, then asked to use Bash — the Bash
// call escalates. Run with:
//   pnpm build
//   agentbus register me --persistent   # once
//   node dist/cli.js run examples/escalation-demo.js --escalate agentbus:me
// Answer from another shell:
//   agentbus check-inbox me                                   # note the ask's "id"
//   echo '{"behavior":"allow"}' | agentbus reply <msg-id> me  # approve it
export const meta = {
  name: 'escalation-demo',
  description: 'demo: an agent needs a tool outside its grants',
};

export default async function (wf) {
  const result = await wf.agent(
    'Create an empty file /tmp/awe-escalation-demo using Bash, then reply with one word: done or blocked.',
    { tools: ['Read'], label: 'demo-worker', escalation: { timeoutMs: 120_000 } },
  );
  wf.log(`agent said: ${result.text}`);
  return result.text;
}
```

- [ ] **Step 2: Run the E2E manually**

```bash
pnpm build
agentbus register me --persistent   # once, in another shell
node dist/cli.js run examples/escalation-demo.js --escalate agentbus:me
# in the other shell: agentbus await me / check-inbox, then reply allow
```

Expected: the run logs `escalating demo-worker: Bash ...`, the reply
unblocks it, `/tmp/awe-escalation-demo` exists, output is `done`.
Also verify the deny path (reply deny → agent reports blocked) and the
timeout path (don't reply with a short `timeoutMs` → deny after timeout).

- [ ] **Step 3: Update README.md**

In the feature list, after the `--cmux` bullet, add:

```markdown
- Optional `--escalate agentbus:<to>` routes permission requests from
  headless agents to a human over agentbus with a full approve/deny
  round-trip (Claude agents; Codex support is roadmap). See
  [`docs/superpowers/specs/2026-06-10-permission-escalation-design.md`](docs/superpowers/specs/2026-06-10-permission-escalation-design.md).
```

And update the Status line to mention escalation as implemented for claude.

- [ ] **Step 4: Commit**

```bash
git add examples/escalation-demo.js README.md
git commit -m "docs: escalation demo workflow and readme"
```

---

### Task 12: Final verification

- [ ] **Step 1: Full suite, build**

Run: `pnpm test && pnpm build`
Expected: all green, no type errors.

- [ ] **Step 2: Update the spec status**

In `docs/superpowers/specs/2026-06-10-permission-escalation-design.md`,
change `Status: **approved** (2026-06-10)` to
`Status: **implemented** (claude + agentbus; codex/slack are V2)`.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-06-10-permission-escalation-design.md
git commit -m "docs: mark escalation spec implemented"
```

- [ ] **Step 4: Merge readiness**

All tests pass, build passes — follow the repo's merge-commit convention
(see user CLAUDE.md: merge commits only) when integrating
`feat/permission-escalation` into `main`.

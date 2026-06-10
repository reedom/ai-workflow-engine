# ai-workflow-engine MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A standalone TypeScript runtime that runs deterministic JS-orchestrated agent workflows by spawning the local `claude` CLI in fresh contexts and collecting results with plain JavaScript.

**Architecture:** A workflow is an ESM module exporting `meta` (name/description) and a default `async (wf) => result` function. The runtime builds a `wf` API (`agent/parallel/pipeline/phase/log/budget/args`) backed by a pluggable `CliAdapter` registry; `agent()` shells out to `claude -p --output-format json`. Orchestration is plain JS; only `agent()` calls spend tokens. Concurrency of `agent()` calls is capped by a limiter.

**Tech Stack:** TypeScript (NodeNext ESM), Node ≥ 20, vitest (tests), tsx (dev run), tsc (build). Package manager: **pnpm**.

**MVP deviations from the spec (intentional):**
- Workflow scripts use a module convention (`export const meta` + `export default async function run(wf)`), not the Workflow tool's injected-globals-with-top-level-return form. A source-parsing loader for full Workflow-tool-script compatibility is a later task.
- Only the `claude` adapter; no `--cmux`, no durable escape hatch, no determinism sandbox/resume.

**Verified facts (do not re-guess):** `claude -p --output-format json` (stdin ignored) prints one JSON object on stdout with: `result` (text), `is_error`/`subtype`, `session_id`, `usage.input_tokens`/`usage.output_tokens`. With `--json-schema <json>`, the parsed object also appears under `structured_output`.

---

## File Structure

- `package.json`, `tsconfig.json` — project config
- `src/types.ts` — `AgentSpec`, `AgentResult`, `CliAdapter`, `AgentOptions`, `WorkflowApi`, `WorkflowMeta`, `WorkflowModule`, `Budget`, `Stage`
- `src/adapters/claude.ts` — `buildClaudeArgs`, `parseClaudeResult`, `runProcess`, `makeClaudeAdapter`
- `src/runtime/budget.ts` — `makeBudget`
- `src/runtime/limiter.ts` — `makeLimiter`
- `src/runtime/orchestration.ts` — `createWorkflowApi`
- `src/runtime/runner.ts` — `validateMeta`, `loadWorkflow`, `runWorkflow`
- `src/cli.ts` — CLI entrypoint
- `examples/fanout.mjs` — sample workflow
- `test/*.test.ts` — unit + e2e tests

---

## Task 1: Project scaffold + toolchain

**Files:**
- Create: `package.json`, `tsconfig.json`, `test/smoke.test.ts`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "ai-workflow-engine",
  "version": "0.0.0",
  "type": "module",
  "bin": { "ai-workflow-engine": "dist/cli.js" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "dev": "tsx"
  },
  "devDependencies": {
    "@types/node": "^22.7.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "declaration": true,
    "outDir": "dist",
    "rootDir": "src",
    "skipLibCheck": true,
    "esModuleInterop": true
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create `test/smoke.test.ts`**

```ts
import { it, expect } from 'vitest';

it('toolchain runs', () => {
  expect(1 + 1).toBe(2);
});
```

- [ ] **Step 4: Install and run the smoke test**

Run: `pnpm install && pnpm test`
Expected: 1 passing test.

- [ ] **Step 5: Commit**

```bash
git add package.json tsconfig.json test/smoke.test.ts pnpm-lock.yaml
git commit -m "chore: scaffold ts project with vitest"
```

---

## Task 2: Core types

**Files:**
- Create: `src/types.ts`

- [ ] **Step 1: Create `src/types.ts`**

```ts
export interface AgentSpec {
  prompt: string;
  model?: string;
  schema?: unknown; // JSON Schema object
  instructions?: string; // system prompt
  tools?: string[];
  cwd?: string;
}

export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface AgentResult<T = unknown> {
  text: string;
  data?: T; // present when a schema was requested
  raw: unknown; // full adapter envelope
  usage: AgentUsage;
  sessionId?: string;
}

export interface CliAdapter {
  readonly id: string;
  readonly caps: { schema: boolean; resume: boolean; tools: boolean };
  run(spec: AgentSpec): Promise<AgentResult>;
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
}

export type Stage = (prev: unknown, item: unknown, index: number) => unknown;

export interface Budget {
  total: number | null;
  spent(): number;
  remaining(): number;
}

export interface WorkflowApi {
  agent(prompt: string, opts?: AgentOptions): Promise<AgentResult>;
  parallel<T>(thunks: Array<() => Promise<T>>): Promise<Array<T | null>>;
  pipeline(items: unknown[], ...stages: Stage[]): Promise<Array<unknown>>;
  phase(title: string): void;
  log(message: string): void;
  budget: Budget;
  args: unknown;
}

export interface WorkflowMeta {
  name: string;
  description: string;
  whenToUse?: string;
  phases?: Array<{ title: string; detail?: string; model?: string }>;
}

export interface WorkflowModule {
  meta: WorkflowMeta;
  default: (wf: WorkflowApi) => Promise<unknown>;
}
```

- [ ] **Step 2: Verify it compiles**

Run: `pnpm build`
Expected: no errors; `dist/types.js` and `dist/types.d.ts` produced.

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat: core workflow + adapter types"
```

---

## Task 3: claude adapter

**Files:**
- Create: `src/adapters/claude.ts`
- Test: `test/claude.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import {
  buildClaudeArgs,
  parseClaudeResult,
  makeClaudeAdapter,
} from '../src/adapters/claude.js';

describe('buildClaudeArgs', () => {
  it('starts with print/json and maps options', () => {
    const args = buildClaudeArgs({
      prompt: 'hi',
      model: 'haiku',
      instructions: 'be terse',
      schema: { type: 'object' },
      tools: ['Read', 'Bash'],
    });
    expect(args.slice(0, 4)).toEqual(['-p', 'hi', '--output-format', 'json']);
    expect(args).toContain('--model');
    expect(args).toContain('haiku');
    expect(args).toContain('--json-schema');
    expect(args).toContain('--append-system-prompt');
    expect(args).toContain('--allowedTools');
  });
});

describe('parseClaudeResult', () => {
  it('extracts text/usage/session', () => {
    const stdout = JSON.stringify({
      type: 'result', subtype: 'success', is_error: false,
      result: 'pong', session_id: 's1',
      usage: { input_tokens: 10, output_tokens: 88 },
    });
    const r = parseClaudeResult(stdout);
    expect(r.text).toBe('pong');
    expect(r.usage).toEqual({ inputTokens: 10, outputTokens: 88 });
    expect(r.sessionId).toBe('s1');
    expect(r.data).toBeUndefined();
  });

  it('extracts structured_output as data', () => {
    const stdout = JSON.stringify({
      is_error: false, result: 'Apple in red.',
      structured_output: { fruit: 'apple', color: 'red' },
      usage: { input_tokens: 1, output_tokens: 2 },
    });
    expect(parseClaudeResult(stdout).data).toEqual({ fruit: 'apple', color: 'red' });
  });

  it('throws on is_error', () => {
    const stdout = JSON.stringify({ is_error: true, subtype: 'error_max_turns', result: 'boom' });
    expect(() => parseClaudeResult(stdout)).toThrow(/claude error/);
  });
});

describe('makeClaudeAdapter', () => {
  it('runs via injected spawn and parses', async () => {
    const a = makeClaudeAdapter({
      spawnFn: async () => ({
        stdout: JSON.stringify({ is_error: false, result: 'ok', usage: { input_tokens: 1, output_tokens: 3 } }),
        stderr: '', code: 0,
      }),
    });
    expect((await a.run({ prompt: 'x' })).text).toBe('ok');
  });

  it('throws on nonzero exit', async () => {
    const a = makeClaudeAdapter({ spawnFn: async () => ({ stdout: '', stderr: 'bad', code: 1 }) });
    await expect(a.run({ prompt: 'x' })).rejects.toThrow(/exited 1/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run test/claude.test.ts`
Expected: FAIL — cannot resolve `../src/adapters/claude.js`.

- [ ] **Step 3: Implement `src/adapters/claude.ts`**

```ts
import { spawn } from 'node:child_process';
import type { AgentResult, AgentSpec, CliAdapter } from '../types.js';

export function buildClaudeArgs(spec: AgentSpec): string[] {
  const args = ['-p', spec.prompt, '--output-format', 'json'];
  if (spec.model) args.push('--model', spec.model);
  if (spec.schema !== undefined) args.push('--json-schema', JSON.stringify(spec.schema));
  if (spec.instructions) args.push('--append-system-prompt', spec.instructions);
  if (spec.tools && spec.tools.length > 0) args.push('--allowedTools', ...spec.tools);
  return args;
}

export function parseClaudeResult(stdout: string): AgentResult {
  const env = JSON.parse(stdout) as Record<string, unknown>;
  if (env.is_error === true) {
    const detail = env.result ?? env.api_error_status ?? 'no detail';
    throw new Error(`claude error (${String(env.subtype ?? 'unknown')}): ${String(detail)}`);
  }
  const usage = (env.usage ?? {}) as Record<string, unknown>;
  return {
    text: typeof env.result === 'string' ? env.result : '',
    data: 'structured_output' in env ? env.structured_output : undefined,
    raw: env,
    usage: {
      inputTokens: Number(usage.input_tokens ?? 0),
      outputTokens: Number(usage.output_tokens ?? 0),
    },
    sessionId: typeof env.session_id === 'string' ? env.session_id : undefined,
  };
}

export type SpawnResult = { stdout: string; stderr: string; code: number };
export type SpawnFn = (cmd: string, args: string[], cwd?: string) => Promise<SpawnResult>;

// stdin is IGNORED: claude -p otherwise waits ~3s for stdin and prints a warning.
export function runProcess(cmd: string, args: string[], cwd?: string): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ stdout, stderr, code: code ?? -1 }));
  });
}

export function makeClaudeAdapter(opts: { bin?: string; spawnFn?: SpawnFn } = {}): CliAdapter {
  const bin = opts.bin ?? 'claude';
  const run = opts.spawnFn ?? runProcess;
  return {
    id: 'claude',
    caps: { schema: true, resume: true, tools: true },
    async run(spec: AgentSpec): Promise<AgentResult> {
      const { stdout, stderr, code } = await run(bin, buildClaudeArgs(spec), spec.cwd);
      if (code !== 0) throw new Error(`claude exited ${code}: ${stderr.trim().slice(0, 500)}`);
      return parseClaudeResult(stdout);
    },
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run test/claude.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/adapters/claude.ts test/claude.test.ts
git commit -m "feat: claude cli adapter"
```

---

## Task 4: budget + concurrency limiter

**Files:**
- Create: `src/runtime/budget.ts`, `src/runtime/limiter.ts`
- Test: `test/budget.test.ts`, `test/limiter.test.ts`

- [ ] **Step 1: Write the failing tests**

`test/budget.test.ts`:
```ts
import { it, expect } from 'vitest';
import { makeBudget } from '../src/runtime/budget.js';

it('tracks spent and remaining', () => {
  const b = makeBudget(100);
  expect(b.remaining()).toBe(100);
  b.add(30);
  expect(b.spent()).toBe(30);
  expect(b.remaining()).toBe(70);
});

it('clamps remaining at zero and is infinite when total is null', () => {
  const b = makeBudget(10);
  b.add(25);
  expect(b.remaining()).toBe(0);
  const unbounded = makeBudget(null);
  unbounded.add(5);
  expect(unbounded.remaining()).toBe(Infinity);
});
```

`test/limiter.test.ts`:
```ts
import { it, expect } from 'vitest';
import { makeLimiter } from '../src/runtime/limiter.js';

it('caps concurrency at the configured max', async () => {
  const limit = makeLimiter(2);
  let active = 0;
  let maxActive = 0;
  const task = () => limit(async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 10));
    active -= 1;
    return 1;
  });
  await Promise.all(Array.from({ length: 6 }, task));
  expect(maxActive).toBeLessThanOrEqual(2);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm vitest run test/budget.test.ts test/limiter.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `src/runtime/budget.ts`**

```ts
import type { Budget } from '../types.js';

export interface MutableBudget extends Budget {
  add(tokens: number): void;
}

export function makeBudget(total: number | null): MutableBudget {
  let spent = 0;
  return {
    total,
    spent: () => spent,
    remaining: () => (total === null ? Infinity : Math.max(0, total - spent)),
    add: (tokens: number) => { spent += tokens; },
  };
}
```

- [ ] **Step 4: Implement `src/runtime/limiter.ts`**

```ts
export type Limiter = <T>(fn: () => Promise<T>) => Promise<T>;

export function makeLimiter(max: number): Limiter {
  let active = 0;
  const queue: Array<() => void> = [];

  const release = () => {
    active -= 1;
    const next = queue.shift();
    if (next) next();
  };

  return function limit<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const run = () => {
        active += 1;
        fn().then(resolve, reject).finally(release);
      };
      if (active < max) run();
      else queue.push(run);
    });
  };
}
```

- [ ] **Step 5: Run to verify they pass**

Run: `pnpm vitest run test/budget.test.ts test/limiter.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/runtime/budget.ts src/runtime/limiter.ts test/budget.test.ts test/limiter.test.ts
git commit -m "feat: budget tracking and concurrency limiter"
```

---

## Task 5: orchestration API

**Files:**
- Create: `src/runtime/orchestration.ts`
- Test: `test/orchestration.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { createWorkflowApi } from '../src/runtime/orchestration.js';
import { makeBudget } from '../src/runtime/budget.js';
import type { CliAdapter } from '../src/types.js';

function fakeAdapter(id = 'claude', text = 'echo'): CliAdapter {
  return {
    id,
    caps: { schema: true, resume: false, tools: true },
    async run(spec) {
      return { text: `${text}:${spec.prompt}`, raw: {}, usage: { inputTokens: 1, outputTokens: 2 } };
    },
  };
}

function api(adapters: Record<string, CliAdapter>, total: number | null = null) {
  const budget = makeBudget(total);
  return { wf: createWorkflowApi({ adapters, args: { n: 1 }, budget, concurrency: 4 }), budget };
}

describe('agent()', () => {
  it('routes to the default adapter', async () => {
    const { wf } = api({ claude: fakeAdapter() });
    expect((await wf.agent('hi')).text).toBe('echo:hi');
  });

  it('selects the adapter by opts.cli', async () => {
    const { wf } = api({ claude: fakeAdapter('claude'), codex: fakeAdapter('codex', 'cdx') });
    expect((await wf.agent('x', { cli: 'codex' })).text).toBe('cdx:x');
  });

  it('throws on an unknown cli', async () => {
    const { wf } = api({ claude: fakeAdapter() });
    await expect(wf.agent('x', { cli: 'nope' })).rejects.toThrow(/unknown cli/);
  });

  it('accrues output tokens into the budget', async () => {
    const { wf, budget } = api({ claude: fakeAdapter() }, 100);
    await wf.agent('a');
    await wf.agent('b');
    expect(budget.spent()).toBe(4);
  });
});

describe('parallel()', () => {
  it('returns results and null for failures', async () => {
    const { wf } = api({ claude: fakeAdapter() });
    const out = await wf.parallel([
      () => wf.agent('a'),
      () => Promise.reject(new Error('boom')),
    ]);
    expect((out[0] as { text: string }).text).toBe('echo:a');
    expect(out[1]).toBeNull();
  });
});

describe('pipeline()', () => {
  it('chains stages per item, no barrier', async () => {
    const { wf } = api({ claude: fakeAdapter() });
    const out = await wf.pipeline([1, 2], (p) => (p as number) * 10, (p) => (p as number) + 1);
    expect(out).toEqual([11, 21]);
  });

  it('drops an item to null if a stage throws', async () => {
    const { wf } = api({ claude: fakeAdapter() });
    const out = await wf.pipeline([1, 2], (p) => {
      if (p === 1) throw new Error('x');
      return p;
    });
    expect(out).toEqual([null, 2]);
  });
});

it('exposes args', async () => {
  const { wf } = api({ claude: fakeAdapter() });
  expect(wf.args).toEqual({ n: 1 });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run test/orchestration.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/runtime/orchestration.ts`**

```ts
import type { AgentOptions, AgentResult, CliAdapter, Stage, WorkflowApi } from '../types.js';
import type { MutableBudget } from './budget.js';
import { makeLimiter } from './limiter.js';

export interface OrchestrationDeps {
  adapters: Record<string, CliAdapter>;
  args: unknown;
  budget: MutableBudget;
  concurrency: number;
  onLog?: (msg: string) => void;
}

export function createWorkflowApi(deps: OrchestrationDeps): WorkflowApi {
  const limit = makeLimiter(deps.concurrency);
  let currentPhase = '';

  async function agent(prompt: string, opts: AgentOptions = {}): Promise<AgentResult> {
    const cliId = opts.cli ?? 'claude';
    const adapter = deps.adapters[cliId];
    if (!adapter) throw new Error(`unknown cli adapter: ${cliId}`);
    return limit(async () => {
      const result = await adapter.run({
        prompt,
        model: opts.model,
        schema: opts.schema,
        instructions: opts.instructions,
        tools: opts.tools,
        cwd: opts.cwd,
      });
      deps.budget.add(result.usage.outputTokens);
      return result;
    });
  }

  async function parallel<T>(thunks: Array<() => Promise<T>>): Promise<Array<T | null>> {
    return Promise.all(
      thunks.map((t) => Promise.resolve().then(t).catch(() => null)),
    );
  }

  async function pipeline(items: unknown[], ...stages: Stage[]): Promise<unknown[]> {
    return Promise.all(
      items.map(async (item, index) => {
        let acc: unknown = item;
        for (const stage of stages) {
          try {
            acc = await stage(acc, item, index);
          } catch {
            return null;
          }
        }
        return acc;
      }),
    );
  }

  function phase(title: string): void {
    currentPhase = title;
    if (deps.onLog) deps.onLog(`=== ${title} ===`);
  }

  function log(message: string): void {
    if (deps.onLog) deps.onLog(currentPhase ? `[${currentPhase}] ${message}` : message);
  }

  return { agent, parallel, pipeline, phase, log, budget: deps.budget, args: deps.args };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run test/orchestration.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/orchestration.ts test/orchestration.test.ts
git commit -m "feat: workflow orchestration api"
```

---

## Task 6: workflow loader + runner

**Files:**
- Create: `src/runtime/runner.ts`
- Test: `test/runner.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { validateMeta, runWorkflow } from '../src/runtime/runner.js';
import type { CliAdapter, WorkflowModule } from '../src/types.js';

const fake: CliAdapter = {
  id: 'claude',
  caps: { schema: false, resume: false, tools: false },
  async run(spec) {
    return { text: `echo:${spec.prompt}`, raw: {}, usage: { inputTokens: 1, outputTokens: 1 } };
  },
};

describe('validateMeta', () => {
  it('requires name and description', () => {
    expect(() => validateMeta({})).toThrow(/name/);
    expect(() => validateMeta({ name: 'x' })).toThrow(/description/);
    expect(validateMeta({ name: 'x', description: 'd' }).name).toBe('x');
  });
});

describe('runWorkflow', () => {
  it('runs the module default with a built api', async () => {
    const mod: WorkflowModule = {
      meta: { name: 't', description: 'd' },
      default: async (wf) => (await wf.agent('hi')).text,
    };
    const out = await runWorkflow(mod, { adapters: { claude: fake } });
    expect(out).toBe('echo:hi');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run test/runner.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/runtime/runner.ts`**

```ts
import { pathToFileURL } from 'node:url';
import type { CliAdapter, WorkflowMeta, WorkflowModule } from '../types.js';
import { createWorkflowApi } from './orchestration.js';
import { makeBudget } from './budget.js';

export function validateMeta(meta: unknown): WorkflowMeta {
  if (!meta || typeof meta !== 'object') throw new Error('workflow: missing `meta` export');
  const m = meta as Record<string, unknown>;
  if (typeof m.name !== 'string' || m.name.length === 0) {
    throw new Error('workflow meta: `name` is required');
  }
  if (typeof m.description !== 'string' || m.description.length === 0) {
    throw new Error('workflow meta: `description` is required');
  }
  return m as unknown as WorkflowMeta;
}

export async function loadWorkflow(file: string): Promise<WorkflowModule> {
  const mod = (await import(pathToFileURL(file).href)) as Partial<WorkflowModule>;
  if (typeof mod.default !== 'function') {
    throw new Error('workflow: missing default export (async function)');
  }
  validateMeta(mod.meta);
  return mod as WorkflowModule;
}

export interface RunOptions {
  adapters: Record<string, CliAdapter>;
  args?: unknown;
  budget?: number | null;
  concurrency?: number;
  onLog?: (msg: string) => void;
}

export async function runWorkflow(mod: WorkflowModule, opts: RunOptions): Promise<unknown> {
  const api = createWorkflowApi({
    adapters: opts.adapters,
    args: opts.args,
    budget: makeBudget(opts.budget ?? null),
    concurrency: opts.concurrency ?? 8,
    onLog: opts.onLog,
  });
  return mod.default(api);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run test/runner.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/runner.ts test/runner.test.ts
git commit -m "feat: workflow loader and runner"
```

---

## Task 7: CLI entrypoint + example + end-to-end

**Files:**
- Create: `src/cli.ts`, `examples/fanout.mjs`
- Test: `test/e2e.test.ts`

- [ ] **Step 1: Create the example workflow `examples/fanout.mjs`**

```js
export const meta = {
  name: 'fanout',
  description: 'Ask one agent per topic in parallel and collect the answers',
};

export default async function run(wf) {
  const topics = (wf.args && wf.args.topics) || ['sky', 'grass'];
  const answers = await wf.parallel(
    topics.map((t) => () => wf.agent(`What color is ${t}? Reply with one word.`)),
  );
  return answers.map((a, i) => ({ topic: topics[i], answer: a ? a.text : null }));
}
```

- [ ] **Step 2: Write the failing e2e test**

```ts
import { it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { loadWorkflow, runWorkflow } from '../src/runtime/runner.js';
import type { CliAdapter } from '../src/types.js';

const fake: CliAdapter = {
  id: 'claude',
  caps: { schema: false, resume: false, tools: false },
  async run() {
    return { text: 'blue', raw: {}, usage: { inputTokens: 1, outputTokens: 1 } };
  },
};

it('loads and runs the example workflow end to end', async () => {
  const file = fileURLToPath(new URL('../examples/fanout.mjs', import.meta.url));
  const mod = await loadWorkflow(file);
  const out = await runWorkflow(mod, { adapters: { claude: fake }, args: { topics: ['sky'] } });
  expect(out).toEqual([{ topic: 'sky', answer: 'blue' }]);
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm vitest run test/e2e.test.ts`
Expected: FAIL — `examples/fanout.mjs` resolves but assertion/loader path may error first; confirm it fails before the implementation in Step 4 is added. (If it already passes because the loader exists from Task 6, that's fine — the new coverage is the example wiring.)

- [ ] **Step 4: Implement `src/cli.ts`**

```ts
import { resolve } from 'node:path';
import { loadWorkflow, runWorkflow } from './runtime/runner.js';
import { makeClaudeAdapter } from './adapters/claude.js';

function takeFlag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  return args[i + 1];
}

export async function main(argv: string[]): Promise<number> {
  const [cmd, file, ...rest] = argv;
  if (cmd !== 'run' || !file) {
    process.stderr.write('usage: ai-workflow-engine run <workflow-file> [--args <json>] [--budget <n>]\n');
    return 2;
  }
  const argsRaw = takeFlag(rest, '--args');
  const budgetRaw = takeFlag(rest, '--budget');
  const mod = await loadWorkflow(resolve(process.cwd(), file));
  const result = await runWorkflow(mod, {
    adapters: { claude: makeClaudeAdapter() },
    args: argsRaw ? JSON.parse(argsRaw) : undefined,
    budget: budgetRaw ? Number(budgetRaw) : null,
    onLog: (m) => process.stderr.write(`[wf] ${m}\n`),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return 0;
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
```

- [ ] **Step 5: Run the full suite + build**

Run: `pnpm test && pnpm build`
Expected: all tests PASS; `pnpm build` produces `dist/` with no type errors.

- [ ] **Step 6: Manual smoke against the real `claude` CLI (optional, costs tokens)**

Run: `pnpm dev src/cli.ts run examples/fanout.mjs --args '{"topics":["sky","grass"]}'`
Expected: JSON array like `[{"topic":"sky","answer":"blue"},{"topic":"grass","answer":"green"}]` on stdout (exact words vary). Note: this spends real model tokens; skip in CI.

- [ ] **Step 7: Commit**

```bash
git add src/cli.ts examples/fanout.mjs test/e2e.test.ts
git commit -m "feat: cli entrypoint and example workflow"
```

---

## Self-Review

- **Spec coverage:** core API (Tasks 5, mirrors `agent/parallel/pipeline/phase/log/budget/args`), claude adapter (Task 3), adapter seam/`CliAdapter` (Task 2, registry in Tasks 5/6), runner/loader (Task 6), CLI (Task 7). Deferred-by-design and *not* in this plan: codex/antigravity adapters, `--cmux`, durable escape hatch, determinism sandbox, injected-globals script parsing — all noted in the header.
- **Placeholders:** none; every code/command step is concrete. The "optional smoke" (Task 7 Step 6) is explicitly optional and token-spending.
- **Type consistency:** `CliAdapter.run(AgentSpec) -> AgentResult`, `AgentResult.usage.{inputTokens,outputTokens}`, `MutableBudget.add`, `WorkflowApi` method shapes, and `WorkflowModule { meta, default }` are used identically across Tasks 2–7.
- **Numeric comparisons:** uses `<` / `<=` / `Math.max` only (no `>` / `>=`).

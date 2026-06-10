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

  it('accrues input+output tokens into the budget', async () => {
    const { wf, budget } = api({ claude: fakeAdapter() }, 100);
    await wf.agent('a');
    await wf.agent('b');
    expect(budget.spent()).toBe(6);
  });

  it('throws when the budget is exhausted', async () => {
    const { wf } = api({ claude: fakeAdapter() }, 2);
    await wf.agent('a'); // spends 3, exhausts the budget of 2
    await expect(wf.agent('b')).rejects.toThrow(/budget exhausted/);
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

it('phase/log emit through onLog with a phase prefix', () => {
  const logs: string[] = [];
  const budget = makeBudget(null);
  const wf = createWorkflowApi({ adapters: { claude: fakeAdapter() }, args: null, budget, concurrency: 4, onLog: (m) => logs.push(m) });
  wf.phase('Build');
  wf.log('started');
  expect(logs).toEqual(['=== Build ===', '[Build] started']);
});

it('logs swallowed failures in parallel via onLog', async () => {
  const logs: string[] = [];
  const budget = makeBudget(null);
  const wf = createWorkflowApi({ adapters: { claude: fakeAdapter() }, args: null, budget, concurrency: 4, onLog: (m) => logs.push(m) });
  const out = await wf.parallel([() => Promise.reject(new Error('boom'))]);
  expect(out).toEqual([null]);
  expect(logs.some((l) => l.includes('boom'))).toBe(true);
});

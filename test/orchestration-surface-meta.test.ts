import { describe, expect, it } from 'vitest';
import { createWorkflowApi } from '../src/runtime/orchestration.js';
import { makeBudget } from '../src/runtime/budget.js';
import type { CliAdapter } from '../src/types.js';

function adapter(withMeta: boolean): CliAdapter & { meta: unknown[] } {
  const meta: unknown[] = [];
  const a: any = { id: 'cmux', caps: { schema: true, resume: false, tools: true }, meta,
    run: async () => ({ text: '', raw: null, usage: { inputTokens: 0, outputTokens: 0 } }) };
  if (withMeta) a.setMeta = async (m: unknown) => { meta.push(m); };
  return a;
}

describe('wf.setSurfaceMeta', () => {
  it('routes to an adapter that supports setMeta', async () => {
    const a = adapter(true);
    const wf = createWorkflowApi({ adapters: { cmux: a }, args: {}, budget: makeBudget(null), concurrency: 1 });
    await wf.setSurfaceMeta({ name: 'ABC-1', description: 'title' });
    expect(a.meta).toEqual([{ name: 'ABC-1', description: 'title' }]);
  });

  it('no-ops when no adapter supports setMeta', async () => {
    const a = adapter(false);
    const wf = createWorkflowApi({ adapters: { claude: a }, args: {}, budget: makeBudget(null), concurrency: 1 });
    await expect(wf.setSurfaceMeta({ name: 'ABC-1' })).resolves.toBeUndefined();
    expect(a.meta).toEqual([]);
  });
});

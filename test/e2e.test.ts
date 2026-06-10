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

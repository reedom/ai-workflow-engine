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

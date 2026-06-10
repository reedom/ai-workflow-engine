import { describe, it, expect, vi } from 'vitest';
import { validateMeta, runWorkflow } from '../src/runtime/runner.js';
import type { CliAdapter, WorkflowModule, AgentSpec } from '../src/types.js';
import type { ApprovalChannel } from '../src/escalation/types.js';

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

it('closes the broker even when the workflow throws', async () => {
  const close = vi.fn(async () => {});
  const channel: ApprovalChannel = {
    id: 'fake',
    request: async () => ({ behavior: 'deny' }),
    close,
  };
  const mod = {
    meta: { name: 'wf', description: 'd' },
    default: async () => {
      throw new Error('boom');
    },
  };
  await expect(
    runWorkflow(mod as never, {
      adapters: { claude: captureAdapter([]) },
      escalation: { channel, runId: 'r1' },
    }),
  ).rejects.toThrow('boom');
  expect(close).toHaveBeenCalled();
});

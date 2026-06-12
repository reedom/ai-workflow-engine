// Run-level cwd contract (RunOptions.cwd):
//
//   runWorkflow({ cwd })
//        │
//        ├─► createWorkflowApi deps.cwd ──► agent spawn cwd
//        │      (per-call AgentOptions.cwd wins over the run default)
//        │
//        └─► loadSettingsDeferRules(cwd) ──► permission defer rules
//               (no cwd given ──► process.cwd(), the original CLI behavior)
import { describe, it, expect, vi } from 'vitest';
import { runWorkflow } from '../src/runtime/runner.js';
import type { ApprovalChannel } from '../src/escalation/types.js';
import type { AgentSpec, CliAdapter, WorkflowModule } from '../src/types.js';

vi.mock('../src/escalation/rules.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/escalation/rules.js')>();
  return { ...real, loadSettingsDeferRules: vi.fn(real.loadSettingsDeferRules) };
});
import { loadSettingsDeferRules } from '../src/escalation/rules.js';

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

function mod(body: WorkflowModule['default']): WorkflowModule {
  return { meta: { name: 'wf', description: 'd' }, default: body };
}

const idleChannel: ApprovalChannel = {
  id: 'fake',
  request: async () => ({ behavior: 'deny' }),
};

describe('agent spawn cwd', () => {
  it('defaults to the run-level cwd', async () => {
    const specs: AgentSpec[] = [];
    await runWorkflow(mod(async (wf) => wf.agent('work')), {
      adapters: { claude: captureAdapter(specs) },
      cwd: '/target/repo',
    });
    expect(specs[0]?.cwd).toBe('/target/repo');
  });

  it('lets a per-call cwd win over the run default', async () => {
    const specs: AgentSpec[] = [];
    await runWorkflow(mod(async (wf) => wf.agent('work', { cwd: '/other/repo' })), {
      adapters: { claude: captureAdapter(specs) },
      cwd: '/target/repo',
    });
    expect(specs[0]?.cwd).toBe('/other/repo');
  });

  it('stays undefined when neither is set', async () => {
    const specs: AgentSpec[] = [];
    await runWorkflow(mod(async (wf) => wf.agent('work')), {
      adapters: { claude: captureAdapter(specs) },
    });
    expect(specs[0]?.cwd).toBeUndefined();
  });
});

describe('defer-rule cwd', () => {
  it('resolves settings defer rules from the run-level cwd', async () => {
    vi.mocked(loadSettingsDeferRules).mockClear();
    await runWorkflow(mod(async (wf) => wf.agent('work')), {
      adapters: { claude: captureAdapter([]) },
      cwd: '/target/repo',
      escalation: { channel: idleChannel, runId: 'r1' },
    });
    expect(loadSettingsDeferRules).toHaveBeenCalledWith('/target/repo');
  });

  // CRITICAL regression: the CLI passes no cwd and must keep resolving
  // defer rules from the engine process's working directory.
  it('falls back to process.cwd() when no cwd is given', async () => {
    vi.mocked(loadSettingsDeferRules).mockClear();
    await runWorkflow(mod(async (wf) => wf.agent('work')), {
      adapters: { claude: captureAdapter([]) },
      escalation: { channel: idleChannel, runId: 'r1' },
    });
    expect(loadSettingsDeferRules).toHaveBeenCalledWith(process.cwd());
  });
});

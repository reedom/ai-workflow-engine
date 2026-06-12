// Run-level cwd contract (RunOptions.cwd):
//
//   runWorkflow({ cwd })          — validated: must be an existing directory
//        │
//        ├─► createWorkflowApi deps.cwd ──► agent spawn cwd
//        │      (per-call AgentOptions.cwd wins; a RELATIVE per-call cwd
//        │       resolves against the run cwd, never at spawn time;
//        │       empty string counts as unset)
//        │
//        └─► loadSettingsDeferRules(cwd) ──► permission defer rules
//               (no cwd given ──► process.cwd(), the original CLI behavior)
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { runWorkflow } from '../src/runtime/runner.js';
import type { ApprovalChannel } from '../src/escalation/types.js';
import type { AgentSpec, CliAdapter, WorkflowModule } from '../src/types.js';

// Stubbed (not wrapped): the real implementations read the host's
// ~/.claude/settings.json, which would make these tests environment-dependent.
vi.mock('../src/escalation/rules.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/escalation/rules.js')>();
  return {
    ...real,
    loadHomeDeferRules: vi.fn(() => []),
    loadProjectDeferRules: vi.fn(() => []),
  };
});
import { loadProjectDeferRules } from '../src/escalation/rules.js';

let runDir: string;
beforeAll(() => {
  runDir = mkdtempSync(join(tmpdir(), 'awe-cwd-test-'));
});
afterAll(() => {
  rmSync(runDir, { recursive: true, force: true });
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

function mod(body: WorkflowModule['default']): WorkflowModule {
  return { meta: { name: 'wf', description: 'd' }, default: body };
}

async function runAgent(opts: { runCwd?: string; callCwd?: string }): Promise<string | undefined> {
  const specs: AgentSpec[] = [];
  const agentOpts = opts.callCwd === undefined ? {} : { cwd: opts.callCwd };
  await runWorkflow(mod(async (wf) => wf.agent('work', agentOpts)), {
    adapters: { claude: captureAdapter(specs) },
    cwd: opts.runCwd,
  });
  return specs[0]?.cwd;
}

const idleChannel: ApprovalChannel = {
  id: 'fake',
  request: async () => ({ behavior: 'deny' }),
};

describe('agent spawn cwd', () => {
  it('defaults to the run-level cwd', async () => {
    expect(await runAgent({ runCwd: runDir })).toBe(runDir);
  });

  it('lets an absolute per-call cwd win over the run default', async () => {
    expect(await runAgent({ runCwd: runDir, callCwd: '/other/repo' })).toBe('/other/repo');
  });

  it('resolves a relative per-call cwd against the run cwd', async () => {
    expect(await runAgent({ runCwd: runDir, callCwd: 'sub/dir' })).toBe(join(runDir, 'sub/dir'));
  });

  it('treats an empty-string per-call cwd as unset', async () => {
    expect(await runAgent({ runCwd: runDir, callCwd: '' })).toBe(runDir);
  });

  it('stays undefined when neither is set', async () => {
    expect(await runAgent({})).toBeUndefined();
  });

  it('pins a per-call-only cwd at call time, not spawn time', async () => {
    expect(await runAgent({ callCwd: 'rel/path' })).toBe(resolve('rel/path'));
  });
});

describe('run cwd validation', () => {
  it('fails fast when the run cwd does not exist', async () => {
    await expect(runAgent({ runCwd: join(runDir, 'no-such-dir') })).rejects.toThrow(
      /run cwd is not a directory/,
    );
  });
});

describe('defer-rule cwd', () => {
  it('resolves project defer rules from the run-level cwd', async () => {
    vi.mocked(loadProjectDeferRules).mockClear();
    await runWorkflow(mod(async (wf) => wf.agent('work')), {
      adapters: { claude: captureAdapter([]) },
      cwd: runDir,
      escalation: { channel: idleChannel, runId: 'r1' },
    });
    expect(loadProjectDeferRules).toHaveBeenCalledWith(runDir);
  });

  // CRITICAL regression: the CLI passes no cwd and must keep resolving
  // defer rules from the engine process's working directory.
  it('falls back to process.cwd() when no cwd is given', async () => {
    vi.mocked(loadProjectDeferRules).mockClear();
    await runWorkflow(mod(async (wf) => wf.agent('work')), {
      adapters: { claude: captureAdapter([]) },
      escalation: { channel: idleChannel, runId: 'r1' },
    });
    expect(loadProjectDeferRules).toHaveBeenCalledWith(process.cwd());
  });

  it('skips project rules entirely when trustCwdSettings is false', async () => {
    vi.mocked(loadProjectDeferRules).mockClear();
    await runWorkflow(mod(async (wf) => wf.agent('work')), {
      adapters: { claude: captureAdapter([]) },
      cwd: runDir,
      escalation: { channel: idleChannel, runId: 'r1', trustCwdSettings: false },
    });
    expect(loadProjectDeferRules).not.toHaveBeenCalled();
  });
});

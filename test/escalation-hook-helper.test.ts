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
  hook_event_name: 'PermissionRequest',
  tool_name: 'Bash',
  tool_input: { command: 'rm -rf build' },
  cwd: '/work',
});

it('prints a PermissionRequest allow decision', async () => {
  const { broker, metaPath } = setup('allow');
  await broker.start();
  try {
    const out = await runHookHelper(['--socket', broker.socketPath, '--meta', metaPath], hookStdin);
    expect(out).not.toBeNull();
    expect(JSON.parse(out as string)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'allow' },
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
      hookSpecificOutput: { decision: { behavior: string } };
    };
    expect(parsed.hookSpecificOutput.decision.behavior).toBe('deny');
  } finally {
    await broker.close();
  }
});

// PermissionRequest only fires when Claude would prompt; there is no interactive
// fallback on a headless surface, so a broker `defer` (tool matches an allow rule)
// must resolve to an explicit allow — NOT silence, which would fall through to a
// non-existent prompt and effectively deny a rule-allowlisted tool.
it('emits an explicit allow for deferred (rule-matched) calls', async () => {
  const { broker, metaPath } = setup('deny');
  await broker.start();
  try {
    const readStdin = JSON.stringify({ tool_name: 'Read', tool_input: { file_path: '/x' } });
    const out = await runHookHelper(['--socket', broker.socketPath, '--meta', metaPath], readStdin);
    expect(JSON.parse(out as string)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'allow' },
      },
    });
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

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

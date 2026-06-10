import { it, expect, vi } from 'vitest';
import { makeAgentbusChannel, parseAskStdout } from '../src/escalation/channels/agentbus.js';
import type { SpawnFn } from '../src/adapters/claude.js';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const askStdout = JSON.stringify({
  request_id: 'msg_01X',
  payload: { behavior: 'allow', reason: 'go ahead' },
});

const req = {
  runId: 'r1',
  agentLabel: 'worker',
  cli: 'claude',
  toolName: 'Bash',
  toolInput: { command: 'rm -rf build' },
  policy: { timeoutMs: 60_000, onTimeout: 'deny' as const },
};

it('asks with from/timeout flags and parses the allow reply envelope', async () => {
  const calls: string[][] = [];
  const spawnFn: SpawnFn = async (_cmd, args) => {
    calls.push(args);
    return { stdout: `${askStdout}\n`, stderr: '', code: 0 };
  };
  const channel = makeAgentbusChannel({ to: 'tohru', runId: 'r1', spawnFn });
  const d = await channel.request(req);
  expect(d).toEqual({ behavior: 'allow', reason: 'go ahead' });
  const ask = calls[0];
  expect(ask[0]).toBe('ask');
  expect(ask[1]).toBe('tohru');
  expect(ask).toContain('--from');
  expect(ask).toContain('ext:awe-r1');
  expect(ask).toContain('--timeout-ms');
  expect(ask).toContain('60000');
});

it('uses a very large ask timeout when onTimeout is wait', async () => {
  const calls: string[][] = [];
  const spawnFn: SpawnFn = async (_cmd, args) => {
    calls.push(args);
    return { stdout: askStdout, stderr: '', code: 0 };
  };
  const channel = makeAgentbusChannel({ to: 'tohru', runId: 'r1', spawnFn });
  await channel.request({ ...req, policy: { timeoutMs: 1_000, onTimeout: 'wait' } });
  const i = calls[0].indexOf('--timeout-ms');
  expect(86_400_000 <= Number(calls[0][i + 1])).toBe(true);
});

it('treats anything but an explicit allow as deny', () => {
  expect(parseAskStdout('{"request_id":"m","payload":{"behavior":"deny","reason":"no"}}')).toEqual({
    behavior: 'deny',
    reason: 'no',
  });
  expect(parseAskStdout('{"request_id":"m","payload":{"behavior":"yes"}}').behavior).toBe('deny');
  expect(parseAskStdout('garbage').behavior).toBe('deny');
});

it('throws when ask fails (e.g. timeout exit 2) so the broker applies its policy', async () => {
  const spawnFn: SpawnFn = async () => ({
    stdout: '',
    stderr: 'error[timeout]: no reply within 60000 ms',
    code: 2,
  });
  const channel = makeAgentbusChannel({ to: 'ghost', runId: 'r1', spawnFn });
  await expect(channel.request(req)).rejects.toThrow(/agentbus ask failed/);
});

const hasAgentbus = await new Promise<boolean>((resolve) => {
  const p = spawn('agentbus', ['--version']);
  p.on('error', () => resolve(false));
  p.on('close', (code) => resolve(code === 0));
});

it.skipIf(!hasAgentbus)('round-trips through a real agentbus store', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'awe-bus-'));
  const env = { ...process.env, AGENTBUS_DIR: dir };
  const sh = (args: string[], input?: string) =>
    new Promise<{ stdout: string; code: number }>((resolve) => {
      const p = spawn('agentbus', args, { env });
      let stdout = '';
      p.stdout.on('data', (d) => (stdout += d));
      if (input !== undefined) p.stdin.end(input);
      p.on('close', (code) => resolve({ stdout, code: code ?? -1 }));
    });

  await sh(['register', 'human', '--persistent']);
  // Scripted replier: poll the inbox for the ask envelope, then reply allow.
  const replier = (async () => {
    for (let i = 0; i < 100; i += 1) {
      const inbox = await sh(['check-inbox', 'human']);
      const parsed = JSON.parse(inbox.stdout || '{"envelopes":[]}') as {
        envelopes: Array<{ id: string; kind: string }>;
      };
      const ask = parsed.envelopes.find((e) => e.kind === 'ask');
      if (ask) {
        await sh(['reply', ask.id, 'human'], '{"behavior":"allow","reason":"itest"}');
        return;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('no ask arrived');
  })();

  const channel = makeAgentbusChannel({
    to: 'human',
    runId: 'itest',
    spawnFn: (cmd, args) =>
      new Promise((resolve) => {
        const p = spawn(cmd, args, { env });
        let stdout = '';
        let stderr = '';
        p.stdout.on('data', (d) => (stdout += d));
        p.stderr.on('data', (d) => (stderr += d));
        p.on('close', (code) => resolve({ stdout, stderr, code: code ?? -1 }));
      }),
  });
  const [decision] = await Promise.all([
    channel.request({
      runId: 'itest',
      agentLabel: 'w',
      cli: 'claude',
      toolName: 'Bash',
      toolInput: { command: 'x' },
      policy: { timeoutMs: 15_000, onTimeout: 'deny' },
    }),
    replier,
  ]);
  expect(decision.behavior).toBe('allow');
}, 20_000);

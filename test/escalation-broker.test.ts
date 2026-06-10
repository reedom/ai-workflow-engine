// test/escalation-broker.test.ts
import { it, expect, vi } from 'vitest';
import { connect } from 'node:net';
import { EscalationBroker } from '../src/escalation/broker.js';
import type { ApprovalChannel, BrokerDecision, PermissionRequest } from '../src/escalation/types.js';

function req(over: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    runId: 'r1',
    agentLabel: 'worker',
    cli: 'claude',
    toolName: 'Bash',
    toolInput: { command: 'rm -rf build' },
    ...over,
  };
}

function fakeChannel(impl: ApprovalChannel['request']): ApprovalChannel {
  return { id: 'fake', request: impl };
}

it('defers calls matching per-call rules without touching the channel', async () => {
  const request = vi.fn();
  const broker = new EscalationBroker({ runId: 'r1', channel: fakeChannel(request) });
  const d = await broker.decide(req({ rules: ['Bash(rm -rf:*)'] }));
  expect(d.behavior).toBe('defer');
  expect(request).not.toHaveBeenCalled();
});

it('defers calls matching settings rules', async () => {
  const request = vi.fn();
  const broker = new EscalationBroker({
    runId: 'r1',
    channel: fakeChannel(request),
    settingsRules: ['Bash(rm -rf:*)'],
  });
  const d = await broker.decide(req());
  expect(d.behavior).toBe('defer');
  expect(request).not.toHaveBeenCalled();
});

it('escalates unmatched calls and returns the channel decision', async () => {
  const broker = new EscalationBroker({
    runId: 'r1',
    channel: fakeChannel(async () => ({ behavior: 'allow', reason: 'ok' })),
  });
  const d = await broker.decide(req());
  expect(d).toEqual({ behavior: 'allow', reason: 'ok' });
});

it('denies on timeout when onTimeout is deny', async () => {
  const broker = new EscalationBroker({
    runId: 'r1',
    channel: fakeChannel(() => new Promise(() => {})), // never answers
  });
  const d = await broker.decide(req({ policy: { timeoutMs: 20, onTimeout: 'deny' } }));
  expect(d.behavior).toBe('deny');
  expect(d.reason).toBe('escalation timeout');
});

it('keeps waiting past timeoutMs when onTimeout is wait', async () => {
  const broker = new EscalationBroker({
    runId: 'r1',
    channel: fakeChannel(
      () => new Promise((resolve) => setTimeout(() => resolve({ behavior: 'allow' }), 60)),
    ),
  });
  const d = await broker.decide(req({ policy: { timeoutMs: 10, onTimeout: 'wait' } }));
  expect(d.behavior).toBe('allow');
});

it('denies when the channel throws', async () => {
  const broker = new EscalationBroker({
    runId: 'r1',
    channel: fakeChannel(async () => {
      throw new Error('bus down');
    }),
  });
  const d = await broker.decide(req());
  expect(d.behavior).toBe('deny');
  expect(d.reason).toContain('bus down');
});

it('denies in-flight requests on close and calls channel.close', async () => {
  const close = vi.fn(async () => {});
  const broker = new EscalationBroker({
    runId: 'r1',
    channel: { id: 'fake', request: () => new Promise(() => {}), close },
  });
  const pending = broker.decide(req({ policy: { timeoutMs: 60_000, onTimeout: 'wait' } }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  await broker.close();
  const d = await pending;
  expect(d).toEqual({ behavior: 'deny', reason: 'run shutdown' });
  expect(close).toHaveBeenCalled();
});

it('logs escalations and decisions', async () => {
  const lines: string[] = [];
  const broker = new EscalationBroker({
    runId: 'r1',
    channel: fakeChannel(async () => ({ behavior: 'deny', reason: 'nope' })),
    log: (m) => lines.push(m),
  });
  await broker.decide(req());
  expect(lines.some((l) => l.includes('escalating') && l.includes('worker'))).toBe(true);
  expect(lines.some((l) => l.includes('deny'))).toBe(true);
});

function roundTrip(socketPath: string, payload: string): Promise<BrokerDecision> {
  return new Promise((resolve, reject) => {
    const sock = connect(socketPath, () => sock.write(`${payload}\n`));
    let buf = '';
    sock.on('data', (d) => {
      buf += d;
      const nl = buf.indexOf('\n');
      if (0 <= nl) {
        sock.end();
        resolve(JSON.parse(buf.slice(0, nl)) as BrokerDecision);
      }
    });
    sock.on('error', reject);
  });
}

it('serves decisions over its unix socket', async () => {
  const broker = new EscalationBroker({
    runId: 'r1',
    channel: fakeChannel(async () => ({ behavior: 'allow', reason: 'remote ok' })),
  });
  await broker.start();
  try {
    const d = await roundTrip(broker.socketPath, JSON.stringify(req()));
    expect(d).toEqual({ behavior: 'allow', reason: 'remote ok' });
    const deferred = await roundTrip(
      broker.socketPath,
      JSON.stringify(req({ rules: ['Bash(rm -rf:*)'] })),
    );
    expect(deferred.behavior).toBe('defer');
  } finally {
    await broker.close();
  }
});

it('answers deny to malformed socket requests', async () => {
  const broker = new EscalationBroker({ runId: 'r1', channel: fakeChannel(vi.fn()) });
  await broker.start();
  try {
    const d = await roundTrip(broker.socketPath, 'not json');
    expect(d.behavior).toBe('deny');
  } finally {
    await broker.close();
  }
});

it('denies decide() calls after close', async () => {
  const broker = new EscalationBroker({
    runId: 'r1',
    channel: fakeChannel(async () => ({ behavior: 'allow' })),
  });
  await broker.close();
  const d = await broker.decide(req());
  expect(d).toEqual({ behavior: 'deny', reason: 'run shutdown' });
});

it('answers only the first line per connection', async () => {
  const request = vi.fn(async () => ({ behavior: 'allow' as const }));
  const broker = new EscalationBroker({ runId: 'r1', channel: fakeChannel(request) });
  await broker.start();
  try {
    const replies = await new Promise<string>((resolve, reject) => {
      const sock = connect(broker.socketPath, () => {
        sock.write(`${JSON.stringify(req())}\n`);
        setTimeout(() => sock.write(`${JSON.stringify(req())}\n`), 20);
      });
      let buf = '';
      sock.on('data', (d) => {
        buf += d;
      });
      sock.on('end', () => resolve(buf));
      sock.on('error', reject);
      setTimeout(() => sock.end(), 100);
    });
    expect(replies.trim().split('\n')).toHaveLength(1);
    expect(request).toHaveBeenCalledTimes(1);
  } finally {
    await broker.close();
  }
});

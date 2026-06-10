// test/escalation-broker.test.ts
import { it, expect, vi } from 'vitest';
import { EscalationBroker } from '../src/escalation/broker.js';
import type { ApprovalChannel, PermissionRequest } from '../src/escalation/types.js';

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

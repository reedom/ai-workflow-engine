// src/escalation/broker.ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server, type Socket } from 'node:net';
import type {
  ApprovalChannel,
  BrokerDecision,
  EscalationPolicy,
  PermissionRequest,
} from './types.js';
import { DEFAULT_POLICY } from './types.js';
import { matchesAnyRule } from './rules.js';

export interface BrokerOptions {
  runId: string;
  channel: ApprovalChannel;
  settingsRules?: string[];
  defaultPolicy?: EscalationPolicy;
  log?: (msg: string) => void;
}

type Settle = (d: BrokerDecision) => void;

export class EscalationBroker {
  readonly runId: string;
  readonly socketPath: string;
  private readonly opts: BrokerOptions;
  private readonly inflight = new Set<Settle>();
  private server?: Server;

  constructor(opts: BrokerOptions) {
    this.opts = opts;
    this.runId = opts.runId;
    this.socketPath = join(mkdtempSync(join(tmpdir(), 'awe-esc-')), 'broker.sock');
  }

  async decide(req: PermissionRequest): Promise<BrokerDecision> {
    const rules = [...(req.rules ?? []), ...(this.opts.settingsRules ?? [])];
    if (matchesAnyRule(req.toolName, req.toolInput, rules)) return { behavior: 'defer' };
    const policy = req.policy ?? this.opts.defaultPolicy ?? DEFAULT_POLICY;
    this.log(`escalating ${req.agentLabel}: ${req.toolName} ${summarize(req.toolInput)}`);
    const decision = await this.escalate(req, policy);
    this.log(
      `decision for ${req.agentLabel}: ${decision.behavior}${decision.reason ? ` (${decision.reason})` : ''}`,
    );
    return decision;
  }

  private escalate(req: PermissionRequest, policy: EscalationPolicy): Promise<BrokerDecision> {
    return new Promise((resolve) => {
      const settle: Settle = (d) => {
        if (!this.inflight.has(settle)) return;
        this.inflight.delete(settle);
        resolve(d);
      };
      this.inflight.add(settle);
      if (policy.onTimeout === 'deny') {
        const timer = setTimeout(
          () => settle({ behavior: 'deny', reason: 'escalation timeout' }),
          policy.timeoutMs,
        );
        timer.unref();
      }
      this.opts.channel.request(req).then(
        (d) => settle({ behavior: d.behavior, reason: d.reason }),
        // Channel failure must never be more permissive than today; a hung
        // channel is also useless to wait on, so deny immediately.
        (err) => settle({ behavior: 'deny', reason: `channel error: ${String(err)}` }),
      );
    });
  }

  async start(): Promise<void> {
    this.server = createServer((sock) => this.handleConnection(sock));
    await new Promise<void>((resolve, reject) => {
      this.server?.once('error', reject);
      this.server?.listen(this.socketPath, resolve);
    });
  }

  private handleConnection(sock: Socket): void {
    let buf = '';
    sock.on('data', (d) => {
      buf += d;
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      void this.answer(sock, buf.slice(0, nl));
    });
    sock.on('error', () => {});
  }

  private async answer(sock: Socket, line: string): Promise<void> {
    let decision: BrokerDecision;
    try {
      decision = await this.decide(JSON.parse(line) as PermissionRequest);
    } catch (err) {
      decision = { behavior: 'deny', reason: `bad request: ${String(err)}` };
    }
    sock.end(`${JSON.stringify(decision)}\n`);
  }

  async close(): Promise<void> {
    for (const settle of [...this.inflight]) settle({ behavior: 'deny', reason: 'run shutdown' });
    if (this.server) {
      await new Promise<void>((resolve) => this.server?.close(() => resolve()));
      this.server = undefined;
    }
    await this.opts.channel.close?.();
  }

  private log(msg: string): void {
    this.opts.log?.(msg);
  }
}

function summarize(toolInput: unknown): string {
  const text = JSON.stringify(toolInput) ?? '';
  return text.length <= 120 ? text : `${text.slice(0, 120)}...`;
}

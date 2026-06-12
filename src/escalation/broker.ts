// src/escalation/broker.ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, sep } from 'node:path';
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
  settingsRules?: string[]; // global (home-level) rules; apply to every agent
  // Directory-scoped rules: apply only to requests whose cwd is within
  // `cwd`, so one repo's committed .claude settings never silently cover
  // agents running in a different directory.
  projectRules?: { cwd: string; rules: string[] };
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
  private closing = false;

  constructor(opts: BrokerOptions) {
    this.opts = opts;
    this.runId = opts.runId;
    this.socketPath = join(mkdtempSync(join(tmpdir(), 'awe-esc-')), 'broker.sock');
  }

  async decide(req: PermissionRequest): Promise<BrokerDecision> {
    if (this.closing) return { behavior: 'deny', reason: 'run shutdown' };
    const rules = [
      ...(req.rules ?? []),
      ...(this.opts.settingsRules ?? []),
      ...this.projectRulesFor(req),
    ];
    if (matchesAnyRule(req.toolName, req.toolInput, rules)) return { behavior: 'defer' };
    const policy = req.policy ?? this.opts.defaultPolicy ?? DEFAULT_POLICY;
    this.log(`escalating ${req.agentLabel}: ${req.toolName} ${summarize(req.toolInput)}`);
    const decision = await this.escalate(req, policy);
    this.log(
      `decision for ${req.agentLabel}: ${decision.behavior}${decision.reason ? ` (${decision.reason})` : ''}`,
    );
    return decision;
  }

  // A request with no cwd is assumed to run in the rules directory (the
  // run-level cwd) — the hook omits cwd only in that default case.
  private projectRulesFor(req: PermissionRequest): string[] {
    const pr = this.opts.projectRules;
    if (!pr) return [];
    const agentCwd = req.cwd ?? pr.cwd;
    const within = agentCwd === pr.cwd || agentCwd.startsWith(pr.cwd + sep);
    return within ? pr.rules : [];
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
    if (this.server) throw new Error('EscalationBroker already started');
    this.server = createServer((sock) => this.handleConnection(sock));
    await new Promise<void>((resolve, reject) => {
      this.server?.once('error', reject);
      this.server?.listen(this.socketPath, resolve);
    });
  }

  private handleConnection(sock: Socket): void {
    let buf = '';
    let answered = false;
    sock.on('data', (d) => {
      if (answered) return;
      buf += d;
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      answered = true;
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
    this.closing = true;
    for (const settle of [...this.inflight]) settle({ behavior: 'deny', reason: 'run shutdown' });
    if (this.server) {
      await new Promise<void>((resolve) => this.server?.close(() => resolve()));
      this.server = undefined;
    }
    rmSync(dirname(this.socketPath), { recursive: true, force: true });
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

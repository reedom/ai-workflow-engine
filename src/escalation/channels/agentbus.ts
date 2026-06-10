import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runProcess, type SpawnFn } from '../../adapters/claude.js';
import { DEFAULT_POLICY } from '../types.js';
import type { ApprovalChannel, PermissionDecision, PermissionRequest } from '../types.js';

export interface AgentbusChannelOptions {
  to: string; // the human's address on the bus (must be registered, e.g. `agentbus register <to> --persistent`)
  runId: string;
  bin?: string;
  spawnFn?: SpawnFn;
}

const WAIT_TIMEOUT_MS = 86_400_000; // effectively "forever" for onTimeout: 'wait'

// Parses `agentbus ask` stdout: {"request_id": "msg_...", "payload": {...}}.
// Anything but an explicit allow is a deny.
export function parseAskStdout(stdout: string): PermissionDecision {
  try {
    const parsed = JSON.parse(stdout) as { payload?: { behavior?: unknown; reason?: unknown } };
    const reply = parsed.payload ?? {};
    const reason = typeof reply.reason === 'string' ? reply.reason : undefined;
    if (reply.behavior === 'allow') return { behavior: 'allow', reason };
    return { behavior: 'deny', reason: reason ?? 'denied' };
  } catch {
    return { behavior: 'deny', reason: 'unparseable reply' };
  }
}

export function makeAgentbusChannel(opts: AgentbusChannelOptions): ApprovalChannel {
  const bin = opts.bin ?? 'agentbus';
  const run = opts.spawnFn ?? runProcess;
  // `ext:` senders need no registration; only the recipient must exist.
  const self = `ext:awe-${opts.runId}`;
  return {
    id: 'agentbus',
    async request(req: PermissionRequest): Promise<PermissionDecision> {
      const policy = req.policy ?? DEFAULT_POLICY;
      const timeoutMs = policy.onTimeout === 'wait' ? WAIT_TIMEOUT_MS : policy.timeoutMs;
      const payload = JSON.stringify({
        agentLabel: req.agentLabel,
        cli: req.cli,
        toolName: req.toolName,
        toolInput: req.toolInput,
        cwd: req.cwd,
        replyWith: 'agentbus reply <this ask id> <your-name> with payload {"behavior":"allow"|"deny","reason":"..."}',
      });
      const file = join(mkdtempSync(join(tmpdir(), 'awe-ask-')), 'payload.json');
      writeFileSync(file, payload);
      const r = await run(bin, [
        'ask', opts.to,
        '--from', self,
        '--timeout-ms', String(timeoutMs),
        '-f', file,
      ]);
      if (r.code !== 0) throw new Error(`agentbus ask failed: ${r.stderr.trim().slice(0, 300)}`);
      return parseAskStdout(r.stdout);
    },
  };
}

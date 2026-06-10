// src/escalation/hook-helper.ts
import { readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { pathToFileURL } from 'node:url';
import type { BrokerDecision, EscalationPolicy, PermissionRequest } from './types.js';

interface HookStdin {
  tool_name?: string;
  tool_input?: unknown;
  cwd?: string;
}

interface HelperMeta {
  runId: string;
  agentLabel: string;
  policy: EscalationPolicy;
  rules: string[];
}

function takeArg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  return argv[i + 1];
}

// Returns the hook output JSON string for allow/deny, or null for defer
// (the caller prints nothing so normal permission evaluation proceeds).
export async function runHookHelper(argv: string[], stdinJson: string): Promise<string | null> {
  const socketPath = takeArg(argv, '--socket');
  const metaPath = takeArg(argv, '--meta');
  if (!socketPath || !metaPath) throw new Error('usage: hook-helper --socket <path> --meta <file>');
  const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as HelperMeta;
  const hook = JSON.parse(stdinJson) as HookStdin;
  const req: PermissionRequest = {
    runId: meta.runId,
    agentLabel: meta.agentLabel,
    cli: 'claude',
    toolName: hook.tool_name ?? '',
    toolInput: hook.tool_input,
    cwd: hook.cwd,
    policy: meta.policy,
    rules: meta.rules,
  };
  const decision = await requestDecision(socketPath, JSON.stringify(req));
  if (decision.behavior === 'defer') return null;
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision.behavior,
      permissionDecisionReason: decision.reason ?? `escalation: ${decision.behavior}`,
    },
  });
}

function requestDecision(socketPath: string, payload: string): Promise<BrokerDecision> {
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

async function readAllStdin(): Promise<string> {
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  readAllStdin()
    .then((stdin) => runHookHelper(process.argv.slice(2), stdin))
    .then((out) => {
      if (out !== null) process.stdout.write(`${out}\n`);
      process.exit(0);
    })
    .catch((err) => {
      // Print nothing on stdout: Claude Code falls back to its normal
      // headless deny. Never more permissive than today.
      process.stderr.write(`escalate-hook: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
}

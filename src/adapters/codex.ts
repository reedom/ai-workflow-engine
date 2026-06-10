import type { AgentResult, AgentSpec, CliAdapter } from '../types.js';
import { runProcess, type SpawnFn } from './claude.js';

export type CodexSandbox = 'read-only' | 'workspace-write' | 'danger-full-access';

export function buildCodexArgs(spec: AgentSpec, sandbox: CodexSandbox): string[] {
  if (spec.schema !== undefined) {
    throw new Error('codex adapter does not support schema output yet');
  }
  // codex has no separate system-prompt flag; fold instructions into the prompt.
  const prompt = spec.instructions ? `${spec.instructions}\n\n${spec.prompt}` : spec.prompt;
  const args = [
    'exec',
    prompt,
    '--json',
    '--skip-git-repo-check',
    '--ephemeral',
    '--sandbox',
    sandbox,
  ];
  if (spec.model) args.push('--model', spec.model);
  return args;
}

interface CodexEvent {
  type: string;
  thread_id?: string;
  item?: { type?: string; text?: string };
  usage?: Record<string, unknown>;
  error?: { message?: string };
}

export function parseCodexEvents(stdout: string): AgentResult {
  if (!stdout.trim()) throw new Error('codex produced empty stdout');
  let text: string | undefined;
  let sessionId: string | undefined;
  let usage: Record<string, unknown> = {};
  for (const line of stdout.split('\n')) {
    let event: CodexEvent;
    try {
      event = JSON.parse(line) as CodexEvent;
    } catch {
      continue; // codex interleaves the JSONL with plain-text notices
    }
    if (event.type === 'thread.started') sessionId = event.thread_id;
    if (event.type === 'turn.failed') {
      throw new Error(`codex turn failed: ${event.error?.message ?? 'no detail'}`);
    }
    if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
      text = event.item.text;
    }
    if (event.type === 'turn.completed' && event.usage) usage = event.usage;
  }
  if (text === undefined) throw new Error('codex emitted no agent message');
  return {
    text,
    raw: stdout,
    usage: {
      inputTokens: Number(usage['input_tokens'] ?? 0),
      outputTokens: Number(usage['output_tokens'] ?? 0),
    },
    sessionId,
  };
}

export interface CodexAdapterOptions {
  bin?: string;
  spawnFn?: SpawnFn;
  sandbox?: CodexSandbox;
}

export function makeCodexAdapter(opts: CodexAdapterOptions = {}): CliAdapter {
  const bin = opts.bin ?? 'codex';
  const run = opts.spawnFn ?? runProcess;
  const sandbox = opts.sandbox ?? 'workspace-write';
  return {
    id: 'codex',
    caps: { schema: false, resume: true, tools: false },
    async run(spec: AgentSpec): Promise<AgentResult> {
      const { stdout, stderr, code } = await run(bin, buildCodexArgs(spec, sandbox), spec.cwd);
      if (code !== 0) throw new Error(`codex exited ${code}: ${stderr.trim().slice(0, 500)}`);
      return parseCodexEvents(stdout);
    },
  };
}

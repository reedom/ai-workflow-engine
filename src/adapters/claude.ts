import { spawn } from 'node:child_process';
import type { AgentResult, AgentSpec, CliAdapter } from '../types.js';

export function buildClaudeArgs(spec: AgentSpec): string[] {
  const args = ['-p', spec.prompt, '--output-format', 'json'];
  if (spec.model) args.push('--model', spec.model);
  if (spec.schema !== undefined) args.push('--json-schema', JSON.stringify(spec.schema));
  if (spec.instructions) args.push('--append-system-prompt', spec.instructions);
  if (spec.tools && 0 < spec.tools.length) args.push('--allowedTools', ...spec.tools);
  return args;
}

export function parseClaudeResult(stdout: string): AgentResult {
  const env = JSON.parse(stdout) as Record<string, unknown>;
  if (env['is_error'] === true) {
    const detail = env['result'] ?? env['api_error_status'] ?? 'no detail';
    throw new Error(`claude error (${String(env['subtype'] ?? 'unknown')}): ${String(detail)}`);
  }
  const usage = (env['usage'] ?? {}) as Record<string, unknown>;
  return {
    text: typeof env['result'] === 'string' ? env['result'] : '',
    data: 'structured_output' in env ? env['structured_output'] : undefined,
    raw: env,
    usage: {
      inputTokens: Number(usage['input_tokens'] ?? 0),
      outputTokens: Number(usage['output_tokens'] ?? 0),
    },
    sessionId: typeof env['session_id'] === 'string' ? env['session_id'] : undefined,
  };
}

export type SpawnResult = { stdout: string; stderr: string; code: number };
export type SpawnFn = (cmd: string, args: string[], cwd?: string) => Promise<SpawnResult>;

// stdin is IGNORED: claude -p otherwise waits ~3s for stdin and prints a warning.
export function runProcess(cmd: string, args: string[], cwd?: string): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ stdout, stderr, code: code ?? -1 }));
  });
}

export function makeClaudeAdapter(opts: { bin?: string; spawnFn?: SpawnFn } = {}): CliAdapter {
  const bin = opts.bin ?? 'claude';
  const run = opts.spawnFn ?? runProcess;
  return {
    id: 'claude',
    caps: { schema: true, resume: true, tools: true },
    async run(spec: AgentSpec): Promise<AgentResult> {
      const { stdout, stderr, code } = await run(bin, buildClaudeArgs(spec), spec.cwd);
      if (code !== 0) throw new Error(`claude exited ${code}: ${stderr.trim().slice(0, 500)}`);
      return parseClaudeResult(stdout);
    },
  };
}

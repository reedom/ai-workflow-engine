import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentEscalation, AgentResult, AgentSpec, CliAdapter } from '../types.js';

export function buildClaudeArgs(spec: AgentSpec): string[] {
  const args = ['-p', spec.prompt, '--output-format', 'json'];
  if (spec.model) args.push('--model', spec.model);
  if (spec.schema !== undefined) args.push('--json-schema', JSON.stringify(spec.schema));
  if (spec.instructions) args.push('--append-system-prompt', spec.instructions);
  const tools = spec.tools ?? [];
  if (0 < tools.length) args.push('--allowedTools', ...tools);
  return args;
}

export function parseClaudeResult(stdout: string): AgentResult {
  if (!stdout.trim()) throw new Error('claude produced empty stdout');
  let env: Record<string, unknown>;
  try {
    env = JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    throw new Error(`claude stdout is not valid JSON: ${stdout.slice(0, 200)}`);
  }
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

export function buildEscalationSettings(esc: AgentEscalation, dir: string): string {
  const metaPath = join(dir, 'meta.json');
  writeFileSync(
    metaPath,
    JSON.stringify({
      runId: esc.runId,
      agentLabel: esc.agentLabel,
      policy: esc.policy,
      rules: esc.rules,
    }),
  );
  const helper = esc.helperCommand ?? defaultHelperCommand();
  const settings = {
    hooks: {
      PreToolUse: [
        {
          matcher: '*',
          hooks: [
            {
              type: 'command',
              command: `${helper} --socket "${esc.socketPath}" --meta "${metaPath}"`,
              timeout: hookTimeoutSeconds(esc.policy),
            },
          ],
        },
      ],
    },
  };
  const settingsPath = join(dir, 'settings.json');
  writeFileSync(settingsPath, JSON.stringify(settings));
  return settingsPath;
}

function hookTimeoutSeconds(policy: AgentEscalation['policy']): number {
  if (policy.onTimeout === 'wait') return 86_400;
  return Math.ceil(policy.timeoutMs / 1000) + 60;
}

function defaultHelperCommand(): string {
  // Resolves to dist/escalation/hook-helper.js next to the built adapter.
  const helper = fileURLToPath(new URL('../escalation/hook-helper.js', import.meta.url));
  return `"${process.execPath}" "${helper}"`;
}

export function makeClaudeAdapter(opts: { bin?: string; spawnFn?: SpawnFn } = {}): CliAdapter {
  const bin = opts.bin ?? 'claude';
  const run = opts.spawnFn ?? runProcess;
  return {
    id: 'claude',
    caps: { schema: true, resume: true, tools: true },
    async run(spec: AgentSpec): Promise<AgentResult> {
      const args = buildClaudeArgs(spec);
      let tempDir: string | undefined;
      if (spec.escalation) {
        tempDir = mkdtempSync(join(tmpdir(), 'awe-claude-'));
        args.push('--settings', buildEscalationSettings(spec.escalation, tempDir));
      }
      try {
        const { stdout, stderr, code } = await run(bin, args, spec.cwd);
        if (code !== 0) throw new Error(`claude exited ${code}: ${stderr.trim().slice(0, 500)}`);
        return parseClaudeResult(stdout);
      } finally {
        if (tempDir) rmSync(tempDir, { recursive: true, force: true });
      }
    },
  };
}

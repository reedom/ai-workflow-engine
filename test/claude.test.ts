import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  buildClaudeArgs,
  parseClaudeResult,
  makeClaudeAdapter,
  buildEscalationSettings,
} from '../src/adapters/claude.js';

describe('buildClaudeArgs', () => {
  it('starts with print/json and maps options', () => {
    const args = buildClaudeArgs({
      prompt: 'hi',
      model: 'haiku',
      instructions: 'be terse',
      schema: { type: 'object' },
      tools: ['Read', 'Bash'],
    });
    expect(args.slice(0, 4)).toEqual(['-p', 'hi', '--output-format', 'json']);
    expect(args).toContain('--model');
    expect(args).toContain('haiku');
    expect(args).toContain('--json-schema');
    expect(args).toContain('--append-system-prompt');
    expect(args).toContain('--allowedTools');
    const modelIdx = args.indexOf('--model');
    expect(args[modelIdx + 1]).toBe('haiku');
    const toolsIdx = args.indexOf('--allowedTools');
    expect(args.slice(toolsIdx + 1)).toEqual(['Read', 'Bash']);
  });
});

describe('parseClaudeResult', () => {
  it('extracts text/usage/session', () => {
    const stdout = JSON.stringify({
      type: 'result', subtype: 'success', is_error: false,
      result: 'pong', session_id: 's1',
      usage: { input_tokens: 10, output_tokens: 88 },
    });
    const r = parseClaudeResult(stdout);
    expect(r.text).toBe('pong');
    expect(r.usage).toEqual({ inputTokens: 10, outputTokens: 88 });
    expect(r.sessionId).toBe('s1');
    expect(r.data).toBeUndefined();
  });

  it('extracts structured_output as data', () => {
    const stdout = JSON.stringify({
      is_error: false, result: 'Apple in red.',
      structured_output: { fruit: 'apple', color: 'red' },
      usage: { input_tokens: 1, output_tokens: 2 },
    });
    expect(parseClaudeResult(stdout).data).toEqual({ fruit: 'apple', color: 'red' });
  });

  it('throws on is_error', () => {
    const stdout = JSON.stringify({ is_error: true, subtype: 'error_max_turns', result: 'boom' });
    expect(() => parseClaudeResult(stdout)).toThrow(/claude error/);
  });

  it('throws a descriptive error on invalid JSON', () => {
    expect(() => parseClaudeResult('Rate limit exceeded')).toThrow(/not valid JSON/);
    expect(() => parseClaudeResult('   ')).toThrow(/empty stdout/);
  });
});

describe('makeClaudeAdapter', () => {
  it('runs via injected spawn and parses', async () => {
    const a = makeClaudeAdapter({
      spawnFn: async (cmd, args) => {
        expect(cmd).toBe('claude');
        expect(args[0]).toBe('-p');
        return {
          stdout: JSON.stringify({ is_error: false, result: 'ok', usage: { input_tokens: 1, output_tokens: 3 } }),
          stderr: '', code: 0,
        };
      },
    });
    expect((await a.run({ prompt: 'x' })).text).toBe('ok');
  });

  it('throws on nonzero exit', async () => {
    const a = makeClaudeAdapter({ spawnFn: async () => ({ stdout: '', stderr: 'bad', code: 1 }) });
    await expect(a.run({ prompt: 'x' })).rejects.toThrow(/exited 1/);
  });
});

describe('buildEscalationSettings', () => {
  it('writes meta + settings files with a PreToolUse hook', () => {
    const dir = mkdtempSync(join(tmpdir(), 'awe-claude-test-'));
    const settingsPath = buildEscalationSettings(
      {
        runId: 'r1',
        socketPath: '/tmp/broker.sock',
        agentLabel: 'worker',
        policy: { timeoutMs: 60_000, onTimeout: 'deny' },
        rules: ['Read'],
        helperCommand: 'node /opt/helper.js',
      },
      dir,
    );
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
      hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ type: string; command: string; timeout: number }> }> };
    };
    const hook = settings.hooks.PreToolUse[0];
    expect(hook.matcher).toBe('*');
    expect(hook.hooks[0].type).toBe('command');
    expect(hook.hooks[0].command).toContain('node /opt/helper.js');
    expect(hook.hooks[0].command).toContain('--socket "/tmp/broker.sock"');
    expect(hook.hooks[0].command).toContain(`--meta "${join(dir, 'meta.json')}"`);
    // hook timeout must comfortably exceed the escalation timeout (seconds)
    expect(120 <= hook.hooks[0].timeout).toBe(true);
    const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) as {
      agentLabel: string;
      policy: { onTimeout: string };
      rules: string[];
    };
    expect(meta.agentLabel).toBe('worker');
    expect(meta.policy.onTimeout).toBe('deny');
    expect(meta.rules).toEqual(['Read']);
  });

  it('uses a very large hook timeout for onTimeout wait', () => {
    const dir = mkdtempSync(join(tmpdir(), 'awe-claude-test-'));
    const settingsPath = buildEscalationSettings(
      {
        runId: 'r1',
        socketPath: '/tmp/broker.sock',
        agentLabel: 'worker',
        policy: { timeoutMs: 60_000, onTimeout: 'wait' },
        rules: [],
        helperCommand: 'node /opt/helper.js',
      },
      dir,
    );
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
      hooks: { PreToolUse: Array<{ hooks: Array<{ timeout: number }> }> };
    };
    expect(86_400 <= settings.hooks.PreToolUse[0].hooks[0].timeout).toBe(true);
  });

  it('passes --settings when spec.escalation is set and cleans up the temp dir', async () => {
    let seenArgs: string[] = [];
    const adapter = makeClaudeAdapter({
      spawnFn: async (_cmd, args) => {
        seenArgs = args;
        return { stdout: JSON.stringify({ result: 'ok', usage: {} }), stderr: '', code: 0 };
      },
    });
    await adapter.run({
      prompt: 'hi',
      escalation: {
        runId: 'r1',
        socketPath: '/tmp/broker.sock',
        agentLabel: 'worker',
        policy: { timeoutMs: 1_000, onTimeout: 'deny' },
        rules: [],
        helperCommand: 'node /opt/helper.js',
      },
    });
    const i = seenArgs.indexOf('--settings');
    expect(0 <= i).toBe(true);
    expect(existsSync(dirname(seenArgs[i + 1]))).toBe(false); // temp dir removed
  });
});

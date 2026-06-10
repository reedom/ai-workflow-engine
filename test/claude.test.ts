import { describe, it, expect } from 'vitest';
import {
  buildClaudeArgs,
  parseClaudeResult,
  makeClaudeAdapter,
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

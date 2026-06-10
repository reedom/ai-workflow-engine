import { describe, it, expect } from 'vitest';
import {
  buildCodexArgs,
  parseCodexEvents,
  makeCodexAdapter,
} from '../src/adapters/codex.js';

function eventLines(events: unknown[]): string {
  return events.map((e) => JSON.stringify(e)).join('\n');
}

describe('buildCodexArgs', () => {
  it('builds headless exec invocation with defaults', () => {
    const args = buildCodexArgs({ prompt: 'hi' }, 'workspace-write');
    expect(args.slice(0, 2)).toEqual(['exec', 'hi']);
    expect(args).toContain('--json');
    expect(args).toContain('--skip-git-repo-check');
    expect(args).toContain('--ephemeral');
    const sandboxIdx = args.indexOf('--sandbox');
    expect(args[sandboxIdx + 1]).toBe('workspace-write');
  });

  it('maps model and prepends instructions to the prompt', () => {
    const args = buildCodexArgs(
      { prompt: 'hi', model: 'gpt-5.3-codex', instructions: 'be terse' },
      'danger-full-access',
    );
    const modelIdx = args.indexOf('--model');
    expect(args[modelIdx + 1]).toBe('gpt-5.3-codex');
    expect(args[1]).toBe('be terse\n\nhi');
    const sandboxIdx = args.indexOf('--sandbox');
    expect(args[sandboxIdx + 1]).toBe('danger-full-access');
  });

  it('rejects schema requests until supported', () => {
    expect(() => buildCodexArgs({ prompt: 'x', schema: {} }, 'workspace-write')).toThrow(
      /schema/,
    );
  });
});

describe('parseCodexEvents', () => {
  const happy = eventLines([
    { type: 'thread.started', thread_id: 't-1' },
    { type: 'turn.started' },
    {
      type: 'item.completed',
      item: { id: 'item_0', type: 'agent_message', text: 'thinking out loud' },
    },
    {
      type: 'item.completed',
      item: { id: 'item_1', type: 'command_execution', exit_code: 0 },
    },
    {
      type: 'item.completed',
      item: { id: 'item_2', type: 'agent_message', text: 'final answer' },
    },
    {
      type: 'turn.completed',
      usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 7 },
    },
  ]);

  it('extracts last agent message, usage, and thread id', () => {
    const r = parseCodexEvents(happy);
    expect(r.text).toBe('final answer');
    expect(r.usage).toEqual({ inputTokens: 100, outputTokens: 7 });
    expect(r.sessionId).toBe('t-1');
    expect(r.data).toBeUndefined();
  });

  it('skips non-JSON noise lines', () => {
    const r = parseCodexEvents(`Reading additional input from stdin...\n${happy}`);
    expect(r.text).toBe('final answer');
  });

  it('throws when no agent message is present', () => {
    const noMessage = eventLines([{ type: 'turn.completed', usage: {} }]);
    expect(() => parseCodexEvents(noMessage)).toThrow(/agent message/);
  });

  it('throws on turn.failed', () => {
    const failed = eventLines([
      { type: 'turn.failed', error: { message: 'quota exceeded' } },
    ]);
    expect(() => parseCodexEvents(failed)).toThrow(/quota exceeded/);
  });

  it('throws on empty stdout', () => {
    expect(() => parseCodexEvents('   ')).toThrow(/empty stdout/);
  });
});

describe('makeCodexAdapter', () => {
  it('runs via injected spawn and parses', async () => {
    const a = makeCodexAdapter({
      spawnFn: async (cmd, args) => {
        expect(cmd).toBe('codex');
        expect(args[0]).toBe('exec');
        return {
          stdout: eventLines([
            { type: 'thread.started', thread_id: 't-9' },
            { type: 'item.completed', item: { type: 'agent_message', text: 'ok' } },
            { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 3 } },
          ]),
          stderr: '',
          code: 0,
        };
      },
    });
    const r = await a.run({ prompt: 'x' });
    expect(r.text).toBe('ok');
    expect(r.usage).toEqual({ inputTokens: 1, outputTokens: 3 });
  });

  it('throws on nonzero exit', async () => {
    const a = makeCodexAdapter({ spawnFn: async () => ({ stdout: '', stderr: 'bad', code: 1 }) });
    await expect(a.run({ prompt: 'x' })).rejects.toThrow(/exited 1/);
  });

  it('passes the configured sandbox mode', async () => {
    const a = makeCodexAdapter({
      sandbox: 'danger-full-access',
      spawnFn: async (_cmd, args) => {
        const sandboxIdx = args.indexOf('--sandbox');
        expect(args[sandboxIdx + 1]).toBe('danger-full-access');
        return {
          stdout: eventLines([
            { type: 'item.completed', item: { type: 'agent_message', text: 'ok' } },
            { type: 'turn.completed', usage: {} },
          ]),
          stderr: '',
          code: 0,
        };
      },
    });
    await a.run({ prompt: 'x' });
  });
});

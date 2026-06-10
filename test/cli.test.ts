import { it, expect } from 'vitest';
import { main, parseEscalateFlag } from '../src/cli.js';

it('returns exit code 2 on missing/invalid run command', async () => {
  expect(await main([])).toBe(2);
  expect(await main(['run'])).toBe(2);
});

it('returns exit code 2 on a non-numeric --budget (before loading any file)', async () => {
  expect(await main(['run', 'does-not-exist.mjs', '--budget', 'abc'])).toBe(2);
});

it('returns exit code 2 on invalid --args JSON (before loading any file)', async () => {
  expect(await main(['run', 'does-not-exist.mjs', '--args', '{not json'])).toBe(2);
});

it('parses --escalate agentbus:<to>', () => {
  expect(parseEscalateFlag('agentbus:tohru')).toEqual({ channelId: 'agentbus', target: 'tohru' });
});

it('rejects unknown channels and missing targets', () => {
  expect(() => parseEscalateFlag('slack:me')).toThrow(/unsupported escalation channel/);
  expect(() => parseEscalateFlag('agentbus')).toThrow(/agentbus:<to>/);
});

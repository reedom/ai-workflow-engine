import { it, expect } from 'vitest';
import { matchesAnyRule, matchesRule } from '../src/escalation/rules.js';

it('matches bare tool name against any input', () => {
  expect(matchesRule('Read', { file_path: '/x' }, 'Read')).toBe(true);
  expect(matchesRule('Write', { file_path: '/x' }, 'Read')).toBe(false);
});

it('matches Tool(*) wildcard', () => {
  expect(matchesRule('WebSearch', {}, 'WebSearch(*)')).toBe(true);
});

it('matches Bash(prefix:*) as a command prefix', () => {
  expect(matchesRule('Bash', { command: 'git add -A' }, 'Bash(git add:*)')).toBe(true);
  expect(matchesRule('Bash', { command: 'git add' }, 'Bash(git add:*)')).toBe(true);
  expect(matchesRule('Bash', { command: 'git addx' }, 'Bash(git add:*)')).toBe(false);
  expect(matchesRule('Bash', { command: 'git push' }, 'Bash(git add:*)')).toBe(false);
});

it('matches Bash(exact) only exactly', () => {
  expect(matchesRule('Bash', { command: 'go version' }, 'Bash(go version)')).toBe(true);
  expect(matchesRule('Bash', { command: 'go version -m' }, 'Bash(go version)')).toBe(false);
});

it('is conservative: unknown arg patterns never match', () => {
  expect(matchesRule('Read', { file_path: '/x' }, 'Read(~/secrets/**)')).toBe(false);
  expect(matchesRule('Bash', { command: 'ls' }, 'not a rule!!')).toBe(false);
});

it('matchesAnyRule checks the whole list', () => {
  expect(matchesAnyRule('Bash', { command: 'ls -la' }, ['Read', 'Bash(ls:*)'])).toBe(true);
  expect(matchesAnyRule('Bash', { command: 'rm -rf /' }, ['Read', 'Bash(ls:*)'])).toBe(false);
});

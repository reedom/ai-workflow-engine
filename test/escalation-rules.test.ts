import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it, expect } from 'vitest';
import { matchesAnyRule, matchesRule, loadSettingsDeferRules } from '../src/escalation/rules.js';

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

it('loads allow and deny rules from a settings chain, skipping ask rules', () => {
  const home = mkdtempSync(join(tmpdir(), 'awe-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'awe-cwd-'));
  mkdirSync(join(home, '.claude'), { recursive: true });
  mkdirSync(join(cwd, '.claude'), { recursive: true });
  writeFileSync(
    join(home, '.claude', 'settings.json'),
    JSON.stringify({ permissions: { allow: ['Bash(ls:*)'], deny: ['Bash(sudo:*)'], ask: ['Bash(curl:*)'] } }),
  );
  writeFileSync(
    join(cwd, '.claude', 'settings.json'),
    JSON.stringify({ permissions: { allow: ['Read'] } }),
  );
  writeFileSync(
    join(cwd, '.claude', 'settings.local.json'),
    JSON.stringify({ permissions: { allow: ['Write'] } }),
  );
  const rules = loadSettingsDeferRules(cwd, home);
  expect(rules).toContain('Bash(ls:*)');
  expect(rules).toContain('Bash(sudo:*)');
  expect(rules).toContain('Read');
  expect(rules).toContain('Write');
  expect(rules).not.toContain('Bash(curl:*)');
});

it('returns empty rules when settings files are missing or invalid', () => {
  const empty = mkdtempSync(join(tmpdir(), 'awe-empty-'));
  expect(loadSettingsDeferRules(empty, empty)).toEqual([]);
});

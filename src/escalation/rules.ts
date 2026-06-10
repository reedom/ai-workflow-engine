import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Simplified, conservative permission-rule matcher. Anything it cannot
// interpret does not match — unmatched calls escalate to the human.
export function matchesRule(toolName: string, toolInput: unknown, rule: string): boolean {
  const m = /^([A-Za-z][\w]*)(?:\((.*)\))?$/.exec(rule.trim());
  if (!m) return false;
  const ruleTool = m[1];
  const arg = m[2];
  if (ruleTool !== toolName) return false;
  if (arg === undefined || arg === '*') return true;
  if (toolName === 'Bash') return matchesBashArg(toolInput, arg);
  return false;
}

function matchesBashArg(toolInput: unknown, arg: string): boolean {
  const input = toolInput as Record<string, unknown> | null;
  const command = typeof input?.['command'] === 'string' ? (input['command'] as string) : '';
  if (arg.endsWith(':*')) {
    const prefix = arg.slice(0, -2);
    return command === prefix || command.startsWith(`${prefix} `);
  }
  return command === arg;
}

export function matchesAnyRule(toolName: string, toolInput: unknown, rules: string[]): boolean {
  return rules.some((rule) => matchesRule(toolName, toolInput, rule));
}

// Rules from the settings chain that should DEFER (allow: normal flow
// allows; deny: normal flow denies). `ask` rules are intentionally not
// loaded — they escalate.
export function loadSettingsDeferRules(cwd: string, home: string = homedir()): string[] {
  const files = [
    join(home, '.claude', 'settings.json'),
    join(cwd, '.claude', 'settings.json'),
    join(cwd, '.claude', 'settings.local.json'),
  ];
  const rules: string[] = [];
  for (const file of files) {
    const perms = readPermissions(file);
    rules.push(...(perms.allow ?? []), ...(perms.deny ?? []));
  }
  return rules;
}

function readPermissions(file: string): { allow?: string[]; deny?: string[] } {
  try {
    const json = JSON.parse(readFileSync(file, 'utf8')) as {
      permissions?: { allow?: string[]; deny?: string[] };
    };
    return json.permissions ?? {};
  } catch {
    return {};
  }
}

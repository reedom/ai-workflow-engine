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

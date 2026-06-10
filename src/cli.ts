import { resolve } from 'node:path';
import { loadWorkflow, runWorkflow } from './runtime/runner.js';
import { makeClaudeAdapter } from './adapters/claude.js';

function takeFlag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  return args[i + 1];
}

export async function main(argv: string[]): Promise<number> {
  const [cmd, file, ...rest] = argv;
  if (cmd !== 'run' || !file) {
    process.stderr.write('usage: ai-workflow-engine run <workflow-file> [--args <json>] [--budget <n>]\n');
    return 2;
  }
  const argsRaw = takeFlag(rest, '--args');
  const budgetRaw = takeFlag(rest, '--budget');
  const mod = await loadWorkflow(resolve(process.cwd(), file));
  const result = await runWorkflow(mod, {
    adapters: { claude: makeClaudeAdapter() },
    args: argsRaw ? JSON.parse(argsRaw) : undefined,
    budget: budgetRaw ? Number(budgetRaw) : null,
    onLog: (m) => process.stderr.write(`[wf] ${m}\n`),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return 0;
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });

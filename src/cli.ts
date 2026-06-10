import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
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

  let budget: number | null = null;
  if (budgetRaw !== undefined) {
    const n = Number(budgetRaw);
    if (!Number.isFinite(n)) {
      process.stderr.write(`error: --budget must be a number, got '${budgetRaw}'\n`);
      return 2;
    }
    budget = n;
  }

  let args: unknown;
  if (argsRaw !== undefined) {
    try {
      args = JSON.parse(argsRaw);
    } catch {
      process.stderr.write(`error: --args must be valid JSON\n`);
      return 2;
    }
  }

  const mod = await loadWorkflow(resolve(process.cwd(), file));
  const result = await runWorkflow(mod, {
    adapters: { claude: makeClaudeAdapter() },
    args,
    budget,
    onLog: (m) => process.stderr.write(`[wf] ${m}\n`),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return 0;
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
}

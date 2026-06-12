import { pathToFileURL } from 'node:url';
import type { CliAdapter, WorkflowMeta, WorkflowModule } from '../types.js';
import type { ApprovalChannel, EscalationPolicy } from '../escalation/types.js';
import { DEFAULT_POLICY } from '../escalation/types.js';
import { EscalationBroker } from '../escalation/broker.js';
import { loadSettingsDeferRules } from '../escalation/rules.js';
import { createWorkflowApi } from './orchestration.js';
import { makeBudget } from './budget.js';

export function validateMeta(meta: unknown): WorkflowMeta {
  if (!meta || typeof meta !== 'object') throw new Error('workflow: missing `meta` export');
  const m = meta as Record<string, unknown>;
  if (typeof m.name !== 'string' || m.name.length === 0) {
    throw new Error('workflow meta: `name` is required');
  }
  if (typeof m.description !== 'string' || m.description.length === 0) {
    throw new Error('workflow meta: `description` is required');
  }
  return m as unknown as WorkflowMeta;
}

export async function loadWorkflow(file: string): Promise<WorkflowModule> {
  const mod = (await import(pathToFileURL(file).href)) as Partial<WorkflowModule>;
  if (typeof mod.default !== 'function') {
    throw new Error('workflow: missing default export (async function)');
  }
  validateMeta(mod.meta);
  return mod as WorkflowModule;
}

export interface RunOptions {
  adapters: Record<string, CliAdapter>;
  args?: unknown;
  budget?: number | null;
  concurrency?: number;
  // Run-level working directory: the default cwd for every agent spawn
  // (per-call AgentOptions.cwd wins) AND the directory whose .claude
  // settings provide permission defer rules. Defaults to process.cwd().
  cwd?: string;
  onLog?: (msg: string) => void;
  escalation?: {
    channel: ApprovalChannel;
    runId: string;
    defaultPolicy?: Partial<EscalationPolicy>;
  };
}

export async function runWorkflow(mod: WorkflowModule, opts: RunOptions): Promise<unknown> {
  const escalation = opts.escalation ? await startEscalation(opts) : undefined;
  try {
    const api = createWorkflowApi({
      adapters: opts.adapters,
      args: opts.args,
      budget: makeBudget(opts.budget ?? null),
      concurrency: opts.concurrency ?? 8,
      cwd: opts.cwd,
      onLog: opts.onLog,
      escalation,
    });
    return await mod.default(api);
  } finally {
    await escalation?.broker.close();
  }
}

async function startEscalation(
  opts: RunOptions,
): Promise<{ broker: EscalationBroker; defaultPolicy: EscalationPolicy }> {
  const cfg = opts.escalation;
  if (!cfg) throw new Error('unreachable');
  const defaultPolicy: EscalationPolicy = { ...DEFAULT_POLICY, ...cfg.defaultPolicy };
  const broker = new EscalationBroker({
    runId: cfg.runId,
    channel: cfg.channel,
    settingsRules: loadSettingsDeferRules(opts.cwd ?? process.cwd()),
    defaultPolicy,
    log: opts.onLog,
  });
  try {
    await broker.start();
  } catch (err) {
    await broker.close(); // releases the socket tmpdir created in the constructor
    throw err;
  }
  return { broker, defaultPolicy };
}

import { pathToFileURL } from 'node:url';
import type { CliAdapter, WorkflowMeta, WorkflowModule } from '../types.js';
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
  onLog?: (msg: string) => void;
}

export async function runWorkflow(mod: WorkflowModule, opts: RunOptions): Promise<unknown> {
  const api = createWorkflowApi({
    adapters: opts.adapters,
    args: opts.args,
    budget: makeBudget(opts.budget ?? null),
    concurrency: opts.concurrency ?? 8,
    onLog: opts.onLog,
  });
  return mod.default(api);
}

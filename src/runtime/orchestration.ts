import { resolve } from 'node:path';
import type { AgentEscalation, AgentOptions, AgentResult, CliAdapter, Stage, WorkflowApi } from '../types.js';
import type { EscalationPolicy } from '../escalation/types.js';
import type { EscalationBroker } from '../escalation/broker.js';
import type { MutableBudget } from './budget.js';
import { makeLimiter } from './limiter.js';

export interface OrchestrationDeps {
  adapters: Record<string, CliAdapter>;
  args: unknown;
  budget: MutableBudget;
  concurrency: number;
  cwd?: string; // run-level default agent cwd; per-call opts.cwd wins
  onLog?: (msg: string) => void;
  escalation?: { broker: EscalationBroker; defaultPolicy: EscalationPolicy };
}

export function createWorkflowApi(deps: OrchestrationDeps): WorkflowApi {
  const limit = makeLimiter(deps.concurrency);
  let currentPhase = '';

  // A relative per-call cwd resolves against the run-level cwd (or the
  // process cwd at call time) — never at spawn time, where a host
  // process.chdir() would re-anchor it. Empty string counts as unset.
  function resolveAgentCwd(opts: AgentOptions): string | undefined {
    const perCall = opts.cwd || undefined;
    if (perCall === undefined) return deps.cwd;
    return deps.cwd ? resolve(deps.cwd, perCall) : resolve(perCall);
  }

  function buildEscalation(prompt: string, opts: AgentOptions): AgentEscalation | undefined {
    const esc = deps.escalation;
    if (!esc || opts.escalation?.disabled) return undefined;
    return {
      runId: esc.broker.runId,
      socketPath: esc.broker.socketPath,
      agentLabel: opts.label ?? prompt.slice(0, 40),
      policy: {
        timeoutMs: opts.escalation?.timeoutMs ?? esc.defaultPolicy.timeoutMs,
        onTimeout: opts.escalation?.onTimeout ?? esc.defaultPolicy.onTimeout,
      },
      rules: opts.tools ?? [],
    };
  }

  async function agent(prompt: string, opts: AgentOptions = {}): Promise<AgentResult> {
    const cliId = opts.cli ?? 'claude';
    const adapter = deps.adapters[cliId];
    if (!adapter) throw new Error(`unknown cli adapter: ${cliId}`);
    if (deps.budget.total !== null && deps.budget.remaining() <= 0) {
      throw new Error('budget exhausted');
    }
    return limit(async () => {
      const result = await adapter.run({
        prompt,
        model: opts.model,
        schema: opts.schema,
        instructions: opts.instructions,
        tools: opts.tools,
        cwd: resolveAgentCwd(opts),
        escalation: buildEscalation(prompt, opts),
      });
      deps.budget.add(result.usage.inputTokens + result.usage.outputTokens);
      return result;
    });
  }

  // Concurrency is capped inside agent() (via the limiter); parallel/pipeline
  // launch eagerly and rely on that cap.
  async function parallel<T>(thunks: Array<() => Promise<T>>): Promise<Array<T | null>> {
    return Promise.all(
      thunks.map((t) =>
        Promise.resolve()
          .then(t)
          .catch((err) => {
            if (deps.onLog) deps.onLog(`parallel: task failed: ${String(err)}`);
            return null;
          }),
      ),
    );
  }

  async function pipeline(items: unknown[], ...stages: Stage[]): Promise<unknown[]> {
    return Promise.all(
      items.map(async (item, index) => {
        let acc: unknown = item;
        for (const stage of stages) {
          try {
            acc = await stage(acc, item, index);
          } catch {
            return null;
          }
        }
        return acc;
      }),
    );
  }

  function phase(title: string): void {
    currentPhase = title;
    if (deps.onLog) deps.onLog(`=== ${title} ===`);
  }

  function log(message: string): void {
    if (deps.onLog) deps.onLog(currentPhase ? `[${currentPhase}] ${message}` : message);
  }

  return { agent, parallel, pipeline, phase, log, budget: deps.budget, args: deps.args };
}

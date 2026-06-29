import type { EscalationPolicy } from './escalation/types.js';

export interface AgentEscalation {
  runId: string;
  socketPath: string;
  agentLabel: string;
  policy: EscalationPolicy;
  rules: string[]; // per-call defer rules (mirrors the call's tools)
  helperCommand?: string; // test override; default: node + dist hook-helper
}

/**
 * Claude permission mode for a spawned agent, mapped to a CLI flag: `default` (none),
 * `acceptEdits`/`auto` -> `--permission-mode <mode>`, `bypassPermissions` ->
 * `--dangerously-skip-permissions`. This only tunes claude's BUILT-IN permission flow;
 * a PreToolUse approval hook (if the host installs one, as nagi does) runs independently
 * of the mode and can still gate tools.
 */
export type PermissionMode = 'default' | 'acceptEdits' | 'auto' | 'bypassPermissions';

export interface AgentSpec {
  prompt: string;
  model?: string;
  schema?: unknown; // JSON Schema object
  instructions?: string; // system prompt
  tools?: string[];
  cwd?: string;
  permissionMode?: PermissionMode;
  escalation?: AgentEscalation;
}

export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface AgentResult<T = unknown> {
  text: string;
  data?: T; // present when a schema was requested
  raw: unknown; // full adapter envelope
  usage: AgentUsage;
  sessionId?: string;
}

export interface CliAdapter {
  readonly id: string;
  readonly caps: { schema: boolean; resume: boolean; tools: boolean };
  run(spec: AgentSpec): Promise<AgentResult>;
}

export interface AgentEscalationOptions {
  timeoutMs?: number;
  onTimeout?: 'deny' | 'wait';
  disabled?: boolean;
}

export interface AgentOptions {
  cli?: string;
  model?: string;
  schema?: unknown;
  instructions?: string;
  tools?: string[];
  cwd?: string;
  /** Per-call permission mode; overrides the run-level default. */
  permissionMode?: PermissionMode;
  label?: string;
  phase?: string;
  escalation?: AgentEscalationOptions;
}

export type Stage = (prev: unknown, item: unknown, index: number) => unknown;

export interface Budget {
  total: number | null;
  spent(): number;
  remaining(): number;
}

export interface WorkflowApi {
  agent(prompt: string, opts?: AgentOptions): Promise<AgentResult>;
  parallel<T>(thunks: Array<() => Promise<T>>): Promise<Array<T | null>>;
  pipeline(items: unknown[], ...stages: Stage[]): Promise<Array<unknown>>;
  phase(title: string): void;
  log(message: string): void;
  budget: Budget;
  args: unknown;
}

export interface WorkflowMeta {
  name: string;
  description: string;
  whenToUse?: string;
  phases?: Array<{ title: string; detail?: string; model?: string }>;
}

export interface WorkflowModule {
  meta: WorkflowMeta;
  default: (wf: WorkflowApi) => Promise<unknown>;
}

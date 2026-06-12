// Public library surface for embedders (e.g. the nagi concierge).
// The CLI (src/cli.ts) is a thin consumer of this same surface.

export { loadWorkflow, runWorkflow, validateMeta } from './runtime/runner.js';
export type { RunOptions } from './runtime/runner.js';
export { makeBudget } from './runtime/budget.js';

export { makeClaudeAdapter } from './adapters/claude.js';
export { makeCodexAdapter } from './adapters/codex.js';

export { EscalationBroker } from './escalation/broker.js';
export { makeAgentbusChannel } from './escalation/channels/agentbus.js';
export { DEFAULT_POLICY } from './escalation/types.js';
export type {
  ApprovalChannel,
  BrokerDecision,
  EscalationPolicy,
  PermissionDecision,
  PermissionRequest,
} from './escalation/types.js';

export type {
  AgentEscalation,
  AgentEscalationOptions,
  AgentOptions,
  AgentResult,
  AgentSpec,
  AgentUsage,
  Budget,
  CliAdapter,
  Stage,
  WorkflowApi,
  WorkflowMeta,
  WorkflowModule,
} from './types.js';

export interface EscalationPolicy {
  timeoutMs: number;
  onTimeout: 'deny' | 'wait';
}

export const DEFAULT_POLICY: EscalationPolicy = { timeoutMs: 300_000, onTimeout: 'deny' };

export interface PermissionRequest {
  runId: string;
  agentLabel: string;
  cli: string; // 'claude' | 'codex' | ...
  toolName: string;
  toolInput: unknown;
  cwd?: string;
  policy?: EscalationPolicy; // per-call override carried by the hook helper
  rules?: string[]; // per-call defer rules (the call's --allowedTools)
}

// What a channel (a human) answers.
export interface PermissionDecision {
  behavior: 'allow' | 'deny';
  reason?: string;
}

// What the broker returns to the hook helper. 'defer' means "no opinion,
// let Claude Code's normal permission evaluation proceed".
export interface BrokerDecision {
  behavior: 'allow' | 'deny' | 'defer';
  reason?: string;
}

export interface ApprovalChannel {
  readonly id: string; // 'agentbus' | 'slack' | ...
  request(req: PermissionRequest): Promise<PermissionDecision>;
  close?(): Promise<void>;
}

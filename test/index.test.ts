// Guards the public barrel: embedders import from the package root, so a
// symbol dropped from src/index.ts is a breaking change this test catches.
import { it, expect } from 'vitest';
import * as engine from '../src/index.js';

it('exports the embedder surface', () => {
  expect(typeof engine.loadWorkflow).toBe('function');
  expect(typeof engine.runWorkflow).toBe('function');
  expect(typeof engine.validateMeta).toBe('function');
  expect(typeof engine.makeBudget).toBe('function');
  expect(typeof engine.makeClaudeAdapter).toBe('function');
  expect(typeof engine.makeCodexAdapter).toBe('function');
  expect(typeof engine.EscalationBroker).toBe('function');
  expect(typeof engine.makeAgentbusChannel).toBe('function');
  expect(engine.DEFAULT_POLICY).toEqual({ timeoutMs: 300_000, onTimeout: 'deny' });
});

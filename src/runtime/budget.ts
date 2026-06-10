import type { Budget } from '../types.js';

export interface MutableBudget extends Budget {
  add(tokens: number): void;
}

export function makeBudget(total: number | null): MutableBudget {
  let spent = 0;
  return {
    total,
    spent: () => spent,
    remaining: () => (total === null ? Infinity : Math.max(0, total - spent)),
    add: (tokens: number) => { spent += tokens; },
  };
}

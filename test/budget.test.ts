import { it, expect } from 'vitest';
import { makeBudget } from '../src/runtime/budget.js';

it('tracks spent and remaining', () => {
  const b = makeBudget(100);
  expect(b.remaining()).toBe(100);
  b.add(30);
  expect(b.spent()).toBe(30);
  expect(b.remaining()).toBe(70);
});

it('clamps remaining at zero and is infinite when total is null', () => {
  const b = makeBudget(10);
  b.add(25);
  expect(b.remaining()).toBe(0);
  const unbounded = makeBudget(null);
  unbounded.add(5);
  expect(unbounded.remaining()).toBe(Infinity);
});

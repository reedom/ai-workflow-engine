import { it, expect } from 'vitest';
import { makeLimiter } from '../src/runtime/limiter.js';

it('caps concurrency at the configured max', async () => {
  const limit = makeLimiter(2);
  let active = 0;
  let maxActive = 0;
  const task = () => limit(async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 10));
    active -= 1;
    return 1;
  });
  await Promise.all(Array.from({ length: 6 }, task));
  expect(maxActive).toBeLessThanOrEqual(2);
});

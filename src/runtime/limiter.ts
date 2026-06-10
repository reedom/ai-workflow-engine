export type Limiter = <T>(fn: () => Promise<T>) => Promise<T>;

export function makeLimiter(max: number): Limiter {
  let active = 0;
  const queue: Array<() => void> = [];

  const release = () => {
    active -= 1;
    const next = queue.shift();
    if (next) next();
  };

  return function limit<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const run = () => {
        active += 1;
        fn().then(resolve, reject).finally(release);
      };
      if (active < max) run();
      else queue.push(run);
    });
  };
}

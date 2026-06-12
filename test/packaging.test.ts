// Guards the package.json packaging contract: a broken exports map or a
// files[] omission would ship silently — embedders hit it only at install.
import { readFileSync } from 'node:fs';
import { it, expect } from 'vitest';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  main: string;
  types: string;
  exports: Record<string, { types: string; default: string }>;
  files: string[];
  bin: Record<string, string>;
  scripts: Record<string, string>;
};

it('exports map agrees with main/types and ships inside files[]', () => {
  expect(pkg.exports['.']?.default).toBe(`./${pkg.main}`);
  expect(pkg.exports['.']?.types).toBe(`./${pkg.types}`);
  expect(pkg.main).toBe('dist/index.js');
  expect(pkg.types).toBe('dist/index.d.ts');
  expect(pkg.files).toContain('dist');
  for (const bin of Object.values(pkg.bin)) {
    expect(bin.startsWith('dist/')).toBe(true);
  }
});

it('keeps the bin entry executable: shebang present, fresh dist at publish', () => {
  const cli = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
  expect(cli.startsWith('#!/usr/bin/env node\n')).toBe(true);
  expect(pkg.scripts.prepublishOnly).toContain('build');
});

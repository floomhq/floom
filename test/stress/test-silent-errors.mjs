#!/usr/bin/env node
// Regression test for the per-app quality v3 audit bugs (2026-04-17):
// silent runtime failures surfaced as status=success in the DB.
//
// Covers `detectSilentError` in apps/server/src/services/runner.ts, which
// inspects the outputs of a successful entrypoint run and flips the run
// to status=error when outputs.error is a populated string
// (blast-radius, dep-check git-clone-without-auth shape).
//
// This test imports the compiled helper directly (no server, no DB,
// no docker) and runs a matrix of positive + negative cases.
//
// Run: node test/stress/test-silent-errors.mjs
// Prereq: pnpm run build (so dist/services/runner.js exists).

import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const runnerDist = join(
  __dirname,
  '..',
  '..',
  'apps',
  'server',
  'dist',
  'services',
  'runner.js',
);
const { detectSilentError } = await import(pathToFileURL(runnerDist).href);

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  if (ok) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name} -- ${detail || ''}`);
  }
}

console.log('detectSilentError: negative cases (should return null)');

check('null outputs', detectSilentError(null) === null);
check('undefined outputs', detectSilentError(undefined) === null);
check('string outputs', detectSilentError('ok') === null);
check('number outputs', detectSilentError(42) === null);
check('array outputs', detectSilentError([1, 2, 3]) === null);
check('empty object', detectSilentError({}) === null);
check(
  'outputs with unrelated fields',
  detectSilentError({ result: 'ok', count: 3 }) === null,
);
check(
  'outputs.error empty string',
  detectSilentError({ error: '', count: 0 }) === null,
);
check(
  'outputs.error whitespace-only',
  detectSilentError({ error: '   ' }) === null,
);
check(
  'outputs.error is not a string (array)',
  detectSilentError({ error: ['oops'] }) === null,
);
check(
  'outputs.error is not a string (number)',
  detectSilentError({ error: 500 }) === null,
);
check(
  'outputs with errors array but no scalar error',
  detectSilentError({ errors: [], result: 'ok' }) === null,
);

console.log('\ndetectSilentError: positive cases (should return a message)');

const blastRadiusShape = detectSilentError({
  error:
    "git clone failed: fatal: could not read Username for 'https://github.com': No such device or address",
  changed: [],
  affected: [],
  tests: [],
});
check(
  'blast-radius silent git clone failure',
  typeof blastRadiusShape === 'string' &&
    blastRadiusShape.includes('git clone failed'),
  `got: ${blastRadiusShape}`,
);

const depCheckShape = detectSilentError({
  error:
    "git clone failed: fatal: could not read Username for 'https://github.com': No such device or address",
  dead_imports: [],
  count: 0,
});
check(
  'dep-check silent git clone failure',
  typeof depCheckShape === 'string' && depCheckShape.includes('git clone'),
  `got: ${depCheckShape}`,
);

console.log(`\nResult: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

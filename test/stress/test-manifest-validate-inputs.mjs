#!/usr/bin/env node
// Manifest input validation regression tests.
//
// Scope: `validateInputs` boolean coercion. Pre-fix (2026-04-20), the
// code called `Boolean(value)` which is wrong for the string 'false'
// (truthy) — audit fn-16 called this out as a silent correctness bug
// for HTML forms / query params that serialize booleans as strings.
// Post-fix, strings 'true'/'false' (case-insensitive) + '1'/'0' + real
// booleans + numeric 0/1 are accepted; everything else throws.

import { validateInputs, ManifestError } from '../../apps/server/src/services/manifest.ts';

let passed = 0;
let failed = 0;
function log(label, ok, detail) {
  if (ok) {
    passed++;
    console.log(`  ok  ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${detail ? ' :: ' + detail : ''}`);
  }
}

const action = {
  name: 'run',
  label: 'Run',
  inputs: [
    { name: 'enabled', type: 'boolean', required: true },
  ],
  outputs: [],
};

function run(value) {
  return validateInputs(action, { enabled: value }).enabled;
}

function throws(value) {
  try {
    validateInputs(action, { enabled: value });
    return false;
  } catch (err) {
    return err instanceof ManifestError;
  }
}

console.log('manifest validateInputs tests');

// Real booleans pass through
log('boolean true → true', run(true) === true);
log('boolean false → false', run(false) === false);

// String forms: the pre-fix failure mode. `'false'` used to become `true`.
log('string "true" → true', run('true') === true);
log('string "false" → false', run('false') === false);
log('string "TRUE" → true (case-insensitive)', run('TRUE') === true);
log('string "False" → false (case-insensitive)', run('False') === false);
log('string "  true " → true (trimmed)', run('  true ') === true);

// Numeric forms: common in CSV / query-string inputs
log('string "1" → true', run('1') === true);
log('string "0" → false', run('0') === false);
log('number 1 → true', run(1) === true);
log('number 0 → false', run(0) === false);

// Garbage must throw (can't silently become `true`)
log('string "yes" throws', throws('yes'));
log('string "no" throws', throws('no'));
log('string "2" throws', throws('2'));
log('number 2 throws', throws(2));
log('object {} throws', throws({}));
log('array [] throws', throws([]));

// Missing / empty-string path is owned by the earlier required check
const actionOptional = {
  name: 'run',
  label: 'Run',
  inputs: [{ name: 'enabled', type: 'boolean', required: false }],
  outputs: [],
};
const missing = validateInputs(actionOptional, {});
log(
  'optional boolean with no value: field absent',
  !('enabled' in missing),
);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

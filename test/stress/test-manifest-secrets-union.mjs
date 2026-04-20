#!/usr/bin/env node
// Unit tests for collectRequiredSecretKeys.
//
// Exists because a silently-partial union is exactly the bug that
// produced the secrets-deadlock UX dead end (see audit LAUNCH C1,
// route-12 R12-2, route-18 §5). Keeping an explicit test makes the
// contract ("union of manifest + per-action") hard to regress.

import { collectRequiredSecretKeys } from '../../apps/web/src/lib/manifest-secrets.ts';

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

function eq(actual, expected) {
  return (
    Array.isArray(actual) &&
    Array.isArray(expected) &&
    actual.length === expected.length &&
    actual.every((v, i) => v === expected[i])
  );
}

console.log('collectRequiredSecretKeys tests');

log('null manifest → []', eq(collectRequiredSecretKeys(null), []));
log('undefined manifest → []', eq(collectRequiredSecretKeys(undefined), []));

log(
  'manifest-only secrets are returned in order',
  eq(
    collectRequiredSecretKeys({
      actions: {},
      secrets_needed: ['FOO', 'BAR'],
    }),
    ['FOO', 'BAR'],
  ),
);

log(
  'empty manifest list + per-action keys: union includes per-action',
  eq(
    collectRequiredSecretKeys({
      actions: {
        search: { label: 'Search', inputs: [], outputs: [], secrets_needed: ['API_KEY'] },
        upload: { label: 'Upload', inputs: [], outputs: [], secrets_needed: ['API_KEY', 'S3_SECRET'] },
      },
      secrets_needed: [],
    }),
    ['API_KEY', 'S3_SECRET'],
  ),
);

log(
  'manifest-level keys come before per-action keys',
  eq(
    collectRequiredSecretKeys({
      actions: {
        a: { label: 'A', inputs: [], outputs: [], secrets_needed: ['FROM_ACTION'] },
      },
      secrets_needed: ['FROM_MANIFEST'],
    }),
    ['FROM_MANIFEST', 'FROM_ACTION'],
  ),
);

log(
  'duplicates across manifest + actions are deduped',
  eq(
    collectRequiredSecretKeys({
      actions: {
        a: { label: 'A', inputs: [], outputs: [], secrets_needed: ['DUP'] },
      },
      secrets_needed: ['DUP', 'UNIQUE'],
    }),
    ['DUP', 'UNIQUE'],
  ),
);

log(
  'whitespace-only keys are ignored',
  eq(
    collectRequiredSecretKeys({
      actions: { a: { label: 'A', inputs: [], outputs: [], secrets_needed: ['  '] } },
      secrets_needed: ['', 'REAL'],
    }),
    ['REAL'],
  ),
);

log(
  'keys are trimmed',
  eq(
    collectRequiredSecretKeys({
      actions: {},
      secrets_needed: [' FOO ', 'BAR'],
    }),
    ['FOO', 'BAR'],
  ),
);

log(
  'missing actions field → manifest-level only',
  eq(
    collectRequiredSecretKeys({
      secrets_needed: ['X'],
    }),
    ['X'],
  ),
);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

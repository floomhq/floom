#!/usr/bin/env node
// W3.1 Better Auth init tests. Validates the lazy-singleton + cloud-mode
// flag wiring in `lib/better-auth.ts`:
//
//   - isCloudMode() reads FLOOM_CLOUD_MODE truthy variants
//   - getAuth() returns null in OSS mode (no errors)
//   - getAuth() throws when FLOOM_CLOUD_MODE=true and BETTER_AUTH_SECRET is missing/short
//   - getAuth() returns a real Auth instance when secret is set
//   - The instance exposes `handler` and `api.getSession`
//   - _resetAuthForTests() clears the cache so a follow-up call re-reads env
//
// Run: node test/stress/test-w31-better-auth-init.mjs

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'floom-w31-init-'));
process.env.DATA_DIR = tmp;
process.env.FLOOM_DISABLE_JOB_WORKER = 'true';
// Make sure we start in OSS mode for the first assertions.
delete process.env.FLOOM_CLOUD_MODE;
delete process.env.BETTER_AUTH_SECRET;
delete process.env.BETTER_AUTH_URL;

const auth = await import('../../apps/server/dist/lib/better-auth.js');

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

console.log('W3.1 Better Auth init tests');

// ---- 1. isCloudMode unset → false ----
log('isCloudMode: unset → false', auth.isCloudMode() === false);

// ---- 2. isCloudMode truthy variants ----
const truthy = ['true', 'TRUE', 'True', '1', 'yes', 'YES'];
for (const v of truthy) {
  process.env.FLOOM_CLOUD_MODE = v;
  log(`isCloudMode: '${v}' → true`, auth.isCloudMode() === true);
}

// ---- 3. isCloudMode falsy variants ----
const falsy = ['false', '0', 'no', '', 'maybe'];
for (const v of falsy) {
  process.env.FLOOM_CLOUD_MODE = v;
  log(`isCloudMode: '${v}' → false`, auth.isCloudMode() === false);
}

// ---- 4. getAuth() in OSS mode returns null ----
delete process.env.FLOOM_CLOUD_MODE;
auth._resetAuthForTests();
log('getAuth: OSS mode returns null', auth.getAuth() === null);

// ---- 5. getAuth() is cached (second call hits the same path) ----
const a1 = auth.getAuth();
const a2 = auth.getAuth();
log('getAuth: OSS mode second call also null (cached)', a1 === null && a2 === null);

// ---- 6. _resetAuthForTests clears the cache ----
auth._resetAuthForTests();
process.env.FLOOM_CLOUD_MODE = 'true';
process.env.BETTER_AUTH_SECRET = '';
let threw = null;
try {
  auth.getAuth();
} catch (err) {
  threw = err.message;
}
log(
  'getAuth: cloud + missing secret → clear error',
  /BETTER_AUTH_SECRET/.test(threw || ''),
);

// ---- 7. short secret rejected ----
auth._resetAuthForTests();
process.env.BETTER_AUTH_SECRET = 'tooShort';
threw = null;
try {
  auth.getAuth();
} catch (err) {
  threw = err.message;
}
log(
  'getAuth: cloud + short secret → clear error',
  /at least 32/.test(threw || ''),
);

// ---- 8. Valid secret returns a real instance ----
auth._resetAuthForTests();
process.env.BETTER_AUTH_SECRET =
  '0'.repeat(16) + '1'.repeat(16) + '2'.repeat(16) + '3'.repeat(16);
process.env.BETTER_AUTH_URL = 'http://localhost:3051';
let instance = null;
try {
  instance = auth.getAuth();
} catch (err) {
  console.error('  unexpected boot error:', err);
}
log('getAuth: cloud + valid secret returns instance', instance !== null);
log('getAuth: instance has .handler', typeof instance?.handler === 'function');
log(
  'getAuth: instance has .api.getSession',
  typeof instance?.api?.getSession === 'function',
);

// ---- 9. Cached on subsequent call ----
const second = auth.getAuth();
log('getAuth: cached singleton', instance === second);

// ---- 10. _resetAuthForTests forces a rebuild ----
auth._resetAuthForTests();
const third = auth.getAuth();
log('getAuth: rebuild after reset returns a new instance', third !== second);

// ---- 11. flipping to OSS mode after reset returns null ----
auth._resetAuthForTests();
delete process.env.FLOOM_CLOUD_MODE;
log('getAuth: OSS after reset → null', auth.getAuth() === null);

// ---- cleanup ----
rmSync(tmp, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

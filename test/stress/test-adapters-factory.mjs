#!/usr/bin/env node
// Adapter factory tests. Covers:
//   1. Default keys map to the reference impls (docker / sqlite / better-auth /
//      local / console) under an empty env.
//   2. Unknown values throw at boot with the supported-values list — typos
//      surface before any request is served.
//   3. The returned bundle exposes the expected method surface for each of
//      the five concerns so route code can rely on `adapters.x.y(...)`.
//
// Uses a throwaway DATA_DIR so importing db.ts (transitive dep of the
// factory) never pollutes the real server DB.
//
// Run: tsx test/stress/test-adapters-factory.mjs

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'floom-adapters-factory-'));
process.env.DATA_DIR = tmp;
process.env.FLOOM_DISABLE_JOB_WORKER = 'true';
process.env.FLOOM_MASTER_KEY =
  '0'.repeat(16) + '1'.repeat(16) + '2'.repeat(16) + '3'.repeat(16);

// Strip any env vars that would steer the factory away from defaults.
for (const k of [
  'FLOOM_RUNTIME',
  'FLOOM_STORAGE',
  'FLOOM_AUTH',
  'FLOOM_SECRETS',
  'FLOOM_OBSERVABILITY',
]) {
  delete process.env[k];
}

const [{ createAdapters, __testing }, { FLOOM_PROTOCOL_VERSION }] = await Promise.all([
  import('../../apps/server/src/adapters/factory.ts'),
  import('../../apps/server/src/adapters/version.ts'),
]);

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

console.log('adapter factory tests');

// ---- 1. default keys map correctly ----
log('RUNTIME_IMPLS.docker registered', typeof __testing.RUNTIME_IMPLS.docker === 'object' && __testing.RUNTIME_IMPLS.docker !== null);
log('STORAGE_IMPLS.sqlite registered', typeof __testing.STORAGE_IMPLS.sqlite === 'object' && __testing.STORAGE_IMPLS.sqlite !== null);
log('AUTH_IMPLS["better-auth"] registered', typeof __testing.AUTH_IMPLS['better-auth'] === 'object' && __testing.AUTH_IMPLS['better-auth'] !== null);
log('SECRETS_IMPLS.local registered', typeof __testing.SECRETS_IMPLS.local === 'object' && __testing.SECRETS_IMPLS.local !== null);
log('OBSERVABILITY_IMPLS.console registered', typeof __testing.OBSERVABILITY_IMPLS.console === 'object' && __testing.OBSERVABILITY_IMPLS.console !== null);

// ---- 2. unknown value throws with supported values list ----
process.env.FLOOM_RUNTIME = 'bogus';
let thrown;
try {
  createAdapters();
} catch (e) {
  thrown = e;
}
delete process.env.FLOOM_RUNTIME;
log('unknown FLOOM_RUNTIME throws', thrown instanceof Error);
log(
  'error lists supported values (docker + proxy)',
  thrown && /docker/.test(thrown.message) && /proxy/.test(thrown.message),
  thrown && thrown.message,
);

// ---- 3. method-surface completeness under defaults ----
const bundle = createAdapters();
log('bundle.runtime.execute is fn', typeof bundle.runtime.execute === 'function');
log('bundle.storage.getApp is fn', typeof bundle.storage.getApp === 'function');
log('bundle.auth.getSession is fn', typeof bundle.auth.getSession === 'function');
log('bundle.secrets.get is fn', typeof bundle.secrets.get === 'function');
log('bundle.observability.increment is fn', typeof bundle.observability.increment === 'function');

// ---- 4. protocol version compatibility ----
__testing.RUNTIME_MODULE_EXPORTS.docker = {
  name: 'docker',
  protocolVersion: '^0.2',
};
let compatibleRangeError;
try {
  createAdapters();
} catch (e) {
  compatibleRangeError = e;
}
log('compatible protocol range (^0.2) loads', compatibleRangeError === undefined);

__testing.RUNTIME_MODULE_EXPORTS.docker = {
  name: 'docker',
  protocolVersion: '^0.3',
};
let incompatibleRangeError;
try {
  createAdapters();
} catch (e) {
  incompatibleRangeError = e;
}
log(
  'incompatible protocol range throws with both versions',
  incompatibleRangeError instanceof Error &&
    incompatibleRangeError.message.includes('"^0.3"') &&
    incompatibleRangeError.message.includes(`"${FLOOM_PROTOCOL_VERSION}"`),
  incompatibleRangeError instanceof Error ? incompatibleRangeError.message : String(incompatibleRangeError),
);

__testing.RUNTIME_MODULE_EXPORTS.docker = undefined;
let missingFieldError;
try {
  createAdapters();
} catch (e) {
  missingFieldError = e;
}
log('missing protocolVersion is back-compatible', missingFieldError === undefined);

// ---- cleanup ----
rmSync(tmp, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

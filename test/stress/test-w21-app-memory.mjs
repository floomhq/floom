#!/usr/bin/env node
// W2.1 app_memory service tests. Covers CRUD, manifest key gating, and
// loadForRun injection.
//
// Run: node test/stress/test-w21-app-memory.mjs

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'floom-w21-mem-'));
process.env.DATA_DIR = tmp;
process.env.FLOOM_DISABLE_JOB_WORKER = 'true';
process.env.FLOOM_MASTER_KEY =
  '0'.repeat(16) + '1'.repeat(16) + '2'.repeat(16) + '3'.repeat(16);

const { db, DEFAULT_USER_ID, DEFAULT_WORKSPACE_ID } = await import(
  '../../apps/server/dist/db.js'
);
const appMemory = await import('../../apps/server/dist/services/app_memory.js');
const { newAppId } = await import('../../apps/server/dist/lib/ids.js');

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

console.log('W2.1 app_memory tests');

// ---- fixture app with declared memory_keys ----
const appId = newAppId();
const manifest = {
  name: 'Flyfast',
  description: 'mock',
  actions: { run: { label: 'run', inputs: [], outputs: [] } },
  runtime: 'python',
  python_dependencies: [],
  node_dependencies: {},
  secrets_needed: [],
  manifest_version: '2.0',
  memory_keys: ['last_destination', 'preferred_currency'],
};
db.prepare(
  `INSERT INTO apps (id, slug, name, description, manifest, code_path, workspace_id, memory_keys)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
).run(
  appId,
  'flyfast',
  'Flyfast',
  'Cheap flights',
  JSON.stringify(manifest),
  'proxied:flyfast',
  DEFAULT_WORKSPACE_ID,
  JSON.stringify(manifest.memory_keys),
);

const ctx = {
  workspace_id: DEFAULT_WORKSPACE_ID,
  user_id: DEFAULT_USER_ID,
  device_id: 'dev-unit-test',
  is_authenticated: false,
};

// ---- 1. set + get round-trip ----
await appMemory.set(ctx, 'flyfast', 'last_destination', 'LIS');
const got = await appMemory.get(ctx, 'flyfast', 'last_destination');
log('set + get round-trip: LIS', got === 'LIS');

// ---- 2. set with JSON object value ----
await appMemory.set(ctx, 'flyfast', 'preferred_currency', { code: 'EUR', symbol: '€' });
const currencyVal = await appMemory.get(ctx, 'flyfast', 'preferred_currency');
log(
  'set with object: round-trips JSON',
  currencyVal && currencyVal.code === 'EUR' && currencyVal.symbol === '€',
);

// ---- 3. set with non-declared key throws ----
let threw = false;
try {
  await appMemory.set(ctx, 'flyfast', 'not_declared', 'bogus');
} catch (err) {
  threw = err.name === 'MemoryKeyNotAllowedError';
}
log('set with undeclared key throws MemoryKeyNotAllowedError', threw);

// ---- 4. get with non-declared key throws ----
let threw2 = false;
try {
  await appMemory.get(ctx, 'flyfast', 'not_declared');
} catch (err) {
  threw2 = err.name === 'MemoryKeyNotAllowedError';
}
log('get with undeclared key throws MemoryKeyNotAllowedError', threw2);

// ---- 5. list returns all populated keys ----
const all = await appMemory.list(ctx, 'flyfast');
const keys = Object.keys(all).sort();
log(
  'list: returns both populated keys',
  keys.length === 2 && keys.includes('last_destination') && keys.includes('preferred_currency'),
);

// ---- 6. del removes a key ----
const removed = await appMemory.del(ctx, 'flyfast', 'last_destination');
log('del: returns true when a row was removed', removed === true);
const post = await appMemory.get(ctx, 'flyfast', 'last_destination');
log('del: subsequent get returns null', post === null);

// ---- 7. del is idempotent on already-gone keys ----
const removed2 = await appMemory.del(ctx, 'flyfast', 'last_destination');
log('del: second call returns false', removed2 === false);

// ---- 8. isolation: different user_id never sees another user's rows ----
const otherCtx = { ...ctx, user_id: 'alice' };
await appMemory.set(otherCtx, 'flyfast', 'preferred_currency', { code: 'USD' });
const aliceCurrency = await appMemory.get(otherCtx, 'flyfast', 'preferred_currency');
const localCurrency = await appMemory.get(ctx, 'flyfast', 'preferred_currency');
log('isolation: alice sees USD', aliceCurrency && aliceCurrency.code === 'USD');
log('isolation: local user still sees EUR', localCurrency && localCurrency.code === 'EUR');

// ---- 9. loadForRun: only declared keys are loaded ----
// add a stray row via direct SQL (bypassing the gate) — it must NOT land
// in loadForRun output because it's not declared in the manifest.
db.prepare(
  `INSERT INTO app_memory (workspace_id, app_slug, user_id, device_id, key, value)
   VALUES (?, ?, ?, ?, ?, ?)`,
).run(
  DEFAULT_WORKSPACE_ID,
  'flyfast',
  DEFAULT_USER_ID,
  'dev-unit-test',
  'stale_key_from_old_manifest',
  '"legacy"',
);

const loaded = await appMemory.loadForRun(ctx, 'flyfast');
log(
  'loadForRun: stale (undeclared) key NOT loaded',
  !('stale_key_from_old_manifest' in loaded),
);
log(
  'loadForRun: declared populated key IS loaded',
  loaded.preferred_currency && loaded.preferred_currency.code === 'EUR',
);

// ---- 10. loadForRun on app with no memory_keys returns {} ----
const barebonesId = newAppId();
db.prepare(
  `INSERT INTO apps (id, slug, name, description, manifest, code_path, workspace_id)
   VALUES (?, ?, ?, ?, ?, ?, ?)`,
).run(
  barebonesId,
  'barebones',
  'Barebones',
  'no memory',
  JSON.stringify({ ...manifest, memory_keys: [] }),
  'proxied:barebones',
  DEFAULT_WORKSPACE_ID,
);
const bb = await appMemory.loadForRun(ctx, 'barebones');
log('loadForRun: app with no memory_keys returns {}', Object.keys(bb).length === 0);

// ---- cleanup ----
db.close();
rmSync(tmp, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

#!/usr/bin/env node
// W2.3 rekeyDevice tests (connections branch). The W2.1 test already
// exercises app_memory/runs/run_threads rekey. This file tests the
// connections branch added in W2.3:
//
//   - device rows flip to user rows
//   - composio_account_id is NOT rewritten (Composio has no rename API)
//   - users.composio_user_id is populated on first rekey
//   - idempotent: second run is a no-op
//   - double-Gmail (user already connected pre-login) → device row left
//     alone so the 'user' row wins; prevents overwrite
//   - other tables (app_memory etc) still rekeyed too (W2.1 regression)
//
// Run: node test/stress/test-w23-rekey.mjs

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'floom-w23-rekey-'));
process.env.DATA_DIR = tmp;
process.env.FLOOM_DISABLE_JOB_WORKER = 'true';
process.env.FLOOM_MASTER_KEY =
  '0'.repeat(16) + '1'.repeat(16) + '2'.repeat(16) + '3'.repeat(16);

const { db, DEFAULT_WORKSPACE_ID, DEFAULT_USER_ID } = await import(
  '../../apps/server/dist/db.js'
);
const session = await import('../../apps/server/dist/services/session.js');

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

console.log('W2.3 rekey (connections) tests');

// ---- setup: alice as a real user ----
db.prepare(
  `INSERT INTO users (id, workspace_id, auth_provider) VALUES (?, ?, 'google')`,
).run('alice', DEFAULT_WORKSPACE_ID);

// ---- seed 2 device-owned connections for dev-anon ----
db.prepare(
  `INSERT INTO connections
     (id, workspace_id, owner_kind, owner_id, provider,
      composio_connection_id, composio_account_id, status)
   VALUES (?, ?, ?, ?, ?, ?, ?, 'active')`,
).run(
  'con_gmail',
  DEFAULT_WORKSPACE_ID,
  'device',
  'dev-anon',
  'gmail',
  'comp_gmail_1',
  'device:dev-anon',
);
db.prepare(
  `INSERT INTO connections
     (id, workspace_id, owner_kind, owner_id, provider,
      composio_connection_id, composio_account_id, status)
   VALUES (?, ?, ?, ?, ?, ?, ?, 'active')`,
).run(
  'con_notion',
  DEFAULT_WORKSPACE_ID,
  'device',
  'dev-anon',
  'notion',
  'comp_notion_1',
  'device:dev-anon',
);

// seed an app_memory + run + chat_thread row to make sure the
// connections branch doesn't break W2.1's existing behavior
db.prepare(
  `INSERT INTO apps (id, slug, name, description, manifest, code_path, workspace_id, memory_keys)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
).run(
  'app_rk',
  'rk-fixture',
  'Rk',
  'x',
  JSON.stringify({
    name: 'Rk',
    description: 'x',
    actions: { run: { label: 'x', inputs: [], outputs: [] } },
    runtime: 'python',
    python_dependencies: [],
    node_dependencies: {},
    secrets_needed: [],
    manifest_version: '2.0',
    memory_keys: ['k'],
  }),
  'proxied:rk',
  DEFAULT_WORKSPACE_ID,
  JSON.stringify(['k']),
);
db.prepare(
  `INSERT INTO app_memory (workspace_id, app_slug, user_id, device_id, key, value)
   VALUES (?, ?, ?, ?, ?, ?)`,
).run(DEFAULT_WORKSPACE_ID, 'rk-fixture', DEFAULT_USER_ID, 'dev-anon', 'k', '"v"');
db.prepare(
  `INSERT INTO runs (id, app_id, action, inputs, status, workspace_id, user_id, device_id)
   VALUES (?, ?, ?, ?, 'pending', ?, NULL, ?)`,
).run('run_rk', 'app_rk', 'run', '{}', DEFAULT_WORKSPACE_ID, 'dev-anon');
db.prepare(
  `INSERT INTO run_threads (id, workspace_id, user_id, device_id) VALUES (?, ?, NULL, ?)`,
).run('thr_rk', DEFAULT_WORKSPACE_ID, 'dev-anon');

// ---- 1. rekey: counts include connections ----
const res = session.rekeyDevice('dev-anon', 'alice', DEFAULT_WORKSPACE_ID);
log('rekey: connections=2', res.connections === 2, `got ${res.connections}`);
log('rekey: app_memory=1 (W2.1 still works)', res.app_memory === 1);
log('rekey: runs=1 (W2.1 still works)', res.runs === 1);
log('rekey: run_threads=1 (W2.1 still works)', res.run_threads === 1);

// ---- 2. connections rows now owned by alice ----
const aliceConns = db
  .prepare(
    `SELECT * FROM connections WHERE workspace_id = ? AND owner_kind = ? AND owner_id = ?`,
  )
  .all(DEFAULT_WORKSPACE_ID, 'user', 'alice');
log('after rekey: alice owns 2 connections', aliceConns.length === 2);

// ---- 3. composio_account_id NOT rewritten ----
log(
  'after rekey: composio_account_id kept as device:dev-anon (Gmail)',
  aliceConns.find((c) => c.provider === 'gmail')?.composio_account_id ===
    'device:dev-anon',
);
log(
  'after rekey: composio_account_id kept as device:dev-anon (Notion)',
  aliceConns.find((c) => c.provider === 'notion')?.composio_account_id ===
    'device:dev-anon',
);

// ---- 4. users.composio_user_id populated ----
const alice = db.prepare('SELECT composio_user_id FROM users WHERE id = ?').get('alice');
log(
  'after rekey: users.composio_user_id = device:dev-anon',
  alice.composio_user_id === 'device:dev-anon',
);

// ---- 5. idempotent: second rekey is a no-op ----
const res2 = session.rekeyDevice('dev-anon', 'alice', DEFAULT_WORKSPACE_ID);
log(
  'rekey 2: all counts zero',
  res2.connections === 0 &&
    res2.app_memory === 0 &&
    res2.runs === 0 &&
    res2.run_threads === 0,
);

// ---- 6. users.composio_user_id NOT overwritten on idempotent re-run ----
const alice2 = db.prepare('SELECT composio_user_id FROM users WHERE id = ?').get('alice');
log(
  'idempotent: composio_user_id still device:dev-anon',
  alice2.composio_user_id === 'device:dev-anon',
);

// ---- 7. double-Gmail scenario ----
// Seed another device with gmail connected
db.prepare(
  `INSERT INTO connections
     (id, workspace_id, owner_kind, owner_id, provider,
      composio_connection_id, composio_account_id, status)
   VALUES (?, ?, ?, ?, ?, ?, ?, 'active')`,
).run(
  'con_gmail_dup',
  DEFAULT_WORKSPACE_ID,
  'device',
  'dev-bob',
  'gmail',
  'comp_gmail_bob',
  'device:dev-bob',
);
// Alice already has a user:alice gmail row (from step 1)
// Now bob the same person as alice re-uses dev-bob and tries to rekey
const res3 = session.rekeyDevice('dev-bob', 'alice', DEFAULT_WORKSPACE_ID);
log(
  'double-gmail: the dev-bob row is NOT rekeyed to alice (alice already owns gmail)',
  res3.connections === 0,
);
// dev-bob gmail row should still be device-owned
const bobRow = db
  .prepare(
    `SELECT * FROM connections WHERE owner_kind = ? AND owner_id = ? AND provider = ?`,
  )
  .get('device', 'dev-bob', 'gmail');
log('double-gmail: dev-bob gmail row still exists device-side', !!bobRow);

// But alice's original row is untouched
const aliceGmail = db
  .prepare(
    `SELECT * FROM connections WHERE owner_kind = ? AND owner_id = ? AND provider = ?`,
  )
  .get('user', 'alice', 'gmail');
log(
  "double-gmail: alice's gmail unchanged (composio_account_id = device:dev-anon)",
  aliceGmail.composio_account_id === 'device:dev-anon',
);

// ---- 8. rekey of a device that has NO connections (W2.1 only) ----
// Reset: no connections for dev-carol
const res4 = session.rekeyDevice('dev-carol', 'alice', DEFAULT_WORKSPACE_ID);
log('rekey: missing-device connections=0', res4.connections === 0);

// ---- 9. rekey preserves the same atomic transaction (no partial writes) ----
// Seed a new device with a connection but a broken FK-ish condition:
// we don't have a broken FK path here, but we verify by adding another
// rekey and confirming the row count is consistent.
db.prepare(
  `INSERT INTO users (id, workspace_id, auth_provider) VALUES (?, ?, 'google')`,
).run('bob', DEFAULT_WORKSPACE_ID);
db.prepare(
  `INSERT INTO connections
     (id, workspace_id, owner_kind, owner_id, provider,
      composio_connection_id, composio_account_id, status)
   VALUES (?, ?, ?, ?, ?, ?, ?, 'active')`,
).run(
  'con_stripe_c',
  DEFAULT_WORKSPACE_ID,
  'device',
  'dev-carol',
  'stripe',
  'comp_stripe_c',
  'device:dev-carol',
);
const res5 = session.rekeyDevice('dev-carol', 'bob', DEFAULT_WORKSPACE_ID);
log('rekey(dev-carol→bob): connections=1', res5.connections === 1);
const bob = db.prepare('SELECT composio_user_id FROM users WHERE id = ?').get('bob');
log(
  'rekey(bob): composio_user_id = device:dev-carol',
  bob.composio_user_id === 'device:dev-carol',
);

// ---- cleanup ----
db.close();
rmSync(tmp, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

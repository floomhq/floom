#!/usr/bin/env node
// W3.3 schema tests. Validates the stripe_accounts + stripe_webhook_events
// tables and the user_version bump from 5 to 6.
//
// Run: node test/stress/test-w33-schema.mjs

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'floom-w33-schema-'));
process.env.DATA_DIR = tmp;
process.env.FLOOM_DISABLE_JOB_WORKER = 'true';
process.env.FLOOM_MASTER_KEY =
  '0'.repeat(16) + '1'.repeat(16) + '2'.repeat(16) + '3'.repeat(16);

const { db, DEFAULT_WORKSPACE_ID, DEFAULT_USER_ID } = await import(
  '../../apps/server/dist/db.js'
);

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

console.log('W3.3 schema tests');

// ---- 1. user_version bumped >= 6 ----
// W4-minimal ships user_version=7 (adds app_reviews + feedback tables).
// This test just confirms the W33 baseline of 6 or higher.
const v = db.prepare('PRAGMA user_version').get();
log('user_version >= 6', v.user_version >= 6, `got ${v.user_version}`);

// ---- 2. stripe_accounts table exists ----
const accountsTable = db
  .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='stripe_accounts'`)
  .get();
log('stripe_accounts table exists', !!accountsTable);

// ---- 3. stripe_accounts columns ----
const accountCols = db.prepare(`PRAGMA table_info(stripe_accounts)`).all();
const accountColNames = accountCols.map((c) => c.name).sort();
const expectedAccountCols = [
  'account_type',
  'charges_enabled',
  'country',
  'created_at',
  'details_submitted',
  'id',
  'payouts_enabled',
  'requirements_json',
  'stripe_account_id',
  'updated_at',
  'user_id',
  'workspace_id',
].sort();
log(
  'stripe_accounts has all expected columns',
  JSON.stringify(accountColNames) === JSON.stringify(expectedAccountCols),
  `got ${JSON.stringify(accountColNames)}`,
);

// ---- 4. stripe_accounts UNIQUE on (workspace_id, user_id) ----
const accountIndexes = db.prepare(`PRAGMA index_list(stripe_accounts)`).all();
const hasUniqueWsUser = accountIndexes.some((i) => {
  if (i.unique !== 1) return false;
  const cols = db
    .prepare(`PRAGMA index_info(${i.name})`)
    .all()
    .map((c) => c.name);
  return (
    cols.length === 2 &&
    cols.includes('workspace_id') &&
    cols.includes('user_id')
  );
});
log('stripe_accounts has UNIQUE(workspace_id, user_id)', hasUniqueWsUser);

// ---- 5. stripe_accounts UNIQUE on stripe_account_id ----
const hasUniqueStripeId = accountIndexes.some((i) => {
  if (i.unique !== 1) return false;
  const cols = db
    .prepare(`PRAGMA index_info(${i.name})`)
    .all()
    .map((c) => c.name);
  return cols.length === 1 && cols[0] === 'stripe_account_id';
});
log('stripe_accounts has UNIQUE(stripe_account_id)', hasUniqueStripeId);

// ---- 6. account_type CHECK constraint rejects bogus values ----
let badTypeRejected = false;
try {
  db.prepare(
    `INSERT INTO stripe_accounts
       (id, workspace_id, user_id, stripe_account_id, account_type)
     VALUES (?, ?, ?, ?, ?)`,
  ).run('sa_test1', DEFAULT_WORKSPACE_ID, DEFAULT_USER_ID, 'acct_zzz', 'bogus');
} catch (err) {
  badTypeRejected = /CHECK/.test(err.message);
}
log('account_type CHECK rejects bogus value', badTypeRejected);

// ---- 7. happy-path insert + read ----
db.prepare(
  `INSERT INTO stripe_accounts
     (id, workspace_id, user_id, stripe_account_id, account_type, country,
      charges_enabled, payouts_enabled, details_submitted, requirements_json)
   VALUES (?, ?, ?, ?, 'express', 'US', 0, 0, 0, NULL)`,
).run('sa_real1', DEFAULT_WORKSPACE_ID, DEFAULT_USER_ID, 'acct_test_real_1');
const row = db.prepare(`SELECT * FROM stripe_accounts WHERE id = ?`).get('sa_real1');
log('insert + read happy path', !!row && row.account_type === 'express');

// ---- 8. UNIQUE(ws, user) blocks dupes ----
let dupeRejected = false;
try {
  db.prepare(
    `INSERT INTO stripe_accounts
       (id, workspace_id, user_id, stripe_account_id, account_type)
     VALUES (?, ?, ?, ?, 'express')`,
  ).run('sa_real2', DEFAULT_WORKSPACE_ID, DEFAULT_USER_ID, 'acct_test_real_2');
} catch (err) {
  dupeRejected = /UNIQUE/i.test(err.message);
}
log('second insert for same (ws,user) rejected', dupeRejected);

// ---- 9. ws-scoped indexes exist ----
const idxNames = db
  .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='stripe_accounts'`)
  .all()
  .map((r) => r.name);
log(
  'idx_stripe_accounts_workspace exists',
  idxNames.includes('idx_stripe_accounts_workspace'),
);
log(
  'idx_stripe_accounts_user exists',
  idxNames.includes('idx_stripe_accounts_user'),
);

// ---- 10. stripe_webhook_events table ----
const eventsTable = db
  .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='stripe_webhook_events'`)
  .get();
log('stripe_webhook_events table exists', !!eventsTable);

const eventCols = db
  .prepare(`PRAGMA table_info(stripe_webhook_events)`)
  .all()
  .map((c) => c.name)
  .sort();
const expectedEventCols = [
  'event_id',
  'event_type',
  'id',
  'livemode',
  'payload',
  'received_at',
].sort();
log(
  'stripe_webhook_events has expected columns',
  JSON.stringify(eventCols) === JSON.stringify(expectedEventCols),
);

// ---- 11. stripe_webhook_events UNIQUE on event_id ----
const eventIndexes = db
  .prepare(`PRAGMA index_list(stripe_webhook_events)`)
  .all();
const hasUniqueEventId = eventIndexes.some((i) => {
  if (i.unique !== 1) return false;
  const cols = db
    .prepare(`PRAGMA index_info(${i.name})`)
    .all()
    .map((c) => c.name);
  return cols.length === 1 && cols[0] === 'event_id';
});
log('stripe_webhook_events has UNIQUE(event_id)', hasUniqueEventId);

// ---- 12. dupe event_id rejected ----
db.prepare(
  `INSERT INTO stripe_webhook_events (id, event_id, event_type, livemode, payload)
   VALUES ('swe1', 'evt_test_1', 'account.updated', 0, '{}')`,
).run();
let dupeEvent = false;
try {
  db.prepare(
    `INSERT INTO stripe_webhook_events (id, event_id, event_type, livemode, payload)
     VALUES ('swe2', 'evt_test_1', 'account.updated', 0, '{}')`,
  ).run();
} catch (err) {
  dupeEvent = /UNIQUE/i.test(err.message);
}
log('dupe event_id rejected', dupeEvent);

// ---- 13. pre-existing tables still intact ----
for (const t of ['workspaces', 'users', 'apps', 'connections']) {
  const tab = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
    .get(t);
  log(`pre-existing table '${t}' still intact`, !!tab);
}

// ---- 14. FK to workspaces ----
let fkOk = false;
try {
  db.prepare(
    `INSERT INTO stripe_accounts
       (id, workspace_id, user_id, stripe_account_id, account_type)
     VALUES (?, ?, ?, ?, 'express')`,
  ).run('sa_fk', 'ws_does_not_exist', 'user_x', 'acct_fk');
} catch (err) {
  fkOk = /FOREIGN KEY/i.test(err.message);
}
log('FK to workspaces enforced', fkOk);

// ---- cleanup ----
db.close();
rmSync(tmp, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

#!/usr/bin/env node
// W2.1 schema + bootstrap tests. Verifies that db.ts correctly creates the
// multi-tenant tables, alters existing ones, and bootstraps the synthetic
// 'local' workspace + user + membership on first boot.
//
// Uses a throwaway DATA_DIR so it never pollutes the real server DB.
//
// Run: node test/stress/test-w21-schema.mjs

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'floom-w21-schema-'));
process.env.DATA_DIR = tmp;
process.env.FLOOM_DISABLE_JOB_WORKER = 'true';
// Random master key so each test run has a fresh envelope key.
process.env.FLOOM_MASTER_KEY =
  '0'.repeat(16) + '1'.repeat(16) + '2'.repeat(16) + '3'.repeat(16);

const dbModule = await import('../../apps/server/dist/db.js');
const { db, DEFAULT_USER_ID, DEFAULT_WORKSPACE_ID } = dbModule;

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

console.log('W2.1 schema + bootstrap tests');

// ---- 1. tables exist ----
const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
  .all()
  .map((r) => r.name);

log('table: workspaces exists', tables.includes('workspaces'));
log('table: users exists', tables.includes('users'));
log('table: workspace_members exists', tables.includes('workspace_members'));
log('table: app_memory exists', tables.includes('app_memory'));
log('table: user_secrets exists', tables.includes('user_secrets'));

// ---- 2. altered columns exist ----
const appCols = db
  .prepare('PRAGMA table_info(apps)')
  .all()
  .map((r) => r.name);
log('apps.workspace_id added', appCols.includes('workspace_id'));
log('apps.memory_keys added', appCols.includes('memory_keys'));

const runCols = db
  .prepare('PRAGMA table_info(runs)')
  .all()
  .map((r) => r.name);
log('runs.workspace_id added', runCols.includes('workspace_id'));
log('runs.user_id added', runCols.includes('user_id'));
log('runs.device_id added', runCols.includes('device_id'));

const threadCols = db
  .prepare('PRAGMA table_info(chat_threads)')
  .all()
  .map((r) => r.name);
log('chat_threads.workspace_id added', threadCols.includes('workspace_id'));
log('chat_threads.user_id added', threadCols.includes('user_id'));
log('chat_threads.device_id added', threadCols.includes('device_id'));

// ---- 3. user_version bumped ----
const userVersion = db.prepare('PRAGMA user_version').get().user_version;
log('pragma user_version >= 4', userVersion >= 4, `got ${userVersion}`);

// ---- 4. default workspace bootstrap ----
const ws = db
  .prepare('SELECT * FROM workspaces WHERE id = ?')
  .get(DEFAULT_WORKSPACE_ID);
log("default 'local' workspace exists", !!ws);
log("default workspace slug='local'", ws && ws.slug === 'local');
log("default workspace name='Local'", ws && ws.name === 'Local');
log("default workspace plan='oss'", ws && ws.plan === 'oss');

// ---- 5. default user bootstrap ----
const user = db.prepare('SELECT * FROM users WHERE id = ?').get(DEFAULT_USER_ID);
log("default 'local' user exists", !!user);
log(
  'default user bound to local workspace',
  user && user.workspace_id === DEFAULT_WORKSPACE_ID,
);
log("default user.auth_provider='local'", user && user.auth_provider === 'local');

// ---- 6. default membership bootstrap ----
const member = db
  .prepare(
    'SELECT * FROM workspace_members WHERE workspace_id = ? AND user_id = ?',
  )
  .get(DEFAULT_WORKSPACE_ID, DEFAULT_USER_ID);
log('default membership row exists', !!member);
log("default membership role='admin'", member && member.role === 'admin');

// ---- 7. re-importing db.ts is idempotent (bootstrap must not double-insert) ----
const wsCountBefore = db
  .prepare('SELECT COUNT(*) as n FROM workspaces WHERE id = ?')
  .get(DEFAULT_WORKSPACE_ID).n;
log('bootstrap is idempotent (workspace count=1)', wsCountBefore === 1);

// ---- cleanup ----
db.close();
rmSync(tmp, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

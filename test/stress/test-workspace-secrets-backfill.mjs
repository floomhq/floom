#!/usr/bin/env node
// Launch-blocker audit: workspace_secrets migration/backfill safety.
//
// Exercises a prod-like shape: multiple users, multiple workspaces, legacy
// user_secrets rows with encrypted values, conflicting same-key values, and
// a write that lands after the first migration pass.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'floom-workspace-secrets-backfill-'));
process.env.DATA_DIR = tmp;
process.env.FLOOM_DISABLE_JOB_WORKER = 'true';
process.env.FLOOM_MASTER_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const { db, runWorkspaceSecretsBackfill } = await import('../../apps/server/dist/db.js');
const userSecrets = await import('../../apps/server/dist/services/user_secrets.js');

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

function insertWorkspace(id, slug) {
  db.prepare(`INSERT INTO workspaces (id, slug, name, plan) VALUES (?, ?, ?, 'cloud_free')`).run(
    id,
    slug,
    slug,
  );
}

function insertUser(id, workspaceId) {
  db.prepare(`INSERT INTO users (id, workspace_id, email, auth_provider) VALUES (?, ?, ?, 'test')`).run(
    id,
    workspaceId,
    `${id}@example.com`,
  );
  db.prepare(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'admin')`).run(
    workspaceId,
    id,
  );
}

function ctx(workspace_id, user_id) {
  return {
    workspace_id,
    user_id,
    device_id: `${user_id}-device`,
    is_authenticated: true,
  };
}

function countWorkspaceSecretRows(workspaceId, key) {
  return db
    .prepare(`SELECT COUNT(*) AS c FROM workspace_secrets WHERE workspace_id = ? AND key = ?`)
    .get(workspaceId, key).c;
}

function conflict(workspaceId, key) {
  return db
    .prepare(`SELECT * FROM workspace_secret_backfill_conflicts WHERE workspace_id = ? AND key = ?`)
    .get(workspaceId, key);
}

function tableSnapshot(table) {
  return JSON.stringify(
    db.prepare(`SELECT * FROM ${table} ORDER BY workspace_id, key`).all(),
  );
}

console.log('workspace_secrets backfill launch-blocker tests');

insertWorkspace('ws_alpha', 'alpha');
insertWorkspace('ws_beta', 'beta');
for (const [userId, workspaceId] of [
  ['user_alpha_a', 'ws_alpha'],
  ['user_alpha_b', 'ws_alpha'],
  ['user_beta_a', 'ws_beta'],
]) {
  insertUser(userId, workspaceId);
}

userSecrets.set(ctx('ws_alpha', 'user_alpha_a'), 'OPENAI_API_KEY', 'alpha-openai');
userSecrets.set(ctx('ws_alpha', 'user_alpha_a'), 'GEMINI_API_KEY', 'alpha-gemini-a');
userSecrets.set(ctx('ws_alpha', 'user_alpha_b'), 'GEMINI_API_KEY', 'alpha-gemini-b');
userSecrets.set(ctx('ws_beta', 'user_beta_a'), 'GEMINI_API_KEY', 'beta-gemini');

runWorkspaceSecretsBackfill();

log(
  'single-user legacy key backfills into workspace_secrets',
  userSecrets.getWorkspaceSecret('ws_alpha', 'OPENAI_API_KEY') === 'alpha-openai',
);
log(
  'second workspace single-user key backfills independently',
  userSecrets.getWorkspaceSecret('ws_beta', 'GEMINI_API_KEY') === 'beta-gemini',
);
log(
  'mixed same-workspace values are not guessed into one workspace secret',
  countWorkspaceSecretRows('ws_alpha', 'GEMINI_API_KEY') === 0,
);
log(
  'mixed same-workspace values record a conflict row',
  !!conflict('ws_alpha', 'GEMINI_API_KEY'),
);

const beforeSecondPass = db.prepare(`SELECT COUNT(*) AS c FROM workspace_secrets`).get().c;
runWorkspaceSecretsBackfill();
const afterSecondPass = db.prepare(`SELECT COUNT(*) AS c FROM workspace_secrets`).get().c;
log('backfill is idempotent on second run', afterSecondPass === beforeSecondPass);
log(
  'idempotent second run does not duplicate primary-key rows',
  countWorkspaceSecretRows('ws_alpha', 'OPENAI_API_KEY') === 1 &&
    countWorkspaceSecretRows('ws_beta', 'GEMINI_API_KEY') === 1,
);
const beforeThirdPassSnapshot = tableSnapshot('workspace_secrets');
runWorkspaceSecretsBackfill();
const afterThirdPassSnapshot = tableSnapshot('workspace_secrets');
log('re-running backfill produces the same workspace_secrets rows', afterThirdPassSnapshot === beforeThirdPassSnapshot);

// Simulated concurrent write: a legacy user-level secret is written after
// the first migration pass. A follow-up pass picks it up exactly once.
userSecrets.set(ctx('ws_beta', 'user_beta_a'), 'ANTHROPIC_API_KEY', 'beta-anthropic');
const dryRun = runWorkspaceSecretsBackfill({ dryRun: true });
log('dry-run reports pending backfill without writing', dryRun.secrets_inserted === 1);
log(
  'dry-run leaves workspace_secrets unchanged',
  countWorkspaceSecretRows('ws_beta', 'ANTHROPIC_API_KEY') === 0,
);
runWorkspaceSecretsBackfill();
runWorkspaceSecretsBackfill();
log(
  'post-first-pass legacy write is picked up by the next idempotent pass',
  userSecrets.getWorkspaceSecret('ws_beta', 'ANTHROPIC_API_KEY') === 'beta-anthropic',
);
log(
  'post-first-pass legacy write is not double-created',
  countWorkspaceSecretRows('ws_beta', 'ANTHROPIC_API_KEY') === 1,
);

db.close();
rmSync(tmp, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

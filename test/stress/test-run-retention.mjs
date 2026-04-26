#!/usr/bin/env node
// ADR-011 run retention tests.
//
// Prereq: pnpm --filter @floom/server build
// Run: node test/stress/test-run-retention.mjs

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Hono } from '../../apps/server/node_modules/hono/dist/index.js';

const tmp = mkdtempSync(join(tmpdir(), 'floom-run-retention-'));
process.env.DATA_DIR = tmp;
process.env.FLOOM_DISABLE_JOB_WORKER = 'true';
process.env.FLOOM_DISABLE_ZOMBIE_SWEEPER = 'true';
process.env.FLOOM_DISABLE_RETENTION_SWEEPER = 'true';
process.env.FLOOM_DISABLE_TRIGGERS_WORKER = 'true';
process.env.FLOOM_MASTER_KEY =
  '0'.repeat(16) + '1'.repeat(16) + '2'.repeat(16) + '3'.repeat(16);

const { db } = await import('../../apps/server/dist/db.js');
const { meRouter } = await import('../../apps/server/dist/routes/run.js');
const { workspacesRouter } = await import(
  '../../apps/server/dist/routes/workspaces.js'
);
const { agentTokenAuthMiddleware, hashAgentToken, extractAgentTokenPrefix } =
  await import('../../apps/server/dist/lib/agent-tokens.js');
const { sweepRunRetention } = await import(
  '../../apps/server/dist/services/run-retention-sweeper.js'
);
const { ingestAppFromSpec } = await import(
  '../../apps/server/dist/services/openapi-ingest.js'
);
const { cleanupUserOrphans } = await import(
  '../../apps/server/dist/services/cleanup.js'
);

const app = new Hono();
app.use('/api/*', agentTokenAuthMiddleware);
app.route('/api/me', meRouter);
app.route('/api/workspaces', workspacesRouter);

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

async function fetchApp(method, path, token, body) {
  const init = {
    method,
    headers: {
      authorization: `Bearer ${token}`,
    },
  };
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await app.fetch(new Request(`http://localhost${path}`, init));
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // leave null
  }
  return { status: res.status, json, text };
}

function countRows(sql, ...params) {
  return db.prepare(sql).get(...params)?.c ?? 0;
}

function rowExists(table, id) {
  return !!db.prepare(`SELECT id FROM ${table} WHERE id = ?`).get(id);
}

function sqliteTs(date) {
  return date.toISOString().replace('T', ' ').slice(0, 19);
}

function daysAgo(days) {
  return sqliteTs(new Date(Date.now() - days * 24 * 60 * 60 * 1000));
}

function seedUser(id) {
  db.prepare(
    `INSERT INTO users (id, email, name, auth_provider, auth_subject)
     VALUES (?, ?, ?, 'better-auth', ?)`,
  ).run(id, `${id}@example.com`, id, id);
}

function seedWorkspace(id, userRoles) {
  db.prepare(
    `INSERT INTO workspaces (id, slug, name, plan) VALUES (?, ?, ?, 'cloud_free')`,
  ).run(id, id, id);
  for (const [userId, role] of Object.entries(userRoles)) {
    db.prepare(
      `INSERT INTO workspace_members (workspace_id, user_id, role)
       VALUES (?, ?, ?)`,
    ).run(id, userId, role);
  }
}

function seedAgentToken(id, token, userId, workspaceId, scope = 'read-write') {
  db.prepare(
    `INSERT INTO agent_tokens
       (id, prefix, hash, label, scope, workspace_id, user_id, created_at)
     VALUES (?, ?, ?, 'test', ?, ?, ?, datetime('now'))`,
  ).run(
    id,
    extractAgentTokenPrefix(token),
    hashAgentToken(token),
    scope,
    workspaceId,
    userId,
  );
}

function seedApp(id, workspaceId, author, retentionDays = null) {
  const manifest = {
    name: id,
    description: 'test app',
    actions: {
      run: {
        label: 'Run',
        inputs: [],
        outputs: [{ name: 'result', type: 'text', label: 'Result' }],
      },
    },
    runtime: 'python',
    python_dependencies: [],
    node_dependencies: {},
    secrets_needed: [],
    manifest_version: '2.0',
    ...(retentionDays ? { max_run_retention_days: retentionDays } : {}),
  };
  db.prepare(
    `INSERT INTO apps
       (id, slug, name, description, manifest, code_path, workspace_id, author,
        max_run_retention_days)
     VALUES (?, ?, ?, 'desc', ?, ?, ?, ?, ?)`,
  ).run(
    id,
    id,
    id,
    JSON.stringify(manifest),
    `proxied:${id}`,
    workspaceId,
    author,
    retentionDays,
  );
}

function seedRun({
  id = `run_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
  appId,
  workspaceId,
  userId,
  deviceId = `dev_${userId}`,
  startedAt = daysAgo(1),
  finishedAt = daysAgo(1),
  status = 'success',
}) {
  db.prepare(
    `INSERT INTO runs
       (id, app_id, action, inputs, outputs, logs, status, workspace_id,
        user_id, device_id, started_at, finished_at)
     VALUES (?, ?, 'run', '{"x":1}', '{"ok":true}', 'log', ?, ?, ?, ?, ?, ?)`,
  ).run(id, appId, status, workspaceId, userId, deviceId, startedAt, finishedAt);
  return id;
}

console.log('ADR-011 run retention');

seedUser('alice');
seedUser('bob');
seedWorkspace('ws_alpha', { alice: 'admin', bob: 'viewer' });
seedWorkspace('ws_beta', { bob: 'admin' });

const aliceToken = 'floom_agent_AliceRetentionToken0000000010000';
const bobToken = 'floom_agent_BobRetentionToken000000000010000';
seedAgentToken('agt_alice', aliceToken, 'alice', 'ws_alpha');
seedAgentToken('agt_bob', bobToken, 'bob', 'ws_alpha');

seedApp('app_alpha_one', 'ws_alpha', 'alice', null);
seedApp('app_alpha_two', 'ws_alpha', 'alice', null);
seedApp('app_beta_one', 'ws_beta', 'bob', null);

// 0. Publish-time loader persists creator-declared retention.
await ingestAppFromSpec({
  spec: {
    openapi: '3.0.0',
    info: { title: 'Retention Loader', description: 'loader test' },
    servers: [{ url: 'https://api.example.com' }],
    paths: {
      '/ping': {
        get: {
          operationId: 'ping',
          responses: { '200': { description: 'OK' } },
        },
      },
    },
  },
  slug: 'retention-loader',
  workspace_id: 'ws_alpha',
  author_user_id: 'alice',
  max_run_retention_days: 9,
});
const loaderRow = db
  .prepare('SELECT max_run_retention_days, manifest FROM apps WHERE slug = ?')
  .get('retention-loader');
const loaderManifest = JSON.parse(loaderRow.manifest);
log('publish loader persists apps.max_run_retention_days', loaderRow.max_run_retention_days === 9);
log('publish loader persists manifest max_run_retention_days', loaderManifest.max_run_retention_days === 9);

// 1. User can delete own run.
const ownRun = seedRun({ id: 'run_delete_own', appId: 'app_alpha_one', workspaceId: 'ws_alpha', userId: 'alice' });
let res = await fetchApp('DELETE', `/api/me/runs/${ownRun}`, aliceToken);
log('DELETE /api/me/runs/:id own run returns 200', res.status === 200, `got ${res.status} ${res.text}`);
log('own run row deleted', !rowExists('runs', ownRun));
log(
  'own run deletion audit written',
  countRows("SELECT COUNT(*) AS c FROM run_deletion_audit WHERE action = 'user_delete_run' AND run_id = ?", ownRun) === 1,
);

// 2. User cannot delete someone else's run.
const someoneElsesRun = seedRun({ id: 'run_delete_other', appId: 'app_alpha_one', workspaceId: 'ws_alpha', userId: 'bob' });
res = await fetchApp('DELETE', `/api/me/runs/${someoneElsesRun}`, aliceToken);
log('DELETE /api/me/runs/:id other user returns 403', res.status === 403, `got ${res.status} ${res.text}`);
log('other user run remains', rowExists('runs', someoneElsesRun));

// 3. Bulk delete by app filters correctly.
const bulkOldTarget = seedRun({
  id: 'run_bulk_old_target',
  appId: 'app_alpha_one',
  workspaceId: 'ws_alpha',
  userId: 'alice',
  startedAt: daysAgo(30),
  finishedAt: daysAgo(30),
});
const bulkRecentTarget = seedRun({
  id: 'run_bulk_recent_target',
  appId: 'app_alpha_one',
  workspaceId: 'ws_alpha',
  userId: 'alice',
  startedAt: daysAgo(1),
  finishedAt: daysAgo(1),
});
const bulkOldOtherApp = seedRun({
  id: 'run_bulk_old_other_app',
  appId: 'app_alpha_two',
  workspaceId: 'ws_alpha',
  userId: 'alice',
  startedAt: daysAgo(30),
  finishedAt: daysAgo(30),
});
res = await fetchApp(
  'DELETE',
  `/api/me/runs?app_id=app_alpha_one&before_ts=${encodeURIComponent(daysAgo(7))}&confirm=delete_runs`,
  aliceToken,
);
log('DELETE /api/me/runs bulk returns 200', res.status === 200, `got ${res.status} ${res.text}`);
log('bulk delete removed one matching row', res.json?.deleted_count === 1, `got ${res.json?.deleted_count}`);
log('bulk old target deleted', !rowExists('runs', bulkOldTarget));
log('bulk recent same app kept', rowExists('runs', bulkRecentTarget));
log('bulk old other app kept', rowExists('runs', bulkOldOtherApp));

// 4. Workspace owner can bulk-delete workspace runs; non-admin cannot.
const wsRunOne = seedRun({ id: 'run_ws_one', appId: 'app_alpha_one', workspaceId: 'ws_alpha', userId: 'alice' });
const wsRunTwo = seedRun({ id: 'run_ws_two', appId: 'app_alpha_two', workspaceId: 'ws_alpha', userId: 'bob' });
const betaRun = seedRun({ id: 'run_ws_beta', appId: 'app_beta_one', workspaceId: 'ws_beta', userId: 'bob' });
res = await fetchApp('DELETE', '/api/workspaces/ws_alpha/runs', bobToken);
log('non-admin workspace run bulk delete returns 403', res.status === 403, `got ${res.status} ${res.text}`);
log('non-admin attempt deleted nothing', rowExists('runs', wsRunOne) && rowExists('runs', wsRunTwo));
res = await fetchApp('DELETE', '/api/workspaces/ws_alpha/runs', aliceToken);
log('admin workspace run bulk delete returns 200', res.status === 200, `got ${res.status} ${res.text}`);
log('workspace delete removed workspace app runs', !rowExists('runs', wsRunOne) && !rowExists('runs', wsRunTwo));
log('workspace delete kept other workspace run', rowExists('runs', betaRun));

// 5. Sweeper enforces explicit per-app retention and leaves NULL indefinite.
seedApp('app_retention_7d', 'ws_alpha', 'alice', 7);
seedApp('app_retention_null', 'ws_alpha', 'alice', null);
const oldRetainedByPolicy = seedRun({
  id: 'run_retention_old',
  appId: 'app_retention_7d',
  workspaceId: 'ws_alpha',
  userId: 'alice',
  startedAt: daysAgo(10),
  finishedAt: daysAgo(10),
});
const recentRetainedByPolicy = seedRun({
  id: 'run_retention_recent',
  appId: 'app_retention_7d',
  workspaceId: 'ws_alpha',
  userId: 'alice',
  startedAt: daysAgo(2),
  finishedAt: daysAgo(2),
});
const nullRetentionOld = seedRun({
  id: 'run_retention_null_old',
  appId: 'app_retention_null',
  workspaceId: 'ws_alpha',
  userId: 'alice',
  startedAt: daysAgo(40),
  finishedAt: daysAgo(40),
});
const sweep = sweepRunRetention();
log('sweeper deleted one expired run', sweep.deleted_count === 1, `got ${sweep.deleted_count}`);
log('sweeper deleted >7d run', !rowExists('runs', oldRetainedByPolicy));
log('sweeper kept recent run', rowExists('runs', recentRetainedByPolicy));
log('sweeper kept NULL-retention old run', rowExists('runs', nullRetentionOld));

// 6. Account hard-delete sweeps remaining user runs.
seedUser('charlie');
seedWorkspace('ws_charlie', { charlie: 'admin' });
seedApp('app_charlie_public', 'ws_charlie', 'charlie', null);
const charlieRun = seedRun({
  id: 'run_charlie_account_delete',
  appId: 'app_charlie_public',
  workspaceId: 'ws_charlie',
  userId: 'charlie',
});
cleanupUserOrphans('charlie');
log('account hard-delete removed user run', !rowExists('runs', charlieRun));

db.close();
rmSync(tmp, { recursive: true, force: true });

console.log(`\nResult: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

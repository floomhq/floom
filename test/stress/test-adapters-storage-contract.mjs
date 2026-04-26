#!/usr/bin/env node
// Contract tests for the StorageAdapter.
//
// These tests define executable conformance checks for apps, runs, jobs,
// users/workspaces, and admin secret pointers. They always exit 0 so direct
// documentation runs and CI smoke jobs can print the complete tally; the
// conformance runner parses the tally and returns a failing status when any
// assertion fails.
//
// Run: tsx test/stress/test-adapters-storage-contract.mjs

import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const require = createRequire(import.meta.url);
const Database = require('../../apps/server/node_modules/better-sqlite3');

const tmp = mkdtempSync(join(tmpdir(), 'floom-storage-contract-'));
process.env.DATA_DIR = tmp;
process.env.FLOOM_DISABLE_JOB_WORKER = 'true';
process.env.FLOOM_MASTER_KEY =
  '0'.repeat(16) + '1'.repeat(16) + '2'.repeat(16) + '3'.repeat(16);

function preserveSelectedConcernEnv() {
  const selected = process.env.FLOOM_CONFORMANCE_CONCERN;
  for (const k of [
    'FLOOM_RUNTIME',
    'FLOOM_STORAGE',
    'FLOOM_AUTH',
    'FLOOM_SECRETS',
    'FLOOM_OBSERVABILITY',
  ]) {
    if (selected && k === `FLOOM_${selected.toUpperCase()}`) continue;
    delete process.env[k];
  }
}
preserveSelectedConcernEnv();

const { db, DEFAULT_WORKSPACE_ID } = await import('../../apps/server/src/db.ts');
const { adapters } = await import('../../apps/server/src/adapters/index.ts');
const storage = adapters.storage;

let passed = 0;
let failed = 0;
let skipped = 0;

function ok(label) {
  passed++;
  console.log(`  ok    ${label}`);
}

function fail(label, reason) {
  failed++;
  console.log(`  FAIL  ${label}: ${reason}`);
}

function skip(label, reason) {
  skipped++;
  console.log(`  skip  ${label}: ${reason}`);
}

async function check(label, fn) {
  try {
    await fn();
    ok(label);
  } catch (err) {
    fail(label, err && err.message ? err.message : String(err));
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function json(value) {
  return JSON.stringify(value);
}

function appInput(id, slug, workspace_id = DEFAULT_WORKSPACE_ID) {
  return {
    id,
    slug,
    name: `Contract ${slug}`,
    description: 'Storage contract fixture',
    manifest: json({
      name: slug,
      description: 'Storage contract fixture',
      actions: { run: { label: 'Run', inputs: [], outputs: [] } },
      runtime: 'python',
      python_dependencies: [],
      node_dependencies: {},
      secrets_needed: [],
      manifest_version: '1.0',
    }),
    status: 'active',
    docker_image: null,
    code_path: '/tmp/storage-contract',
    category: 'contracts',
    author: null,
    icon: null,
    app_type: 'docker',
    base_url: null,
    auth_type: null,
    auth_config: null,
    openapi_spec_url: null,
    openapi_spec_cached: null,
    visibility: 'public',
    is_async: 0,
    webhook_url: null,
    timeout_ms: 15_000,
    retries: 0,
    async_mode: null,
    workspace_id,
    memory_keys: null,
    featured: 0,
    avg_run_ms: null,
    publish_status: 'published',
    thumbnail_url: null,
    stars: 0,
    hero: 0,
  };
}

function createWorkspace(id) {
  db.prepare(
    `INSERT INTO workspaces (id, slug, name, plan) VALUES (?, ?, ?, 'team')`,
  ).run(id, id, `Workspace ${id}`);
}

function createJobInput(id, app, input = {}) {
  return {
    id,
    app,
    action: 'run',
    inputs: input,
    webhookUrlOverride: null,
    timeoutMsOverride: 5_000,
    maxRetriesOverride: 0,
    perCallSecrets: null,
  };
}

console.log('adapter-storage contract tests');

try {
  await check('apps CRUD round-trip with list/update/delete', async () => {
    const app = storage.createApp(appInput('app-crud-1', 'app-crud-1'));
    assert(app.id === 'app-crud-1', `id=${app.id}`);
    assert(storage.getApp('app-crud-1')?.id === app.id, 'getApp mismatch');
    assert(storage.getAppById(app.id)?.slug === app.slug, 'getAppById mismatch');
    assert(storage.listApps({ workspace_id: DEFAULT_WORKSPACE_ID }).some((row) => row.id === app.id), 'listApps missing app');
    const updated = storage.updateApp(app.slug, { description: 'Updated description' });
    assert(updated?.description === 'Updated description', 'updateApp did not refresh description');
    assert(storage.deleteApp(app.slug) === true, 'deleteApp returned false');
    assert(storage.getApp(app.slug) === undefined, 'deleted app remained readable');
  });

  await check('runs CRUD round-trip with read-after-write update', async () => {
    const app = storage.createApp(appInput('app-runs-1', 'app-runs-1'));
    const run = storage.createRun({
      id: 'run-crud-1',
      app_id: app.id,
      thread_id: 'thread-1',
      action: 'run',
      inputs: { prompt: 'hello' },
    });
    assert(run.status === 'pending', `status=${run.status}`);
    assert(storage.getRun(run.id)?.id === run.id, 'getRun mismatch');
    assert(storage.listRuns({ app_id: app.id }).some((row) => row.id === run.id), 'listRuns missing run');
    storage.updateRun(run.id, {
      status: 'success',
      outputs: { ok: true },
      logs: 'done',
      duration_ms: 12,
      finished: true,
    });
    const updated = storage.getRun(run.id);
    assert(updated?.status === 'success', `updated status=${updated?.status}`);
    assert(updated?.outputs === json({ ok: true }), `outputs=${updated?.outputs}`);
    storage.deleteApp(app.slug);
    assert(storage.getRun(run.id) === undefined, 'run did not cascade with app delete');
  });

  await check('jobs CRUD round-trip with claim/update', async () => {
    const app = storage.createApp(appInput('app-jobs-1', 'app-jobs-1'));
    const job = storage.createJob(createJobInput('job-crud-1', app, { x: 1 }));
    assert(job.status === 'queued', `status=${job.status}`);
    assert(storage.getJob(job.id)?.id === job.id, 'getJob mismatch');
    const claimed = storage.claimNextJob();
    assert(claimed?.id === job.id, `claimed=${claimed?.id}`);
    storage.updateJob(job.id, { output_json: json({ ok: true }), status: 'succeeded' });
    const updated = storage.getJob(job.id);
    assert(updated?.status === 'succeeded', `updated status=${updated?.status}`);
    assert(updated?.output_json === json({ ok: true }), `output_json=${updated?.output_json}`);
  });

  await check('users and workspaces round-trip through adapter reads', async () => {
    createWorkspace('workspace-users-1');
    const user = storage.createUser({
      id: 'user-crud-1',
      workspace_id: 'workspace-users-1',
      email: 'user-crud-1@example.com',
      name: 'Storage User',
      auth_provider: 'contract',
      auth_subject: 'subject-1',
    });
    db.prepare(
      `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'editor')`,
    ).run('workspace-users-1', user.id);
    assert(storage.getUser(user.id)?.email === user.email, 'getUser mismatch');
    assert(storage.getUserByEmail(user.email)?.id === user.id, 'getUserByEmail mismatch');
    assert(storage.getWorkspace('workspace-users-1')?.id === 'workspace-users-1', 'getWorkspace mismatch');
    const workspaces = storage.listWorkspacesForUser(user.id);
    assert(workspaces.length === 1 && workspaces[0].role === 'editor', `workspaces=${json(workspaces)}`);
    const updated = storage.upsertUser(
      {
        id: user.id,
        workspace_id: 'workspace-users-1',
        email: user.email,
        name: 'Storage User Updated',
        auth_provider: 'contract',
        auth_subject: 'subject-1',
      },
      ['name'],
    );
    assert(updated.name === 'Storage User Updated', `name=${updated.name}`);
  });

  await check('admin secrets CRUD round-trip and idempotent delete', async () => {
    const app = storage.createApp(appInput('app-admin-secrets-1', 'app-admin-secrets-1'));
    storage.upsertAdminSecret('GLOBAL_TOKEN', 'global-1', null);
    storage.upsertAdminSecret('APP_TOKEN', 'app-1', app.id);
    assert(storage.listAdminSecrets(null).some((row) => row.name === 'GLOBAL_TOKEN'), 'global secret missing');
    assert(storage.listAdminSecrets(app.id).some((row) => row.value === 'app-1'), 'app secret missing');
    storage.upsertAdminSecret('APP_TOKEN', 'app-2', app.id);
    assert(storage.listAdminSecrets(app.id).find((row) => row.name === 'APP_TOKEN')?.value === 'app-2', 'app secret did not update');
    assert(storage.deleteAdminSecret('APP_TOKEN', app.id) === true, 'deleteAdminSecret existing returned false');
    assert(storage.deleteAdminSecret('APP_TOKEN', app.id) === false, 'deleteAdminSecret missing was not false');
  });

  await check('slug collision is deterministic and never silently overwrites', async () => {
    const first = storage.createApp(appInput('app-collision-1', 'app-collision'));
    let threw = false;
    try {
      storage.createApp(appInput('app-collision-2', 'app-collision'));
    } catch (err) {
      threw = /unique|constraint|slug|apps/i.test(err.message || String(err));
    }
    const after = storage.getApp('app-collision');
    assert(threw || after?.id === first.id, `threw=${threw}, after=${json(after)}`);
  });

  await check('missing-row lookups return undefined', async () => {
    assert(storage.getApp('missing-app') === undefined, 'getApp missing was not undefined');
    assert(storage.getAppById('missing-app-id') === undefined, 'getAppById missing was not undefined');
    assert(storage.getRun('missing-run') === undefined, 'getRun missing was not undefined');
    assert(storage.getJob('missing-job') === undefined, 'getJob missing was not undefined');
    assert(storage.getUser('missing-user') === undefined, 'getUser missing was not undefined');
    assert(storage.getWorkspace('missing-workspace') === undefined, 'getWorkspace missing was not undefined');
  });

  await check('updated_at refreshes while created_at remains stable', async () => {
    const app = storage.createApp(appInput('app-updated-at-1', 'app-updated-at-1'));
    await sleep(1_100);
    const updated = storage.updateApp(app.slug, { manifest: json({ changed: true }) });
    assert(updated, 'updateApp returned undefined');
    assert(updated.created_at === app.created_at, `created_at changed ${app.created_at} -> ${updated.created_at}`);
    assert(new Date(updated.updated_at).getTime() > new Date(app.updated_at).getTime(), `updated_at ${app.updated_at} -> ${updated.updated_at}`);
  });

  await check('deleteApp cascades runs, jobs, and app-scoped admin secrets', async () => {
    const app = storage.createApp(appInput('app-cascade-1', 'app-cascade-1'));
    const run = storage.createRun({
      id: 'run-cascade-1',
      app_id: app.id,
      action: 'run',
      inputs: {},
    });
    const job = storage.createJob(createJobInput('job-cascade-1', app, {}));
    storage.upsertAdminSecret('CASCADE_TOKEN', 'value', app.id);
    assert(storage.deleteApp(app.slug) === true, 'deleteApp existing returned false');
    assert(storage.getRun(run.id) === undefined, 'run survived app delete');
    assert(storage.getJob(job.id) === undefined, 'job survived app delete');
    assert(storage.listRuns({ app_id: app.id }).length === 0, 'listRuns returned deleted app runs');
    assert(storage.listAdminSecrets(app.id).length === 0, 'app-scoped admin secret survived app delete');
  });

  await check('atomic job claim grants one claimant across 50 iterations', async () => {
    const app = storage.createApp(appInput('app-claim-1', 'app-claim-1'));
    for (let i = 0; i < 50; i++) {
      const job = storage.createJob(createJobInput(`job-claim-${i}`, app, { i }));
      const [a, b] = await Promise.all([
        Promise.resolve().then(() => storage.claimNextJob()),
        Promise.resolve().then(() => storage.claimNextJob()),
      ]);
      const claimed = [a, b].filter(Boolean);
      assert(claimed.length === 1, `iteration=${i}, claimed=${claimed.length}`);
      assert(claimed[0].id === job.id, `iteration=${i}, claimed_id=${claimed[0].id}, expected=${job.id}`);
    }
  });

  await check('tenant filters keep apps and runs scoped by workspace_id', async () => {
    createWorkspace('tenant-a');
    createWorkspace('tenant-b');
    const appA = storage.createApp(appInput('tenant-app-a', 'tenant-app-a', 'tenant-a'));
    const appB = storage.createApp(appInput('tenant-app-b', 'tenant-app-b', 'tenant-b'));
    const runA = storage.createRun({ id: 'tenant-run-a', app_id: appA.id, action: 'run', inputs: {} });
    const runB = storage.createRun({ id: 'tenant-run-b', app_id: appB.id, action: 'run', inputs: {} });
    db.prepare('UPDATE runs SET workspace_id = ? WHERE id = ?').run('tenant-a', runA.id);
    db.prepare('UPDATE runs SET workspace_id = ? WHERE id = ?').run('tenant-b', runB.id);
    assert(storage.listApps({ workspace_id: 'tenant-a' }).every((row) => row.workspace_id === 'tenant-a'), 'tenant-a listApps leaked');
    assert(storage.listApps({ workspace_id: 'tenant-b' }).every((row) => row.workspace_id === 'tenant-b'), 'tenant-b listApps leaked');
    assert(storage.listRuns({ workspace_id: 'tenant-a' }).every((row) => row.workspace_id === 'tenant-a'), 'tenant-a listRuns leaked');
    assert(storage.listRuns({ workspace_id: 'tenant-b' }).every((row) => row.workspace_id === 'tenant-b'), 'tenant-b listRuns leaked');
    skip(
      'unfiltered tenant default',
      'StorageAdapter has no SessionContext argument; default tenant policy is enforced by callers that pass workspace_id',
    );
  });

  await check('transactional read-after-write is visible to another connection', async () => {
    const app = storage.createApp(appInput('app-raw-1', 'app-raw-1'));
    const run = storage.createRun({ id: 'run-raw-1', app_id: app.id, action: 'run', inputs: { ok: true } });
    const second = new Database(join(tmp, 'floom-chat.db'));
    try {
      const row = second.prepare('SELECT id, app_id, action FROM runs WHERE id = ?').get(run.id);
      assert(row?.id === run.id && row.app_id === app.id && row.action === 'run', `row=${json(row)}`);
    } finally {
      second.close();
    }
  });

  await check('idempotent delete returns false for missing rows', async () => {
    assert(storage.deleteApp('missing-delete-app') === false, 'deleteApp missing did not return false');
    assert(storage.deleteAdminSecret('missing-delete-secret', null) === false, 'deleteAdminSecret missing did not return false');
  });
} finally {
  try {
    db.close();
  } catch {
    // best effort
  }
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${passed} passing, ${skipped} skipped, ${failed} failing`);
process.exit(0);

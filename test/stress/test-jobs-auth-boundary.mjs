#!/usr/bin/env node
// Async jobs ownership boundary.
//
// Public app access is not enough to read or cancel another caller's job. The
// job itself is scoped by workspace/user for authenticated callers and by
// workspace/device for anonymous callers.
//
// Run: node test/stress/test-jobs-auth-boundary.mjs

import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { Hono } = require('../../apps/server/node_modules/hono');

const tmp = mkdtempSync(join(tmpdir(), 'floom-jobs-auth-'));
process.env.DATA_DIR = tmp;
process.env.FLOOM_DISABLE_JOB_WORKER = 'true';
process.env.FLOOM_DISABLE_TRIGGERS_WORKER = 'true';
process.env.FLOOM_CLOUD_MODE = 'true';
process.env.BETTER_AUTH_SECRET =
  '0'.repeat(16) + '1'.repeat(16) + '2'.repeat(16) + '3'.repeat(16);
process.env.BETTER_AUTH_URL = 'http://localhost:3051';

const { db } = await import('../../apps/server/dist/db.js');
const auth = await import('../../apps/server/dist/lib/better-auth.js');
const { jobsRouter } = await import('../../apps/server/dist/routes/jobs.js');

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

async function request(method, path, body) {
  const headers = {};
  const init = { method, headers };
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
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

function seedAsyncApp() {
  db.prepare(
    `INSERT INTO apps (
       id, slug, name, description, manifest, status, code_path, app_type,
       visibility, is_async, workspace_id, author
     )
     VALUES (?, ?, ?, ?, ?, 'active', ?, 'proxied', 'public', 1, 'local', 'local')`,
  ).run(
    'app_jobs_boundary',
    'jobs-boundary',
    'Jobs Boundary',
    'Public async app used by job ownership tests.',
    JSON.stringify({
      name: 'Jobs Boundary',
      description: 'x',
      runtime: 'python',
      python_dependencies: [],
      node_dependencies: {},
      secrets_needed: [],
      manifest_version: '2.0',
      actions: {
        run: {
          label: 'Run',
          inputs: [],
          outputs: [],
        },
      },
    }),
    'proxied:jobs-boundary',
  );
}

console.log('Async jobs auth boundary');

auth._resetAuthForTests();
const better = auth.getAuth();
let fakeUser = null;
better.api.getSession = async () => {
  if (!fakeUser) return null;
  return {
    user: fakeUser,
    session: { id: `sess_${fakeUser.id}` },
  };
};

seedAsyncApp();

const app = new Hono();
app.route('/api/:slug/jobs', jobsRouter);

fakeUser = { id: 'usr_alice_jobs', email: 'alice.jobs@floom.dev', name: 'Alice' };
const create = await request('POST', '/api/jobs-boundary/jobs', {
  action: 'run',
  inputs: {},
});
const jobId = create.json?.job_id;
log('owner enqueue: 202 + job_id', create.status === 202 && typeof jobId === 'string', create.text);

const persisted = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
log('job row stores owner user_id', persisted?.user_id === 'usr_alice_jobs', persisted?.user_id);
log(
  'job row stores owner workspace_id',
  typeof persisted?.workspace_id === 'string' && persisted.workspace_id.startsWith('ws_'),
  persisted?.workspace_id,
);

const ownerRead = await request('GET', `/api/jobs-boundary/jobs/${jobId}`);
log('owner poll: 200', ownerRead.status === 200, ownerRead.text);
log('owner poll: response hides user_id', !Object.hasOwn(ownerRead.json || {}, 'user_id'));
log('owner poll: response hides workspace_id', !Object.hasOwn(ownerRead.json || {}, 'workspace_id'));

fakeUser = { id: 'usr_bob_jobs', email: 'bob.jobs@floom.dev', name: 'Bob' };
const bobRead = await request('GET', `/api/jobs-boundary/jobs/${jobId}`);
log('different user poll: 404', bobRead.status === 404, bobRead.text);

const bobCancel = await request('POST', `/api/jobs-boundary/jobs/${jobId}/cancel`);
log('different user cancel: 404', bobCancel.status === 404, bobCancel.text);

fakeUser = { id: 'usr_alice_jobs', email: 'alice.jobs@floom.dev', name: 'Alice' };
const ownerCancel = await request('POST', `/api/jobs-boundary/jobs/${jobId}/cancel`);
log('owner cancel: 200', ownerCancel.status === 200, ownerCancel.text);
log('owner cancel: status=cancelled', ownerCancel.json?.status === 'cancelled', ownerCancel.text);

db.close();
rmSync(tmp, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

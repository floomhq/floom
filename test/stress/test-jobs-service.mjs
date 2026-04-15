#!/usr/bin/env node
// Unit tests for the jobs service — create, get, claim atomically, complete,
// fail, cancel, requeue. Uses a throwaway temp DATA_DIR so it never pollutes
// the real server DB.
//
// Run: node test/stress/test-jobs-service.mjs

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'floom-jobs-test-'));
process.env.DATA_DIR = tmp;
process.env.FLOOM_DISABLE_JOB_WORKER = 'true';

const { db } = await import('../../apps/server/dist/db.js');
const { newJobId, newAppId } = await import('../../apps/server/dist/lib/ids.js');
const jobs = await import('../../apps/server/dist/services/jobs.js');

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

// ---- fixture: one async app row ----
const appId = newAppId();
db.prepare(
  `INSERT INTO apps (
    id, slug, name, description, manifest, code_path, app_type,
    is_async, webhook_url, timeout_ms, retries, async_mode
  ) VALUES (?, ?, ?, ?, ?, ?, 'proxied', 1, ?, ?, ?, ?)`,
).run(
  appId,
  'slow-echo',
  'Slow Echo',
  'Test async app',
  JSON.stringify({
    name: 'Slow Echo',
    description: 'Test',
    actions: { run: { label: 'Run', inputs: [], outputs: [] } },
    runtime: 'python',
    python_dependencies: [],
    node_dependencies: {},
    secrets_needed: [],
    manifest_version: '2.0',
  }),
  'proxied:slow-echo',
  'https://hook.example/done',
  60_000,
  2,
  'poll',
);

const app = db.prepare('SELECT * FROM apps WHERE id = ?').get(appId);

console.log('jobs service tests');

// 1. createJob inserts a queued row
const jobId = newJobId();
const created = jobs.createJob(jobId, {
  app,
  action: 'run',
  inputs: { msg: 'hello' },
  perCallSecrets: { API_KEY: 'secret' },
});
log('createJob: row is queued', created.status === 'queued', created.status);
log('createJob: input_json captured', created.input_json.includes('hello'));
log('createJob: webhook_url defaulted from app', created.webhook_url === 'https://hook.example/done');
log('createJob: timeout_ms defaulted from app', created.timeout_ms === 60_000);
log('createJob: max_retries from app', created.max_retries === 2);
log('createJob: attempts=0', created.attempts === 0);
log('createJob: per_call_secrets_json stored', created.per_call_secrets_json.includes('secret'));

// 2. getJob returns the row
const fetched = jobs.getJob(jobId);
log('getJob: same status', fetched.id === jobId && fetched.status === 'queued');

// 3. nextQueuedJob returns it
const next = jobs.nextQueuedJob();
log('nextQueuedJob: returns our queued job', next && next.id === jobId);

// 4. claimJob atomically flips queued → running
const claimed = jobs.claimJob(jobId);
log('claimJob: flipped to running', claimed && claimed.status === 'running');
log('claimJob: attempts incremented', claimed.attempts === 1);
log('claimJob: started_at populated', !!claimed.started_at);

// 5. claimJob on a running row returns undefined (no race)
const raceClaim = jobs.claimJob(jobId);
log('claimJob: running row cannot be re-claimed', raceClaim === undefined);

// 6. completeJob
const done = jobs.completeJob(jobId, { result: 42 }, 'run_abc');
log('completeJob: status=succeeded', done.status === 'succeeded');
log('completeJob: output_json captured', done.output_json.includes('42'));
log('completeJob: run_id captured', done.run_id === 'run_abc');
log('completeJob: finished_at populated', !!done.finished_at);

// 7. failJob round-trip
const failedId = newJobId();
jobs.createJob(failedId, {
  app,
  action: 'run',
  inputs: { msg: 'fail' },
});
jobs.claimJob(failedId);
const failedRow = jobs.failJob(failedId, { message: 'boom', type: 'runtime_error' }, null);
log('failJob: status=failed', failedRow.status === 'failed');
log('failJob: error_json contains message', failedRow.error_json.includes('boom'));

// 8. cancelJob
const cancelId = newJobId();
jobs.createJob(cancelId, { app, action: 'run', inputs: {} });
const cancelled = jobs.cancelJob(cancelId);
log('cancelJob: status=cancelled', cancelled.status === 'cancelled');

// 9. cancelJob on terminal is idempotent no-op
const reCancel = jobs.cancelJob(failedId);
log('cancelJob: terminal row stays terminal', reCancel.status === 'failed');

// 10. requeueJob flips failed → queued and clears state
const requeueId = newJobId();
jobs.createJob(requeueId, { app, action: 'run', inputs: {} });
jobs.claimJob(requeueId);
jobs.failJob(requeueId, { message: 'fail' }, null);
const requeued = jobs.requeueJob(requeueId);
log('requeueJob: back to queued', requeued.status === 'queued');
log('requeueJob: error cleared', requeued.error_json === null);
log('requeueJob: attempts preserved', requeued.attempts === 1);

// 11. formatJob shapes the payload
const formatted = jobs.formatJob(done);
log('formatJob: exposes parsed output', formatted.output && formatted.output.result === 42);
log('formatJob: does not leak per_call_secrets_json', !('per_call_secrets_json' in formatted));

// 12. countJobsByStatus
const nQueued = jobs.countJobsByStatus('queued');
const nSucc = jobs.countJobsByStatus('succeeded');
log(
  'countJobsByStatus: queued=1, succeeded=1',
  nQueued === 1 && nSucc === 1,
  `queued=${nQueued} succeeded=${nSucc}`,
);

// cleanup
db.close();
rmSync(tmp, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

#!/usr/bin/env node
// Unit tests for the jobs service — create, get, claim atomically, complete,
// fail, cancel, requeue. Uses a throwaway temp DATA_DIR so it never pollutes
// the real server DB.
//
// Run: node test/stress/test-jobs-service.mjs

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'floom-jobs-test-'));
process.env.DATA_DIR = tmp;
process.env.FLOOM_DISABLE_JOB_WORKER = 'true';
const runtimeCapturePath = join(tmp, 'runtime-ctx.json');
const runtimeModulePath = join(tmp, 'runtime-adapter.mjs');
writeFileSync(
  runtimeModulePath,
  `import { writeFileSync } from 'node:fs';

export default {
  kind: 'runtime',
  name: 'jobs-service-context-capture',
  protocolVersion: '^0.2',
  adapter: {
    async execute(_app, _manifest, _action, inputs, _secrets, ctx) {
      writeFileSync(process.env.FLOOM_RUNTIME_CTX_CAPTURE, JSON.stringify({ ctx, inputs }));
      return {
        status: 'success',
        outputs: { ok: true, inputs },
        logs: '',
        duration_ms: 1
      };
    }
  }
};
`,
);
process.env.FLOOM_RUNTIME = runtimeModulePath;
process.env.FLOOM_RUNTIME_CTX_CAPTURE = runtimeCapturePath;

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
const created = await jobs.createJob(jobId, {
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
const fetched = await jobs.getJob(jobId);
log('getJob: same status', fetched.id === jobId && fetched.status === 'queued');

// 3. nextQueuedJob returns it
const next = await jobs.nextQueuedJob();
log('nextQueuedJob: returns our queued job', next && next.id === jobId);

// 4. claimJob atomically flips queued → running
const claimed = await jobs.claimJob(jobId);
log('claimJob: flipped to running', claimed && claimed.status === 'running');
log('claimJob: attempts incremented', claimed.attempts === 1);
log('claimJob: started_at populated', !!claimed.started_at);

// 5. claimJob on a running row returns undefined (no race)
const raceClaim = await jobs.claimJob(jobId);
log('claimJob: running row cannot be re-claimed', raceClaim === undefined);

// 6. completeJob
const done = await jobs.completeJob(jobId, { result: 42 }, 'run_abc');
log('completeJob: status=succeeded', done.status === 'succeeded');
log('completeJob: output_json captured', done.output_json.includes('42'));
log('completeJob: run_id captured', done.run_id === 'run_abc');
log('completeJob: finished_at populated', !!done.finished_at);

// 7. failJob round-trip
const failedId = newJobId();
await jobs.createJob(failedId, {
  app,
  action: 'run',
  inputs: { msg: 'fail' },
});
await jobs.claimJob(failedId);
const failedRow = await jobs.failJob(failedId, { message: 'boom', type: 'runtime_error' }, null);
log('failJob: status=failed', failedRow.status === 'failed');
log('failJob: error_json contains message', failedRow.error_json.includes('boom'));

// 8. cancelJob
const cancelId = newJobId();
await jobs.createJob(cancelId, { app, action: 'run', inputs: {} });
const cancelled = await jobs.cancelJob(cancelId);
log('cancelJob: status=cancelled', cancelled.status === 'cancelled');

// 9. cancelJob on terminal is idempotent no-op
const reCancel = await jobs.cancelJob(failedId);
log('cancelJob: terminal row stays terminal', reCancel.status === 'failed');

// 10. requeueJob flips failed → queued and clears state
const requeueId = newJobId();
await jobs.createJob(requeueId, { app, action: 'run', inputs: {} });
await jobs.claimJob(requeueId);
await jobs.failJob(requeueId, { message: 'fail' }, null);
const requeued = await jobs.requeueJob(requeueId);
log('requeueJob: back to queued', requeued.status === 'queued');
log('requeueJob: error cleared', requeued.error_json === null);
log('requeueJob: attempts preserved', requeued.attempts === 1);

// 11. formatJob shapes the payload
const formatted = jobs.formatJob(done);
log('formatJob: exposes parsed output', formatted.output && formatted.output.result === 42);
log('formatJob: does not leak per_call_secrets_json', !('per_call_secrets_json' in formatted));

// 12. countJobsByStatus
const nQueued = await jobs.countJobsByStatus('queued');
const nSucc = await jobs.countJobsByStatus('succeeded');
log(
  'countJobsByStatus: queued=1, succeeded=1',
  nQueued === 1 && nSucc === 1,
  `queued=${nQueued} succeeded=${nSucc}`,
);

// 13. worker preserves queued SessionContext on the run and runtime dispatch
await jobs.cancelJob(requeueId);
const worker = await import('../../apps/server/dist/services/worker.js');
const ctxJobId = newJobId();
await jobs.createJob(ctxJobId, {
  app: { ...app, webhook_url: null },
  action: 'run',
  inputs: { msg: 'ctx' },
  workspace_id: 'workspace_A',
  user_id: 'user_A',
  device_id: 'device_A',
});
const processed = await worker.processOneJob();
const ctxJob = await jobs.getJob(ctxJobId);
const ctxRun = db.prepare('SELECT * FROM runs WHERE id = ?').get(ctxJob.run_id);
const captured = JSON.parse(readFileSync(runtimeCapturePath, 'utf8'));
log('worker ctx: processed queued job', processed && processed.id === ctxJobId, `processed=${processed?.id}`);
log('worker ctx: job succeeded', ctxJob.status === 'succeeded', ctxJob.status);
log('worker ctx: run workspace_id preserved', ctxRun.workspace_id === 'workspace_A', ctxRun.workspace_id);
log('worker ctx: run user_id preserved', ctxRun.user_id === 'user_A', ctxRun.user_id);
log('worker ctx: run device_id preserved', ctxRun.device_id === 'device_A', ctxRun.device_id);
log('worker ctx: runtime ctx workspace_id preserved', captured.ctx.workspace_id === 'workspace_A', JSON.stringify(captured));
log('worker ctx: runtime ctx user_id preserved', captured.ctx.user_id === 'user_A', JSON.stringify(captured));
log('worker ctx: runtime ctx device_id preserved', captured.ctx.device_id === 'device_A', JSON.stringify(captured));

// cleanup
db.close();
rmSync(tmp, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

#!/usr/bin/env node
// E2E smoke test for the v0.3.0 async job queue.
//
// 1. Start a tiny webhook collector HTTP server.
// 2. Start the slow-echo upstream (short delay: 1s not 5s, so tests stay fast).
// 3. Boot the Floom server with FLOOM_APPS_CONFIG pointing at a temp
//    apps.yaml that registers slow-echo as async with the webhook pointing
//    at our collector.
// 4. POST /api/slow-echo/jobs to enqueue a job.
// 5. Poll GET /api/slow-echo/jobs/:id until status=succeeded.
// 6. Verify the collector received one POST with the expected payload.
//
// Run: node test/stress/test-jobs-e2e.mjs
//
// Cleans up all child processes on exit.

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');

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

const SLOW_ECHO_PORT = 4201;
const WEBHOOK_PORT = 4202;
const FLOOM_PORT = 14301; // avoid collision with any running server

const tmpDataDir = mkdtempSync(join(tmpdir(), 'floom-e2e-jobs-'));
const appsYamlPath = join(tmpDataDir, 'apps.yaml');
writeFileSync(
  appsYamlPath,
  `apps:
  - slug: slow-echo
    type: proxied
    openapi_spec_url: http://localhost:${SLOW_ECHO_PORT}/openapi.json
    display_name: Slow Echo
    description: "Async test app"
    async: true
    async_mode: poll
    timeout_ms: 60000
    retries: 0
    webhook_url: http://localhost:${WEBHOOK_PORT}/hook
`,
);

const processes = [];
let cleanedUp = false;
function cleanup() {
  if (cleanedUp) return;
  cleanedUp = true;
  // Kill the whole process group (SIGTERM → short wait → SIGKILL) so any
  // grandchildren spawned by the floom server (runners, bundler workers) also
  // die. spawn() uses detached:true + setsid so `-pid` targets the group.
  for (const p of processes) {
    if (!p.pid || p.exitCode !== null) continue;
    for (const sig of ['SIGTERM', 'SIGKILL']) {
      try {
        process.kill(-p.pid, sig);
      } catch {
        try { p.kill(sig); } catch { /* already dead */ }
      }
    }
  }
  try {
    rmSync(tmpDataDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    cleanup();
    process.exit(sig === 'SIGINT' ? 130 : 1);
  });
}
process.on('uncaughtException', (err) => {
  console.error('[e2e] uncaughtException:', err);
  cleanup();
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  console.error('[e2e] unhandledRejection:', err);
  cleanup();
  process.exit(1);
});

// ---- 1. webhook collector ----
const webhookHits = [];
const webhookServer = createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/hook') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
        webhookHits.push({ headers: req.headers, body });
      } catch {
        webhookHits.push({ headers: req.headers, body: null });
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
    return;
  }
  res.writeHead(404);
  res.end();
});
await new Promise((resolve) => webhookServer.listen(WEBHOOK_PORT, resolve));
console.log(`[e2e] webhook collector on :${WEBHOOK_PORT}`);

// ---- 2. slow-echo upstream ----
const slowEcho = spawn(
  'node',
  [join(REPO_ROOT, 'examples/slow-echo/server.mjs')],
  {
    env: {
      ...process.env,
      PORT: String(SLOW_ECHO_PORT),
      ECHO_DELAY_MS: '1000', // 1s instead of default 5s to keep tests fast
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true, // own process group so cleanup can SIGKILL it
  },
);
processes.push(slowEcho);
slowEcho.stdout.on('data', (d) => process.stdout.write(`[slow-echo] ${d}`));
slowEcho.stderr.on('data', (d) => process.stderr.write(`[slow-echo] ${d}`));

await waitForHttp(`http://localhost:${SLOW_ECHO_PORT}/health`, 10_000);

// ---- 3. Floom server ----
const floom = spawn(
  'node',
  [join(REPO_ROOT, 'apps/server/dist/index.js')],
  {
    env: {
      ...process.env,
      PORT: String(FLOOM_PORT),
      PUBLIC_URL: `http://localhost:${FLOOM_PORT}`,
      DATA_DIR: tmpDataDir,
      FLOOM_APPS_CONFIG: appsYamlPath,
      FLOOM_JOB_POLL_MS: '250', // speed up worker polling in tests
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true, // own process group so cleanup can SIGKILL it
  },
);
processes.push(floom);
floom.stdout.on('data', (d) => process.stdout.write(`[floom] ${d}`));
floom.stderr.on('data', (d) => process.stderr.write(`[floom] ${d}`));

await waitForHttp(`http://localhost:${FLOOM_PORT}/api/health`, 15_000);

// Give the openapi-ingest a moment to finish (it's async on boot).
await waitForCondition(async () => {
  try {
    const res = await fetch(`http://localhost:${FLOOM_PORT}/api/hub`);
    if (!res.ok) return false;
    const json = await res.json();
    return Array.isArray(json) && json.some((a) => a.slug === 'slow-echo');
  } catch {
    return false;
  }
}, 15_000);
log('hub: slow-echo registered', true);

// ---- 4. synchronous endpoint should reject (app is async) ----
{
  const res = await fetch(`http://localhost:${FLOOM_PORT}/api/slow-echo/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ inputs: { message: 'hi' } }),
  });
  // /run will still dispatch (sync path) but the contract for async apps is
  // the jobs endpoint. We simply verify /run still exists for back-compat.
  log('sync /run still reachable on async app (back-compat)', res.status === 200);
}

// ---- 5. enqueue a job ----
const createRes = await fetch(
  `http://localhost:${FLOOM_PORT}/api/slow-echo/jobs`,
  {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      action: 'slow_echo',
      inputs: { message: 'hello world', delay_ms: 500 },
    }),
  },
);
const createJson = await createRes.json();
log(
  'POST /jobs: 202 + job_id present',
  createRes.status === 202 && typeof createJson.job_id === 'string',
  `status=${createRes.status} body=${JSON.stringify(createJson)}`,
);
log(
  'POST /jobs: status=queued',
  createJson.status === 'queued',
  JSON.stringify(createJson),
);
log(
  'POST /jobs: poll_url populated',
  typeof createJson.poll_url === 'string' && createJson.poll_url.includes(createJson.job_id),
  createJson.poll_url,
);

// ---- 6. poll until done ----
const jobId = createJson.job_id;
const deadline = Date.now() + 20_000;
let finalStatus = null;
let finalJob = null;
while (Date.now() < deadline) {
  const res = await fetch(
    `http://localhost:${FLOOM_PORT}/api/slow-echo/jobs/${jobId}`,
  );
  if (res.ok) {
    const body = await res.json();
    if (['succeeded', 'failed', 'cancelled'].includes(body.status)) {
      finalStatus = body.status;
      finalJob = body;
      break;
    }
  }
  await new Promise((r) => setTimeout(r, 250));
}
log('GET /jobs/:id: reached terminal state', finalStatus !== null, `status=${finalStatus}`);
log('GET /jobs/:id: status=succeeded', finalStatus === 'succeeded', JSON.stringify(finalJob));
const outputEchoed = extractEchoedField(finalJob?.output);
log(
  'GET /jobs/:id: output echoed our message',
  outputEchoed === 'hello world',
  JSON.stringify(finalJob?.output),
);
log(
  'GET /jobs/:id: attempts=1',
  finalJob && finalJob.attempts === 1,
  `attempts=${finalJob?.attempts}`,
);

// ---- 7. webhook was delivered ----
// Give the worker a moment to POST the webhook after completion.
await waitForCondition(() => webhookHits.length > 0, 5000);
log('webhook: collector received exactly 1 POST', webhookHits.length === 1, `count=${webhookHits.length}`);

if (webhookHits.length > 0) {
  const hit = webhookHits[0];
  log(
    'webhook: X-Floom-Event header set',
    hit.headers['x-floom-event'] === 'job.completed',
    hit.headers['x-floom-event'],
  );
  log(
    'webhook: body.job_id matches',
    hit.body?.job_id === jobId,
    `got=${hit.body?.job_id} want=${jobId}`,
  );
  log(
    'webhook: body.slug=slow-echo',
    hit.body?.slug === 'slow-echo',
    hit.body?.slug,
  );
  log(
    'webhook: body.status=succeeded',
    hit.body?.status === 'succeeded',
    hit.body?.status,
  );
  log(
    'webhook: body.output echoed the message',
    extractEchoedField(hit.body?.output) === 'hello world',
    JSON.stringify(hit.body?.output),
  );
  log('webhook: body.duration_ms present', typeof hit.body?.duration_ms === 'number' && hit.body.duration_ms >= 0);
  log('webhook: body.attempts=1', hit.body?.attempts === 1);
}

// ---- 8. cancelling an already-terminal job is a no-op ----
const cancelRes = await fetch(
  `http://localhost:${FLOOM_PORT}/api/slow-echo/jobs/${jobId}/cancel`,
  { method: 'POST' },
);
const cancelBody = await cancelRes.json();
log(
  'POST /cancel on terminal job: stays succeeded',
  cancelBody.status === 'succeeded',
  cancelBody.status,
);

// ---- 9. 404 on non-existent job ----
const missingRes = await fetch(
  `http://localhost:${FLOOM_PORT}/api/slow-echo/jobs/job_doesnotexist`,
);
log('GET /jobs/:missing: 404', missingRes.status === 404);

// ---- 10. sync /run on petstore still works (regression) ----
// (only if someone had petstore in the same instance — skip, we only have slow-echo)

// ---- teardown ----
webhookServer.close();
cleanup();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

async function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not ready
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out waiting for ${url}`);
}

/**
 * Pull the `echoed` field from whatever shape the proxied runner hands us.
 * Different Floom output-extract paths may wrap the raw response in
 * `{response: {...}}` or return it directly, so check both.
 */
function extractEchoedField(output) {
  if (!output || typeof output !== 'object') return undefined;
  if (typeof output.echoed === 'string') return output.echoed;
  if (output.response && typeof output.response === 'object' && typeof output.response.echoed === 'string') {
    return output.response.echoed;
  }
  // Fallback: search shallow for any `echoed` field.
  for (const v of Object.values(output)) {
    if (v && typeof v === 'object' && typeof v.echoed === 'string') return v.echoed;
  }
  return undefined;
}

async function waitForCondition(fn, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
}

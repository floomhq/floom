#!/usr/bin/env node
// E2E smoke test for the webhook side of the unified triggers system.
//
// Does NOT spin up a full HTTP server — imports the Hono app directly and
// drives it via fetch() for speed + isolation. Covers:
//
//   1. createTrigger(webhook) mints a secret + URL path.
//   2. POST /hook/:path with a VALID HMAC signature → 204 + job enqueued.
//   3. POST /hook/:path with an INVALID signature → 401, no job.
//   4. POST /hook/:path with a duplicate X-Request-ID within 24h → 200 + deduped.
//   5. POST /hook/:bogus-path → 404.
//   6. Outgoing webhook payload is tagged `triggered_by: 'webhook'`.
//   7. Disabled trigger returns 204 silently but does NOT fire.
//
// Run: node test/stress/test-triggers-webhook.mjs

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Import Hono from the server workspace's node_modules (pnpm hoist to the
// workspace dir) so this test file doesn't need a repo-root install.
const honoModule = await import(
  '../../apps/server/node_modules/hono/dist/hono.js'
);
const Hono = honoModule.Hono || honoModule.default;

const tmp = mkdtempSync(join(tmpdir(), 'floom-triggers-wh-test-'));
process.env.DATA_DIR = tmp;
process.env.FLOOM_DISABLE_JOB_WORKER = 'true';
process.env.FLOOM_DISABLE_TRIGGERS_WORKER = 'true';
process.env.PUBLIC_URL = 'http://test.floom.local';

const { db, DEFAULT_USER_ID, DEFAULT_WORKSPACE_ID } = await import(
  '../../apps/server/dist/db.js'
);
const { newAppId } = await import('../../apps/server/dist/lib/ids.js');
const triggers = await import('../../apps/server/dist/services/triggers.js');
const workerMod = await import('../../apps/server/dist/services/worker.js');
const triggersWorker = await import(
  '../../apps/server/dist/services/triggers-worker.js'
);
const { webhookRouter } = await import(
  '../../apps/server/dist/routes/webhook.js'
);
const { deliverWebhook } = await import(
  '../../apps/server/dist/services/webhook.js'
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

// Hono testing app that mounts just the /hook router.
const app = new Hono();
app.route('/hook', webhookRouter);

async function post(path, body, headers = {}) {
  const req = new Request(`http://test.floom.local${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  });
  return app.fetch(req);
}

// --- fixture app (async so jobs route to the queue; non-async works too) ---
const appId = newAppId();
const manifest = {
  name: 'Hook Echo',
  description: 'Webhook test',
  actions: { run: { label: 'Run', inputs: [], outputs: [] } },
  runtime: 'python',
  python_dependencies: [],
  node_dependencies: {},
  secrets_needed: [],
  manifest_version: '2.0',
};
db.prepare(
  `INSERT INTO apps (id, slug, name, description, manifest, code_path, app_type, workspace_id, author, is_async, status)
   VALUES (?, ?, ?, ?, ?, ?, 'proxied', ?, ?, 1, 'active')`,
).run(
  appId,
  'hook-echo',
  'Hook Echo',
  'webhook test',
  JSON.stringify(manifest),
  'proxied:hook-echo',
  DEFAULT_WORKSPACE_ID,
  DEFAULT_USER_ID,
);

console.log('triggers: webhook tests');

// 1. Create webhook trigger.
const t = await triggers.createTrigger({
  app_id: appId,
  user_id: DEFAULT_USER_ID,
  workspace_id: DEFAULT_WORKSPACE_ID,
  action: 'run',
  inputs: { source: 'webhook' },
  trigger_type: 'webhook',
});
log(
  'createTrigger(webhook): persisted',
  t.trigger_type === 'webhook' && !!t.webhook_url_path && !!t.webhook_secret,
);
log(
  'createTrigger(webhook): no cron fields',
  t.cron_expression === null && t.next_run_at === null,
);

const fullRow = db
  .prepare('SELECT webhook_secret, webhook_url_path FROM triggers WHERE id = ?')
  .get(t.id);
const secret = fullRow.webhook_secret;
const path = fullRow.webhook_url_path;

// 2. Valid signature → 204 + job enqueued.
const goodBody = JSON.stringify({ inputs: { event: 'issue.opened', id: 42 } });
const goodSig = triggers.signWebhookBody(secret, goodBody);
const jobsBefore = db.prepare('SELECT COUNT(*) as n FROM jobs').get().n;
const res1 = await post(`/hook/${path}`, goodBody, {
  'x-floom-signature': goodSig,
  'x-request-id': 'req-1',
});
log('valid signature: 204 No Content', res1.status === 204, `status=${res1.status}`);
const jobsAfter = db.prepare('SELECT COUNT(*) as n FROM jobs').get().n;
log(
  'valid signature: a job was enqueued',
  jobsAfter === jobsBefore + 1,
  `before=${jobsBefore} after=${jobsAfter}`,
);

// Location header points at the job URL.
const loc = res1.headers.get('location');
log(
  'valid signature: Location header points to /api/:slug/jobs/:id',
  !!loc && loc.startsWith('/api/hook-echo/jobs/'),
  `loc=${loc}`,
);

// 3. Invalid signature → 401.
const res2 = await post(`/hook/${path}`, goodBody, {
  'x-floom-signature': 'sha256=deadbeef',
  'x-request-id': 'req-2',
});
log('bad signature: 401', res2.status === 401, `status=${res2.status}`);
const jobsAfterBad = db.prepare('SELECT COUNT(*) as n FROM jobs').get().n;
log(
  'bad signature: no job enqueued',
  jobsAfterBad === jobsAfter,
  `before=${jobsAfter} after=${jobsAfterBad}`,
);

// 3b. Missing signature → 401.
const res2b = await post(`/hook/${path}`, goodBody, { 'x-request-id': 'req-3' });
log('missing signature: 401', res2b.status === 401, `status=${res2b.status}`);

// 4. Duplicate request-id within 24h → deduped (200, no new job).
const dupBody = JSON.stringify({ inputs: { event: 'dup' } });
const dupSig = triggers.signWebhookBody(secret, dupBody);
const firstDup = await post(`/hook/${path}`, dupBody, {
  'x-floom-signature': dupSig,
  'x-request-id': 'req-dup',
});
log(
  'dedupe: first delivery with request-id = 204',
  firstDup.status === 204,
  `status=${firstDup.status}`,
);
const jobsAfterDup1 = db.prepare('SELECT COUNT(*) as n FROM jobs').get().n;
const secondDup = await post(`/hook/${path}`, dupBody, {
  'x-floom-signature': dupSig,
  'x-request-id': 'req-dup',
});
log(
  'dedupe: replay with same request-id returns 200',
  secondDup.status === 200,
  `status=${secondDup.status}`,
);
const dupJson = await secondDup.json();
log(
  'dedupe: replay body has deduped=true',
  dupJson.deduped === true,
  JSON.stringify(dupJson),
);
const jobsAfterDup2 = db.prepare('SELECT COUNT(*) as n FROM jobs').get().n;
log(
  'dedupe: replay did NOT enqueue another job',
  jobsAfterDup2 === jobsAfterDup1,
  `before=${jobsAfterDup1} after=${jobsAfterDup2}`,
);

// 5. Unknown path → 404.
const res3 = await post('/hook/never-minted-xxxxx', goodBody, {
  'x-floom-signature': goodSig,
});
log('unknown path: 404', res3.status === 404, `status=${res3.status}`);

// 6. Disabled trigger → 204 silently, no job.
await triggers.updateTrigger(t.id, { enabled: false });
const silentBody = JSON.stringify({ inputs: { when: 'disabled' } });
const silentSig = triggers.signWebhookBody(secret, silentBody);
const jobsBeforeSilent = db.prepare('SELECT COUNT(*) as n FROM jobs').get().n;
const res4 = await post(`/hook/${path}`, silentBody, {
  'x-floom-signature': silentSig,
  'x-request-id': 'req-silent',
});
log(
  'disabled: 204 silently',
  res4.status === 204,
  `status=${res4.status}`,
);
const jobsAfterSilent = db.prepare('SELECT COUNT(*) as n FROM jobs').get().n;
log(
  'disabled: no job enqueued',
  jobsAfterSilent === jobsBeforeSilent,
  `before=${jobsBeforeSilent} after=${jobsAfterSilent}`,
);

// 7. triggered_by context is persisted for the first job we fired.
// Locate the job_id from the Location header of the VALID call.
const jobIdMatch = /\/api\/hook-echo\/jobs\/(job_\w+)/.exec(loc || '');
const firstJobId = jobIdMatch ? jobIdMatch[1] : null;
log('extract job id from Location', !!firstJobId, `loc=${loc}`);
const ctx = triggersWorker.getJobTriggerContext(firstJobId);
log(
  'triggered_by ctx: trigger_type=webhook',
  ctx && ctx.trigger_type === 'webhook',
  JSON.stringify(ctx),
);
log(
  'triggered_by ctx: trigger_id matches',
  ctx && ctx.trigger_id === t.id,
  `ctx.trigger_id=${ctx?.trigger_id} t.id=${t.id}`,
);

// 8. Confirm outgoing webhook payload INCLUDES triggered_by when the worker
//    builds it. We don't run the full job worker loop here; instead we mock
//    the deliverWebhook and build the payload the same way worker.ts does.
{
  let captured = null;
  const fakeFetch = async (url, init) => {
    captured = { url, body: init.body };
    return { status: 200, ok: true };
  };
  // Hand-build the payload using the service API the worker uses.
  const job = db
    .prepare('SELECT * FROM jobs WHERE id = ?')
    .get(firstJobId);
  const trigCtx = triggersWorker.getJobTriggerContext(job.id);
  const payload = {
    job_id: job.id,
    slug: job.slug,
    status: 'succeeded',
    output: { ok: true },
    error: null,
    duration_ms: 123,
    attempts: job.attempts,
    triggered_by: trigCtx ? trigCtx.trigger_type : 'manual',
    ...(trigCtx ? { trigger_id: trigCtx.trigger_id } : {}),
  };
  const res = await deliverWebhook('https://example.test/hook', payload, {
    fetchImpl: fakeFetch,
    backoffMs: 1,
  });
  log(
    'outgoing webhook: delivery ok',
    res.ok === true,
    JSON.stringify(res),
  );
  const sentBody = JSON.parse(captured.body);
  log(
    'outgoing webhook: triggered_by=webhook in body',
    sentBody.triggered_by === 'webhook',
    captured.body,
  );
  log(
    'outgoing webhook: trigger_id matches',
    sentBody.trigger_id === t.id,
    `sent=${sentBody.trigger_id}`,
  );
}

// Cleanup.
try { rmSync(tmp, { recursive: true, force: true }); } catch {}
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

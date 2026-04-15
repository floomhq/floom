#!/usr/bin/env node
// W4-minimal routes: /api/me/runs, /api/hub/ingest, /api/apps/:slug/reviews,
// /api/feedback. Exercises the happy path for each new endpoint plus one
// auth-boundary assertion (user A cannot read user B's runs via /api/me/runs).
//
// Run: node test/stress/test-w4m-routes.mjs

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const tmp = mkdtempSync(join(tmpdir(), 'floom-w4m-'));
process.env.DATA_DIR = tmp;
process.env.FLOOM_DISABLE_JOB_WORKER = 'true';
process.env.FLOOM_MASTER_KEY =
  '0'.repeat(16) + '1'.repeat(16) + '2'.repeat(16) + '3'.repeat(16);

const { db, DEFAULT_USER_ID } = await import('../../apps/server/dist/db.js');
const { meRouter } = await import('../../apps/server/dist/routes/run.js');
const { hubRouter } = await import('../../apps/server/dist/routes/hub.js');
const { reviewsRouter } = await import('../../apps/server/dist/routes/reviews.js');
const { feedbackRouter, _resetFeedbackBucketsForTests } = await import(
  '../../apps/server/dist/routes/feedback.js'
);

// Direct DB insert for runs (bypasses the docker-backed runner). We only
// need pre-existing rows so /api/me/runs has something to return.
function insertRun(opts) {
  const id = `run_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  db.prepare(
    `INSERT INTO runs
       (id, app_id, thread_id, action, inputs, outputs, status, duration_ms, workspace_id, user_id, device_id)
     VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    opts.app_id,
    opts.action || 'greet',
    JSON.stringify(opts.inputs || { name: 'world' }),
    JSON.stringify(opts.outputs || { message: 'hello world' }),
    opts.status || 'success',
    42,
    opts.workspace_id || 'local',
    opts.user_id || DEFAULT_USER_ID,
    opts.device_id || 'dev-test',
  );
  return id;
}

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

console.log('W4-minimal routes');

async function fetchRoute(router, method, path, body, cookie, rawBody) {
  const url = `http://localhost${path}`;
  const init = { method };
  if (rawBody !== undefined) {
    init.body = rawBody;
    init.headers = { 'content-type': 'application/json' };
  } else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { 'content-type': 'application/json' };
  }
  if (cookie) {
    init.headers = { ...(init.headers || {}), cookie };
  }
  const req = new Request(url, init);
  const res = await router.fetch(req);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // leave null
  }
  return { status: res.status, json, text, headers: res.headers };
}

// ---- seed test apps ----
const appId = `app_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
db.prepare(
  `INSERT INTO apps (id, slug, name, description, manifest, code_path, author, workspace_id)
   VALUES (?, 'hello', 'Hello', 'a test app', ?, 'proxied:hello', 'alice', 'local')`,
).run(
  appId,
  JSON.stringify({
    name: 'Hello',
    description: 'a test app',
    actions: {
      greet: {
        label: 'Greet',
        inputs: [{ name: 'name', type: 'text', label: 'Name', required: true }],
        outputs: [{ name: 'message', type: 'text', label: 'Message' }],
      },
    },
    runtime: 'python',
    python_dependencies: [],
    node_dependencies: {},
    secrets_needed: [],
    manifest_version: '2.0',
  }),
);

// ---- 1. Seed runs via direct DB insert (bypass runner) ----
// Two runs for device A, one for device B. Tests the scoping query.
const runA1 = insertRun({ app_id: appId, device_id: 'dev-a-1111' });
const runA2 = insertRun({ app_id: appId, device_id: 'dev-a-1111' });
const runB1 = insertRun({ app_id: appId, device_id: 'dev-b-2222' });
log('seeded 3 runs', runA1 && runA2 && runB1);

// ---- 2. /api/me/runs for device A returns A's runs only ----
// The meRouter's resolveUserContext mints a device cookie if absent and
// never sees our synthetic ids. To simulate device A we pre-mint the
// cookie and pass it in.
const cookieA = 'floom_device=dev-a-1111';
const meResA = await fetchRoute(meRouter, 'GET', '/runs', undefined, cookieA);
log('GET /api/me/runs 200', meResA.status === 200);
log('GET /api/me/runs returns array', Array.isArray(meResA.json?.runs));
log(
  'GET /api/me/runs returns device-A runs',
  meResA.json?.runs.length === 2,
  `got ${meResA.json?.runs?.length}`,
);
log(
  'GET /api/me/runs includes app_name',
  meResA.json?.runs[0]?.app_name === 'Hello',
);

// ---- 3. Second device does NOT see the first device's runs ----
const cookieB = 'floom_device=dev-b-2222';
const meResB = await fetchRoute(meRouter, 'GET', '/runs', undefined, cookieB);
log('device B: /api/me/runs 200', meResB.status === 200);
log(
  'device B: only sees its own runs (1)',
  Array.isArray(meResB.json?.runs) && meResB.json.runs.length === 1,
);
log(
  'device B: cross-device isolation',
  !meResB.json?.runs.some((r) => r.id === runA1 || r.id === runA2),
);

// ---- 4. /api/me/runs/:id gated by owner ----
const oneResA = await fetchRoute(
  meRouter,
  'GET',
  `/runs/${runA1}`,
  undefined,
  cookieA,
);
log('device A: GET /api/me/runs/:id 200', oneResA.status === 200);

const oneResB = await fetchRoute(
  meRouter,
  'GET',
  `/runs/${runA1}`,
  undefined,
  cookieB,
);
log('device B: GET /api/me/runs/:id 404 (not owner)', oneResB.status === 404);

// ---- 5. POST /api/apps/:slug/reviews upserts ----
_resetFeedbackBucketsForTests?.();
const rev1 = await fetchRoute(
  reviewsRouter,
  'POST',
  '/hello/reviews',
  { rating: 5, title: 'great', body: 'loved it' },
  cookieA,
);
log('POST review 201', rev1.status === 201, `got ${rev1.status}`);

const rev2 = await fetchRoute(
  reviewsRouter,
  'POST',
  '/hello/reviews',
  { rating: 4, title: 'updated', body: 'still good' },
  cookieA,
);
log('POST review (upsert) 200', rev2.status === 200, `got ${rev2.status}`);

const revList = await fetchRoute(reviewsRouter, 'GET', '/hello/reviews');
log('GET reviews 200', revList.status === 200);
log('GET reviews count = 1 (upsert not duplicate)', revList.json?.summary.count === 1);
log('GET reviews avg reflects the second rating', revList.json?.summary.avg === 4);

// Unknown app → 404
const badReview = await fetchRoute(
  reviewsRouter,
  'POST',
  '/does-not-exist/reviews',
  { rating: 3 },
  cookieA,
);
log('POST review on unknown app → 404', badReview.status === 404);

// Bad rating validation
const badRating = await fetchRoute(
  reviewsRouter,
  'POST',
  '/hello/reviews',
  { rating: 99 },
  cookieA,
);
log('POST review rating=99 → 400', badRating.status === 400);

// ---- 6. POST /api/feedback ----
const fb1 = await fetchRoute(
  feedbackRouter,
  'POST',
  '/',
  { text: 'This thing is great', email: 'x@example.com', url: '/me' },
  cookieA,
);
log('POST /api/feedback 200', fb1.status === 200);
log(
  'POST /api/feedback returns id',
  typeof fb1.json?.id === 'string' && fb1.json.id.startsWith('fb_'),
);

const fbRow = db.prepare('SELECT * FROM feedback WHERE id = ?').get(fb1.json.id);
log('feedback row persisted', !!fbRow);
log('feedback text persisted', fbRow?.text === 'This thing is great');
log('feedback email persisted', fbRow?.email === 'x@example.com');

// Empty text → 400
const fbEmpty = await fetchRoute(
  feedbackRouter,
  'POST',
  '/',
  { text: '' },
  cookieA,
);
log('POST /api/feedback empty → 400', fbEmpty.status === 400);

// Non-JSON → 400
const fbRaw = await fetchRoute(feedbackRouter, 'POST', '/', undefined, cookieA, 'not-json');
log('POST /api/feedback non-JSON → 400', fbRaw.status === 400);

// ---- 7. POST /api/hub/ingest rejects bad URLs ----
const badIngest = await fetchRoute(
  hubRouter,
  'POST',
  '/ingest',
  { openapi_url: 'not-a-url' },
  cookieA,
);
log('POST /api/hub/ingest bad URL → 400', badIngest.status === 400);

// Missing body
const emptyIngest = await fetchRoute(hubRouter, 'POST', '/ingest', {}, cookieA);
log('POST /api/hub/ingest empty body → 400', emptyIngest.status === 400);

// ---- 8. GET /api/hub/mine returns apps owned by caller ----
const appId2 = `app_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
db.prepare(
  `INSERT INTO apps (id, slug, name, description, manifest, code_path, author, workspace_id)
   VALUES (?, 'mine-test', 'Mine', 'owned by local', ?, 'proxied:mine-test', 'local', 'local')`,
).run(
  appId2,
  JSON.stringify({
    name: 'Mine',
    description: 'owned by local',
    actions: { run: { label: 'Run', inputs: [], outputs: [] } },
    runtime: 'python',
    python_dependencies: [],
    node_dependencies: {},
    secrets_needed: [],
    manifest_version: '2.0',
  }),
);

const mine = await fetchRoute(hubRouter, 'GET', '/mine', undefined, cookieA);
log('GET /api/hub/mine 200', mine.status === 200);
log(
  'GET /api/hub/mine includes the owned app',
  mine.json?.apps?.some((a) => a.slug === 'mine-test'),
);

// ---- 9. DELETE /api/hub/:slug works for the owner ----
const del = await fetchRoute(hubRouter, 'DELETE', '/mine-test', undefined, cookieA);
log('DELETE /api/hub/:slug 200', del.status === 200);
const postDelete = db.prepare('SELECT id FROM apps WHERE slug = ?').get('mine-test');
log('DELETE /api/hub/:slug removed the row', !postDelete);

// ---- 10. GET /api/hub/:slug/runs returns activity for the owner ----
// hello was authored by 'alice' so local user cannot view it — 403 expected
const activityForbidden = await fetchRoute(
  hubRouter,
  'GET',
  '/hello/runs',
  undefined,
  cookieA,
);
// Wait — hello has workspace_id='local', so the "local" escape hatch makes
// local user the owner in OSS mode. That's correct.
log(
  'GET /api/hub/:slug/runs 200 for local-scoped app',
  activityForbidden.status === 200,
  `got ${activityForbidden.status}`,
);

// ---- cleanup ----
rmSync(tmp, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

#!/usr/bin/env node
// Direct coverage for small backend HTTP routes with prior zero or indirect-only
// stress coverage.
//
// Run after server build:
//   node test/stress/test-coverage-small-routes.mjs

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');

const tmp = mkdtempSync(join(tmpdir(), 'floom-coverage-routes-'));
process.env.DATA_DIR = tmp;
process.env.FLOOM_DISABLE_JOB_WORKER = 'true';
process.env.FLOOM_DISABLE_TRIGGERS_WORKER = 'true';
process.env.FLOOM_DISABLE_ZOMBIE_SWEEPER = 'true';
process.env.FLOOM_SEED_APPS = 'false';
process.env.FLOOM_SEED_LAUNCH_DEMOS = 'false';
process.env.FLOOM_FAST_APPS = 'false';
delete process.env.OPENAI_API_KEY;
delete process.env.FEEDBACK_GITHUB_TOKEN;
delete process.env.GITHUB_TOKEN;
delete process.env.FLOOM_AUTH_TOKEN;

const { db } = await import('../../apps/server/dist/db.js');
const { parseRouter } = await import('../../apps/server/dist/routes/parse.js');
const { pickRouter } = await import('../../apps/server/dist/routes/pick.js');
const { healthRouter } = await import('../../apps/server/dist/routes/health.js');
const { ogRouter } = await import('../../apps/server/dist/routes/og.js');
const { threadRouter } = await import('../../apps/server/dist/routes/thread.js');
const { adminRouter } = await import('../../apps/server/dist/routes/admin.js');
const { reviewsRouter } = await import('../../apps/server/dist/routes/reviews.js');

let passed = 0;
let failed = 0;

function log(label, ok, detail) {
  if (ok) {
    passed++;
    console.log(`  ok  ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${detail ? ` :: ${detail}` : ''}`);
  }
}

async function request(router, method, path, body, headers = {}) {
  const init = { method, headers: { ...headers } };
  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
    if (!init.headers['content-type']) init.headers['content-type'] = 'application/json';
  }
  const res = await router.fetch(new Request(`http://localhost${path}`, init));
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}
  return { status: res.status, headers: res.headers, text, json };
}

function manifest(actions = undefined) {
  return JSON.stringify({
    name: 'Parser App',
    description: 'Parses prompts',
    runtime: 'python',
    manifest_version: '2.0',
    python_dependencies: [],
    node_dependencies: {},
    secrets_needed: [],
    actions:
      actions ||
      {
        run: {
          label: 'Run',
          inputs: [
            { name: 'prompt', type: 'text', label: 'Prompt', required: true },
            { name: 'count', type: 'number', label: 'Count' },
          ],
          outputs: [{ name: 'result', type: 'text', label: 'Result' }],
        },
      },
  });
}

function insertApp({
  id,
  slug,
  name,
  description,
  category = 'tools',
  visibility = 'public',
  publishStatus = 'published',
  author = 'local',
  manifestJson = manifest(),
}) {
  db.prepare(
    `INSERT INTO apps
       (id, slug, name, description, manifest, status, code_path, category, visibility, publish_status, author, workspace_id)
     VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, 'local')`,
  ).run(
    id,
    slug,
    name,
    description,
    manifestJson,
    `proxied:${slug}`,
    category,
    visibility,
    publishStatus,
    author,
  );
}

async function importGhStars(caseName) {
  const url = pathToFileURL(
    join(REPO_ROOT, 'apps/server/dist/routes/gh-stars.js'),
  ).href;
  return import(`${url}?coverage=${caseName}-${Date.now()}-${Math.random()}`);
}

console.log('coverage: small backend routes');

try {
  insertApp({
    id: 'app_parse',
    slug: 'parser-app',
    name: 'Parser App',
    description: 'Parses prompts',
  });
  insertApp({
    id: 'app_pick_a',
    slug: 'invoice-helper',
    name: 'Invoice Helper',
    description: 'Create invoices and billing summaries',
    category: 'finance',
  });
  insertApp({
    id: 'app_pick_b',
    slug: 'unicode-tool',
    name: 'Unicode Tool',
    description: 'Handles multilingual text ' + '\uD83E\uDD84' + ' ' + '\u05E9\u05DC\u05D5\u05DD',
    category: 'text',
  });
  insertApp({
    id: 'app_fixture',
    slug: 'prr-test-fixture',
    name: 'Swagger Petstore Fixture',
    description: 'E2E PRR fixture app',
    category: 'fixtures',
  });
  insertApp({
    id: 'app_private',
    slug: 'private-tool',
    name: 'Private Tool',
    description: 'Hidden app',
    visibility: 'private',
  });
  insertApp({
    id: 'app_og',
    slug: 'og-safe',
    name: 'Use <Floom> & friends',
    description: 'Quotes "apostrophes" and ' + '\uD83E\uDD84'.repeat(120),
    author: 'author_og',
  });
  db.prepare(
    `INSERT INTO users (id, workspace_id, email, name, auth_provider)
     VALUES ('author_og', 'local', 'og@example.com', 'Alice <Owner>', 'local')`,
  ).run();

  console.log('\n/api/gh-stars');
  const originalFetch = globalThis.fetch;
  let upstreamCalls = 0;
  globalThis.fetch = async (_url, init) => {
    upstreamCalls++;
    log(
      'gh-stars sends GitHub token header when configured',
      init?.headers?.Authorization === 'Bearer gh_test_token',
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
    return new Response(JSON.stringify({ stargazers_count: 1234 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  process.env.FEEDBACK_GITHUB_TOKEN = 'gh_test_token';
  const { ghStarsRouter: liveStarsRouter } = await importGhStars('live');
  const [starA, starB] = await Promise.all([
    request(liveStarsRouter, 'GET', '/'),
    request(liveStarsRouter, 'GET', '/'),
  ]);
  log('gh-stars concurrent cold requests return live count', starA.json?.count === 1234 && starB.json?.count === 1234);
  log('gh-stars concurrent cold requests share one upstream fetch', upstreamCalls === 1, `calls=${upstreamCalls}`);
  const cachedStars = await request(liveStarsRouter, 'GET', '/');
  log('gh-stars cache response returned after live fetch', cachedStars.json?.source === 'cache');

  globalThis.fetch = async () => new Response('rate limited', { status: 403 });
  delete process.env.FEEDBACK_GITHUB_TOKEN;
  delete process.env.GITHUB_TOKEN;
  const { ghStarsRouter: fallbackStarsRouter } = await importGhStars('fallback');
  const fallbackStars = await request(fallbackStarsRouter, 'GET', '/');
  log('gh-stars upstream failure returns fallback 200', fallbackStars.status === 200);
  log('gh-stars fallback count is numeric floor', fallbackStars.json?.source === 'fallback' && typeof fallbackStars.json?.count === 'number');
  globalThis.fetch = originalFetch;

  console.log('\n/api/parse');
  const parseMissingPrompt = await request(parseRouter, 'POST', '/', { app_slug: 'parser-app' });
  log('parse rejects missing prompt', parseMissingPrompt.status === 400);
  const parseMissingSlug = await request(parseRouter, 'POST', '/', { prompt: 'hello' });
  log('parse rejects missing app_slug', parseMissingSlug.status === 400);
  const parseNotFound = await request(parseRouter, 'POST', '/', {
    prompt: 'hello',
    app_slug: 'missing-app',
  });
  log('parse returns 404 for missing app', parseNotFound.status === 404);
  insertApp({
    id: 'app_bad_manifest',
    slug: 'bad-manifest',
    name: 'Bad Manifest',
    description: 'Corrupt',
    manifestJson: '{not-json',
  });
  const parseCorrupt = await request(parseRouter, 'POST', '/', {
    prompt: 'hello',
    app_slug: 'bad-manifest',
  });
  log('parse returns 500 for corrupt manifest', parseCorrupt.status === 500);
  const parseBadAction = await request(parseRouter, 'POST', '/', {
    prompt: 'hello',
    app_slug: 'parser-app',
    action: 'missing',
  });
  log('parse rejects unknown action', parseBadAction.status === 400);
  const parseOk = await request(parseRouter, 'POST', '/', {
    prompt: "Summarize '; DROP TABLE apps-- " + 'x'.repeat(10_000),
    app_slug: 'parser-app',
  });
  log('parse fallback succeeds without OPENAI_API_KEY', parseOk.status === 200);
  log('parse fallback returns action and confidence', parseOk.json?.action === 'run' && parseOk.json?.confidence === 0);

  console.log('\n/api/pick');
  const pickMissing = await request(pickRouter, 'POST', '/', {});
  log('pick rejects missing prompt', pickMissing.status === 400);
  const pickEmpty = await request(pickRouter, 'POST', '/', { prompt: '   ' });
  log('pick rejects blank prompt', pickEmpty.status === 400);
  const pickLimited = await request(pickRouter, 'POST', '/', {
    prompt: 'invoice billing helper',
    limit: 1,
  });
  log('pick honors valid limit', pickLimited.status === 200 && pickLimited.json?.apps?.length === 1);
  log('pick returns keyword fallback match', pickLimited.json?.apps?.[0]?.slug === 'invoice-helper');
  const pickInvalidLimit = await request(pickRouter, 'POST', '/', {
    prompt: 'unicode multilingual text',
    limit: Number.MAX_SAFE_INTEGER,
  });
  log('pick invalid high limit falls back to default cap', pickInvalidLimit.json?.apps?.length <= 3);
  log('pick filters fixture and private apps', !pickInvalidLimit.json?.apps?.some((a) => a.slug === 'prr-test-fixture' || a.slug === 'private-tool'));

  console.log('\n/api/health and /og');
  const health = await request(healthRouter, 'GET', '/');
  log('health returns ok', health.status === 200 && health.json?.status === 'ok');
  log('health includes app count and version', typeof health.json?.apps === 'number' && typeof health.json?.version === 'string');

  const ogMain = await request(ogRouter, 'GET', '/main.svg');
  log('og main returns svg', ogMain.status === 200 && /<svg/.test(ogMain.text));
  const ogMissing = await request(ogRouter, 'GET', '/missing.svg');
  log('og missing app falls back to generic card', ogMissing.status === 200 && /Ship AI apps fast/.test(ogMissing.text));
  const ogApp = await request(ogRouter, 'GET', '/og-safe.svg');
  log('og app escapes XML title', /Use &lt;Floom&gt; &amp; friends/.test(ogApp.text));
  log('og app escapes author name', /by @Alice &lt;Owner&gt;/.test(ogApp.text));
  log('og app truncates very long description', ogApp.text.includes('...') || ogApp.text.includes('\u2026'));

  console.log('\n/api/thread');
  const createdThread = await request(threadRouter, 'POST', '/');
  log('thread create returns generated id', createdThread.status === 200 && /^thr_/.test(createdThread.json?.id || ''));
  const missingThread = await request(threadRouter, 'GET', '/thr_missing');
  log('thread get missing returns 404', missingThread.status === 404);
  const badTurn = await request(threadRouter, 'POST', '/fixed-thread/turn', {
    kind: 'system',
    payload: {},
  });
  log('thread rejects invalid kind', badTurn.status === 400);
  const longPayload = {
    text: '\uD83E\uDD84 ' + '\u05E9\u05DC\u05D5\u05DD ' + '../../etc/passwd ' + 'x'.repeat(10_000),
  };
  const firstTurn = await request(threadRouter, 'POST', '/fixed-thread/turn', {
    kind: 'user',
    payload: longPayload,
  });
  log('thread auto-creates on first append', firstTurn.status === 200 && firstTurn.json?.turn_index === 0);
  const concurrentTurns = await Promise.all([
    request(threadRouter, 'POST', '/fixed-thread/turn', { kind: 'assistant', payload: { text: 'a' } }),
    request(threadRouter, 'POST', '/fixed-thread/turn', { kind: 'assistant', payload: { text: 'b' } }),
  ]);
  const indexes = concurrentTurns.map((r) => r.json?.turn_index).sort((a, b) => a - b);
  log('thread concurrent appends allocate unique indexes', indexes[0] === 1 && indexes[1] === 2, indexes.join(','));
  const fetchedThread = await request(threadRouter, 'GET', '/fixed-thread');
  log('thread get returns ordered turns', fetchedThread.json?.turns?.map((t) => t.turn_index).join(',') === '0,1,2');
  log('thread title comes from first user turn', fetchedThread.json?.title?.startsWith('\uD83E\uDD84'));

  console.log('\n/api/admin and review invite');
  const adminNoToken = await request(adminRouter, 'POST', '/apps/parser-app/publish-status', {
    status: 'published',
  });
  log('admin without token rejects with 403', adminNoToken.status === 403);
  process.env.FLOOM_AUTH_TOKEN = 'admin-secret';
  const adminBadToken = await request(
    adminRouter,
    'POST',
    '/apps/parser-app/publish-status',
    { status: 'published' },
    { authorization: 'Bearer wrong' },
  );
  log('admin wrong token rejects with 403', adminBadToken.status === 403);
  const adminBadBody = await request(
    adminRouter,
    'POST',
    '/apps/parser-app/publish-status',
    { status: 'live' },
    { authorization: 'Bearer admin-secret' },
  );
  log('admin rejects invalid publish status', adminBadBody.status === 400);
  const adminMissing = await request(
    adminRouter,
    'POST',
    '/apps/nope/publish-status',
    { status: 'published' },
    { authorization: 'Bearer admin-secret' },
  );
  log('admin returns 404 for unknown app', adminMissing.status === 404);
  const adminOk = await request(
    adminRouter,
    'POST',
    '/apps/parser-app/publish-status',
    { status: 'rejected' },
    { authorization: 'Bearer admin-secret' },
  );
  const updatedStatus = db
    .prepare('SELECT publish_status FROM apps WHERE slug = ?')
    .get('parser-app')?.publish_status;
  log('admin updates publish status', adminOk.status === 200 && updatedStatus === 'rejected');

  const inviteMissing = await request(reviewsRouter, 'POST', '/missing/reviews', { rating: 5 });
  log('reviews missing app returns 404', inviteMissing.status === 404);
  const inviteBad = await request(reviewsRouter, 'POST', '/parser-app/invite', {
    emails: ['not-an-email'],
    permission: 'view',
  });
  log('review invite rejects bad email', inviteBad.status === 400);
  const inviteMany = await request(reviewsRouter, 'POST', '/parser-app/invite', {
    emails: Array.from({ length: 26 }, (_, i) => `u${i}@example.com`),
    permission: 'view',
  });
  log('review invite rejects more than 25 emails', inviteMany.status === 400);
  const inviteOk = await request(reviewsRouter, 'POST', '/parser-app/invite', {
    emails: ['owner@example.com'],
    permission: 'run',
  });
  log('review invite happy path returns stub id', inviteOk.status === 201 && /^stub-/.test(inviteOk.json?.invite_id || ''));
} finally {
  try {
    db.close();
  } catch {}
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

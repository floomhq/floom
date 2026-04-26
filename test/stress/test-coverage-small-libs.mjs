#!/usr/bin/env node
// Direct coverage for shared backend helpers and tiny services with prior
// zero or indirect-only stress coverage.
//
// Run after server build:
//   node test/stress/test-coverage-small-libs.mjs

import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');

const tmp = mkdtempSync(join(tmpdir(), 'floom-coverage-libs-'));
process.env.DATA_DIR = tmp;
process.env.FLOOM_DISABLE_JOB_WORKER = 'true';
process.env.FLOOM_DISABLE_TRIGGERS_WORKER = 'true';
process.env.FLOOM_DISABLE_ZOMBIE_SWEEPER = 'true';
process.env.FLOOM_SEED_APPS = 'false';
process.env.FLOOM_SEED_LAUNCH_DEMOS = 'false';
process.env.FLOOM_FAST_APPS = 'false';
delete process.env.FEEDBACK_GITHUB_TOKEN;
delete process.env.FEEDBACK_GITHUB_REPO;
delete process.env.GITHUB_TOKEN;

const { db } = await import('../../apps/server/dist/db.js');
const github = await import('../../apps/server/dist/lib/feedback-github.js');
const hubCache = await import('../../apps/server/dist/lib/hub-cache.js');
const { deleteAppRecordById } = await import('../../apps/server/dist/services/app_delete.js');
const { parseRendererManifest } = await import('../../apps/server/dist/lib/renderer-manifest.js');
const { SERVER_VERSION } = await import('../../apps/server/dist/lib/server-version.js');
const ids = await import('../../apps/server/dist/lib/ids.js');

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

function throws(fn, pattern) {
  try {
    fn();
    return false;
  } catch (err) {
    return pattern ? pattern.test(String(err?.message || err)) : true;
  }
}

function insertApp(id, slug) {
  db.prepare(
    `INSERT INTO apps
       (id, slug, name, description, manifest, status, code_path, category, visibility, publish_status, author, workspace_id)
     VALUES (?, ?, ?, ?, ?, 'active', ?, 'tools', 'public', 'published', 'local', 'local')`,
  ).run(
    id,
    slug,
    'Delete Me',
    'Delete target',
    JSON.stringify({
      name: 'Delete Me',
      description: 'Delete target',
      runtime: 'python',
      manifest_version: '2.0',
      python_dependencies: [],
      node_dependencies: {},
      secrets_needed: [],
      actions: {
        run: {
          label: 'Run',
          inputs: [],
          outputs: [],
        },
      },
    }),
    `proxied:${slug}`,
  );
}

console.log('coverage: small backend libs and services');

try {
  console.log('\nfeedback-github');
  log('feedback GitHub starts unconfigured', github.isFeedbackGitHubConfigured() === false);
  try {
    await github.fileFeedbackIssue({ text: 'hello' });
    log('feedback GitHub rejects missing token', false);
  } catch (err) {
    log(
      'feedback GitHub rejects missing token',
      err instanceof github.FeedbackGitHubError &&
        err.code === 'not_configured' &&
        err.status === null,
    );
  }

  process.env.FEEDBACK_GITHUB_TOKEN = 'ghp_test';
  process.env.FEEDBACK_GITHUB_REPO = 'bad-repo-env';
  try {
    await github.fileFeedbackIssue({ text: 'hello' });
    log('feedback GitHub rejects malformed repo env', false);
  } catch (err) {
    log(
      'feedback GitHub rejects malformed repo env',
      err instanceof github.FeedbackGitHubError && err.code === 'bad_repo_env',
    );
  }

  const originalFetch = globalThis.fetch;
  const fetchCalls = [];
  process.env.FEEDBACK_GITHUB_REPO = 'owner/repo';
  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url, init, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ number: 42, html_url: 'https://github.test/42' }), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    });
  };
  const userText = [
    '  @dependabot ping with <img src=x>  ',
    '```',
    "SQL: '; DROP TABLE feedback--",
    '../../etc/passwd',
  ].join('\n');
  const filed = await github.fileFeedbackIssue({
    text: userText,
    email: 'user@example.com',
    url: 'https://floom.dev/p/app?x=<tag>',
    reporter: 'user_123',
  });
  const call = fetchCalls[0];
  log('feedback GitHub success returns issue number and URL', filed.number === 42 && filed.url.endsWith('/42'));
  log('feedback GitHub posts to configured repo', String(call.url).endsWith('/repos/owner/repo/issues'));
  log('feedback GitHub sends bearer token', call.init.headers.Authorization === 'Bearer ghp_test');
  log('feedback GitHub applies source label', call.body.labels?.[0] === 'source/feedback');
  log('feedback GitHub neutralizes mention in title', call.body.title.includes('@\u200Bdependabot'));
  log('feedback GitHub wraps user text in longer code fence', call.body.body.includes('````\n') && call.body.body.includes('\n````'));
  log('feedback GitHub preserves dangerous text as fenced content', call.body.body.includes("'; DROP TABLE feedback--") && call.body.body.includes('../../etc/passwd'));
  log('feedback GitHub includes triage metadata', call.body.body.includes('Reply-to: user@example.com') && call.body.body.includes('Reporter: user_123'));

  globalThis.fetch = async () =>
    new Response('x'.repeat(300), {
      status: 500,
      headers: { 'content-type': 'text/plain' },
    });
  try {
    await github.fileFeedbackIssue({ text: 'api down' });
    log('feedback GitHub surfaces API errors', false);
  } catch (err) {
    log(
      'feedback GitHub surfaces API errors',
      err instanceof github.FeedbackGitHubError &&
        err.code === 'api_error' &&
        err.status === 500 &&
        err.message.length < 280,
    );
  }
  globalThis.fetch = originalFetch;

  console.log('\nhub-cache');
  const realNow = Date.now;
  let now = 10_000;
  Date.now = () => now;
  try {
    const keyA = hubCache.hubCacheKey(null, 'featured', false);
    const keyB = hubCache.hubCacheKey('tools', 'featured', false);
    const keyC = hubCache.hubCacheKey(null, 'recent', true);
    log('hub cache key includes category/sort/fixture discriminators', keyA !== keyB && keyA !== keyC && keyB !== keyC);
    hubCache.setHubCache(keyA, { apps: ['a'] });
    log('hub cache returns fresh body', hubCache.getHubCache(keyA)?.apps?.[0] === 'a');
    now += hubCache.HUB_CACHE_TTL_MS;
    log('hub cache expires at TTL boundary', hubCache.getHubCache(keyA) === null);
    hubCache.setHubCache(keyB, { apps: ['b'] });
    hubCache.invalidateHubCache();
    log('hub cache invalidation clears entries', hubCache.getHubCache(keyB) === null);
  } finally {
    Date.now = realNow;
  }

  console.log('\napp_delete');
  insertApp('app_delete_target', 'delete-target');
  db.prepare(
    `INSERT INTO runs
       (id, app_id, action, inputs, outputs, logs, status, workspace_id, user_id, device_id)
     VALUES ('run_delete_target', 'app_delete_target', 'run', '{}', '{}', '', 'success', 'local', 'local', 'dev-delete')`,
  ).run();
  const deleteCacheKey = hubCache.hubCacheKey(null, 'featured', false);
  hubCache.setHubCache(deleteCacheKey, { apps: ['stale'] });
  deleteAppRecordById('app_delete_target');
  const appGone = !db.prepare('SELECT id FROM apps WHERE id = ?').get('app_delete_target');
  const runGone = !db.prepare('SELECT id FROM runs WHERE id = ?').get('run_delete_target');
  log('app_delete removes app row', appGone);
  log('app_delete cascades dependent run rows', runGone);
  log('app_delete invalidates hub cache', hubCache.getHubCache(deleteCacheKey) === null);
  deleteAppRecordById('app_delete_target');
  log('app_delete missing row is idempotent', !db.prepare('SELECT id FROM apps WHERE id = ?').get('app_delete_target'));

  console.log('\nrenderer-manifest server copy');
  log('renderer manifest null returns default', parseRendererManifest(null).kind === 'default');
  const componentManifest = parseRendererManifest({
    kind: 'component',
    entry: './renderer.tsx',
    output_shape: 'table',
  });
  log('renderer manifest component preserves entry and output shape', componentManifest.entry === './renderer.tsx' && componentManifest.output_shape === 'table');
  log('renderer manifest rejects non-object', throws(() => parseRendererManifest('oops'), /expected object/));
  log('renderer manifest rejects missing entry', throws(() => parseRendererManifest({ kind: 'component' }), /entry/));
  log('renderer manifest rejects absolute entry', throws(() => parseRendererManifest({ kind: 'component', entry: '/etc/passwd' }), /relative path/));
  log('renderer manifest rejects traversal entry', throws(() => parseRendererManifest({ kind: 'component', entry: '../evil.tsx' }), /without \.\./));
  log('renderer manifest rejects bad output shape', throws(() => parseRendererManifest({ kind: 'default', output_shape: 'gif' }), /output_shape/));
  log('renderer manifest rejects bad kind', throws(() => parseRendererManifest({ kind: 'weird' }), /kind/));

  console.log('\nserver-version and ids');
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'apps/server/package.json'), 'utf8'));
  log('server version matches package metadata', SERVER_VERSION === pkg.version);
  const generatedIds = [
    ids.newAppId(),
    ids.newRunId(),
    ids.newSecretId(),
    ids.newThreadId(),
    ids.newTurnId(),
    ids.newJobId(),
    ids.newConnectionId(),
    ids.newStripeAccountRowId(),
    ids.newStripeWebhookEventRowId(),
    ids.newTriggerId(),
  ];
  log('id factories generate expected prefixes', generatedIds.every((id) => /^[a-z]+_/.test(id)));
  log('id factories generate unique values', new Set(generatedIds).size === generatedIds.length);
} finally {
  try {
    db.close();
  } catch {}
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

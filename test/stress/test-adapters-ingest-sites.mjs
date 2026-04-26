#!/usr/bin/env node
// Adapter migration regression test for openapi-ingest.ts +
// docker-image-ingest.ts.
//
// Background: these two services used to run hand-written `INSERT INTO
// apps (...)` / `UPDATE apps SET ... WHERE slug = ?` SQL directly. They
// now route through `adapters.storage.createApp` + `.updateApp` like the
// already-migrated seed.ts + launch-demos.ts do. This test exercises the
// adapter methods with inputs shaped like what those two services pass
// and asserts the resulting DB row matches what the prior raw SQL would
// have written — including the columns that were NOT present in the
// original seed/launch-demos tests: `workspace_id`, `publish_status =
// 'pending_review'`, `app_type = 'docker'`, `docker_image` on a proxied
// row being NULL, and the UPDATE branch preserving publish_status on a
// re-ingest.
//
// Uses a throwaway DATA_DIR so it never pollutes the real server DB.
// Run: tsx test/stress/test-adapters-ingest-sites.mjs

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'floom-adapters-ingest-'));
process.env.DATA_DIR = tmp;
process.env.FLOOM_DISABLE_JOB_WORKER = 'true';
process.env.FLOOM_MASTER_KEY =
  '0'.repeat(16) + '1'.repeat(16) + '2'.repeat(16) + '3'.repeat(16);

const { db } = await import('../../apps/server/src/db.ts');
const { adapters } = await import(
  '../../apps/server/src/adapters/index.ts'
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

console.log('adapters migration: openapi-ingest + docker-image-ingest');

// ---------------------------------------------------------------------
// Site 1: ingestOpenApiApps (operator-declared, publish_status=published)
// ---------------------------------------------------------------------
await adapters.storage.createApp({
  id: 'app_op_1',
  slug: 'operator-proxied',
  name: 'Operator Proxied',
  description: 'operator-declared proxied app',
  manifest: JSON.stringify({ name: 'Operator Proxied' }),
  status: 'active',
  docker_image: null,
  code_path: 'proxied:operator-proxied',
  category: 'tools',
  author: null,
  icon: 'https://example.com/icon.png',
  app_type: 'proxied',
  base_url: 'https://api.example.com',
  auth_type: 'bearer',
  auth_config: JSON.stringify({ apikey_header: 'X-API-Key' }),
  openapi_spec_url: 'https://api.example.com/openapi.json',
  openapi_spec_cached: '{"paths":{}}',
  visibility: 'public',
  is_async: 0,
  webhook_url: null,
  timeout_ms: 30000,
  retries: 2,
  async_mode: null,
  publish_status: 'published',
});
const op = db.prepare('SELECT * FROM apps WHERE slug = ?').get('operator-proxied');
log('ingestOpenApiApps CREATE: row inserted', op?.id === 'app_op_1');
log('ingestOpenApiApps CREATE: app_type=proxied', op?.app_type === 'proxied');
log('ingestOpenApiApps CREATE: publish_status=published',
  op?.publish_status === 'published');
log('ingestOpenApiApps CREATE: docker_image NULL for proxied',
  op?.docker_image === null);
log('ingestOpenApiApps CREATE: base_url stored',
  op?.base_url === 'https://api.example.com');
log('ingestOpenApiApps CREATE: timeout_ms=30000', op?.timeout_ms === 30000);

// UPDATE path: refresh + preserve publish_status
await adapters.storage.updateApp('operator-proxied', {
  name: 'Operator Proxied v2',
  description: 'refreshed',
  manifest: JSON.stringify({ name: 'Operator Proxied v2' }),
  category: 'tools',
  app_type: 'proxied',
  base_url: 'https://api.example.com/v2',
  auth_type: 'bearer',
  auth_config: null,
  openapi_spec_url: 'https://api.example.com/openapi.json',
  openapi_spec_cached: '{"paths":{"/x":{}}}',
  visibility: 'public',
  is_async: 0,
  webhook_url: null,
  timeout_ms: null,
  retries: 0,
  async_mode: null,
});
const opUpd = db.prepare('SELECT * FROM apps WHERE slug = ?').get('operator-proxied');
log('ingestOpenApiApps UPDATE: name refreshed',
  opUpd?.name === 'Operator Proxied v2');
log('ingestOpenApiApps UPDATE: base_url refreshed',
  opUpd?.base_url === 'https://api.example.com/v2');
log('ingestOpenApiApps UPDATE: publish_status preserved',
  opUpd?.publish_status === 'published');
log('ingestOpenApiApps UPDATE: timeout_ms cleared to NULL',
  opUpd?.timeout_ms === null);

// ---------------------------------------------------------------------
// Site 2: ingestAppFromSpec (user-driven, workspace_id + pending_review)
// ---------------------------------------------------------------------
await adapters.storage.createApp({
  id: 'app_user_1',
  slug: 'user-proxied',
  name: 'User Proxied',
  description: 'user-driven ingest',
  manifest: JSON.stringify({ name: 'User Proxied' }),
  status: 'active',
  docker_image: null,
  code_path: 'proxied:user-proxied',
  category: null,
  author: 'user_abc',
  icon: null,
  app_type: 'proxied',
  base_url: 'https://user.example.com',
  auth_type: 'none',
  auth_config: null,
  openapi_spec_url: 'https://user.example.com/openapi.json',
  openapi_spec_cached: '{"paths":{}}',
  visibility: 'private',
  is_async: 0,
  webhook_url: null,
  timeout_ms: null,
  retries: 0,
  async_mode: null,
  workspace_id: 'ws_user_123',
  publish_status: 'pending_review',
});
const usr = db.prepare('SELECT * FROM apps WHERE slug = ?').get('user-proxied');
log('ingestAppFromSpec CREATE: row inserted', usr?.id === 'app_user_1');
log('ingestAppFromSpec CREATE: workspace_id stored',
  usr?.workspace_id === 'ws_user_123');
log('ingestAppFromSpec CREATE: publish_status=pending_review',
  usr?.publish_status === 'pending_review');
log('ingestAppFromSpec CREATE: author stored', usr?.author === 'user_abc');
log('ingestAppFromSpec CREATE: visibility=private', usr?.visibility === 'private');

// Flip to published, then UPDATE branch must preserve it
db.prepare('UPDATE apps SET publish_status = ? WHERE slug = ?')
  .run('published', 'user-proxied');
await adapters.storage.updateApp('user-proxied', {
  name: 'User Proxied v2',
  description: 'refreshed',
  manifest: JSON.stringify({ name: 'User Proxied v2' }),
  category: null,
  app_type: 'proxied',
  base_url: 'https://user.example.com/v2',
  auth_type: 'none',
  auth_config: null,
  openapi_spec_url: 'https://user.example.com/openapi.json',
  openapi_spec_cached: '{"paths":{"/y":{}}}',
  visibility: 'private',
  is_async: 0,
  webhook_url: null,
  timeout_ms: null,
  retries: 0,
  async_mode: null,
  workspace_id: 'ws_user_123',
  author: 'user_abc',
});
const usrUpd = db.prepare('SELECT * FROM apps WHERE slug = ?').get('user-proxied');
log('ingestAppFromSpec UPDATE: name refreshed',
  usrUpd?.name === 'User Proxied v2');
log('ingestAppFromSpec UPDATE: publish_status preserved=published',
  usrUpd?.publish_status === 'published');
log('ingestAppFromSpec UPDATE: workspace_id preserved',
  usrUpd?.workspace_id === 'ws_user_123');

// ---------------------------------------------------------------------
// Site 3: docker-image-ingest (app_type='docker', docker_image set)
// ---------------------------------------------------------------------
await adapters.storage.createApp({
  id: 'app_docker_1',
  slug: 'ig-nano-scout',
  name: 'IG Nano Scout',
  description: 'docker image ingest',
  manifest: JSON.stringify({ name: 'IG Nano Scout' }),
  status: 'active',
  docker_image: 'ghcr.io/floomhq/ig-nano-scout:latest',
  code_path: 'docker-image:ig-nano-scout',
  category: 'agents',
  author: 'user_xyz',
  icon: null,
  app_type: 'docker',
  base_url: null,
  auth_type: null,
  auth_config: null,
  openapi_spec_url: null,
  openapi_spec_cached: null,
  visibility: 'private',
  is_async: 0,
  webhook_url: null,
  timeout_ms: null,
  retries: 0,
  async_mode: null,
  workspace_id: 'ws_docker_456',
  publish_status: 'pending_review',
});
const dock = db.prepare('SELECT * FROM apps WHERE slug = ?').get('ig-nano-scout');
log('docker-image-ingest CREATE: row inserted', dock?.id === 'app_docker_1');
log('docker-image-ingest CREATE: app_type=docker', dock?.app_type === 'docker');
log('docker-image-ingest CREATE: docker_image stored',
  dock?.docker_image === 'ghcr.io/floomhq/ig-nano-scout:latest');
log('docker-image-ingest CREATE: workspace_id stored',
  dock?.workspace_id === 'ws_docker_456');
log('docker-image-ingest CREATE: publish_status=pending_review',
  dock?.publish_status === 'pending_review');
log('docker-image-ingest CREATE: base_url NULL for docker',
  dock?.base_url === null);
log('docker-image-ingest CREATE: openapi_spec_url NULL for docker',
  dock?.openapi_spec_url === null);
log('docker-image-ingest CREATE: code_path has docker-image: prefix',
  dock?.code_path === 'docker-image:ig-nano-scout');

// UPDATE path: swap image tag, preserve publish_status
db.prepare('UPDATE apps SET publish_status = ? WHERE slug = ?')
  .run('published', 'ig-nano-scout');
await adapters.storage.updateApp('ig-nano-scout', {
  name: 'IG Nano Scout',
  description: 'refreshed',
  manifest: JSON.stringify({ name: 'IG Nano Scout' }),
  category: 'agents',
  app_type: 'docker',
  docker_image: 'ghcr.io/floomhq/ig-nano-scout:v2',
  base_url: null,
  auth_type: null,
  auth_config: null,
  openapi_spec_url: null,
  openapi_spec_cached: null,
  visibility: 'private',
  is_async: 0,
  webhook_url: null,
  timeout_ms: null,
  retries: 0,
  async_mode: null,
  workspace_id: 'ws_docker_456',
  author: 'user_xyz',
});
const dockUpd = db.prepare('SELECT * FROM apps WHERE slug = ?').get('ig-nano-scout');
log('docker-image-ingest UPDATE: docker_image refreshed',
  dockUpd?.docker_image === 'ghcr.io/floomhq/ig-nano-scout:v2');
log('docker-image-ingest UPDATE: publish_status preserved=published',
  dockUpd?.publish_status === 'published');
log('docker-image-ingest UPDATE: workspace_id preserved',
  dockUpd?.workspace_id === 'ws_docker_456');

rmSync(tmp, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

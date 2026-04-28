#!/usr/bin/env node
// GET /api/hub/:slug/openapi.json route (R7.6 B1).
//
// Validates the three-step resolution order:
//   1. cached spec (openapi_spec_cached) is returned verbatim
//   2. manifest.actions is reconstructed into a synthetic OpenAPI 3.0 spec
//      when no cached spec exists (Docker-image apps land here)
//   3. nonexistent slug returns 404 with code "not_found"
//   4. corrupt manifest with no actions returns 404 + code "no_openapi_spec"
//
// Run: node test/stress/test-hub-openapi-route.mjs

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const tmp = mkdtempSync(join(tmpdir(), 'floom-hub-openapi-'));
const dataDir = join(tmp, 'data');
mkdirSync(dataDir, { recursive: true });

process.env.DATA_DIR = dataDir;

const { db } = await import('../../apps/server/dist/db.js');

// ----- fixture 1: proxied app with a cached OpenAPI spec -----
const cachedSlug = 'fixture-cached';
const cachedAppId = `app_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
const cachedSpec = {
  openapi: '3.0.0',
  info: { title: 'Fixture Cached', version: '7.7.7' },
  paths: { '/run': { post: { operationId: 'cached_op', responses: { '200': { description: 'ok' } } } } },
};
const cachedManifest = {
  name: 'Fixture Cached',
  description: 'cached spec round-trips',
  runtime: 'python',
  python_dependencies: [],
  node_dependencies: {},
  secrets_needed: [],
  manifest_version: '2.0',
  actions: {
    cached_op: {
      label: 'Cached',
      inputs: [],
      outputs: [{ name: 'result', label: 'Result', type: 'text' }],
    },
  },
};

db.prepare(
  `INSERT INTO apps
     (id, slug, name, description, manifest, status, code_path, app_type,
      workspace_id, author, visibility, publish_status, hero,
      openapi_spec_cached)
   VALUES (?, ?, ?, ?, ?, 'active', ?, 'proxied', 'local', 'floom', 'public', 'published', 0, ?)`,
).run(
  cachedAppId,
  cachedSlug,
  'Fixture Cached',
  'A proxied app whose openapi_spec_cached column should be returned verbatim.',
  JSON.stringify(cachedManifest),
  'proxied:fixture-cached',
  JSON.stringify(cachedSpec),
);

// ----- fixture 2: docker app, no cached spec, manifest.actions present -----
const dockerSlug = 'fixture-docker';
const dockerAppId = `app_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
const dockerManifest = {
  name: 'Fixture Docker',
  description: 'A docker-published app — synthesized spec only.',
  runtime: 'python',
  python_dependencies: [],
  node_dependencies: {},
  secrets_needed: [],
  manifest_version: '2.0',
  actions: {
    analyze: {
      label: 'Analyze Page',
      description: 'Analyze a single URL.',
      inputs: [
        { name: 'url', label: 'URL', type: 'url', required: true, description: 'page to analyze' },
        { name: 'count', label: 'Count', type: 'number', required: false, default: 3 },
        { name: 'mode', label: 'Mode', type: 'enum', required: false, options: ['fast', 'deep'], default: 'fast' },
      ],
      outputs: [{ name: 'summary', label: 'Summary', type: 'text' }],
    },
  },
};

db.prepare(
  `INSERT INTO apps
     (id, slug, name, description, manifest, status, code_path, app_type,
      workspace_id, author, visibility, publish_status, hero, docker_image)
   VALUES (?, ?, ?, ?, ?, 'active', ?, 'docker', 'local', 'floom', 'public', 'published', 0, ?)`,
).run(
  dockerAppId,
  dockerSlug,
  'Fixture Docker',
  'A docker-published app whose openapi_spec_cached column is null.',
  JSON.stringify(dockerManifest),
  'docker:fixture-docker',
  'ghcr.io/floomhq/fixture-docker:latest',
);

// ----- fixture 3: app with no actions at all -----
const emptySlug = 'fixture-empty';
const emptyAppId = `app_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
const emptyManifest = {
  name: 'Fixture Empty',
  description: 'No actions, no spec.',
  runtime: 'python',
  python_dependencies: [],
  node_dependencies: {},
  secrets_needed: [],
  manifest_version: '2.0',
  actions: {},
};
db.prepare(
  `INSERT INTO apps
     (id, slug, name, description, manifest, status, code_path, app_type,
      workspace_id, author, visibility, publish_status, hero, docker_image)
   VALUES (?, ?, ?, ?, ?, 'active', ?, 'docker', 'local', 'floom', 'public', 'published', 0, ?)`,
).run(
  emptyAppId,
  emptySlug,
  'Fixture Empty',
  'Docker app with zero declared actions.',
  JSON.stringify(emptyManifest),
  'docker:fixture-empty',
  'ghcr.io/floomhq/fixture-empty:latest',
);

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

async function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`timed out waiting for ${url}: ${lastErr?.message || 'no response'}`);
}

async function canBindLocalhost() {
  return await new Promise((resolve) => {
    const server = createNetServer();
    server.once('error', () => resolve(false));
    server.listen(0, '127.0.0.1', () => {
      server.close(() => resolve(true));
    });
  });
}

async function bootServer() {
  const port = 39000 + Math.floor(Math.random() * 1000);
  const env = {
    ...process.env,
    PORT: String(port),
    PUBLIC_URL: `http://localhost:${port}`,
    DATA_DIR: dataDir,
    FLOOM_SEED_APPS: 'false',
    FLOOM_SEED_LAUNCH_DEMOS: 'false',
    FLOOM_FAST_APPS: 'false',
    FLOOM_DISABLE_JOB_WORKER: 'true',
    FLOOM_DISABLE_TRIGGERS_WORKER: 'true',
    FLOOM_DISABLE_ZOMBIE_SWEEPER: 'true',
  };
  const proc = spawn('node', [join(REPO_ROOT, 'apps/server/dist/index.js')], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  proc.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
  });
  proc.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  try {
    await waitForHttp(`http://localhost:${port}/api/health`, 20_000);
  } catch (err) {
    try {
      proc.kill('SIGTERM');
    } catch {}
    const combined = `${err.message}\nstdout:\n${stdout}\nstderr:\n${stderr}`;
    if (combined.includes('listen EPERM')) {
      throw new Error(`listen_eprem\n${combined}`);
    }
    throw new Error(combined);
  }
  return { port, proc };
}

async function stopServer(server) {
  try {
    server.proc.kill('SIGTERM');
  } catch {}
  await new Promise((resolve) => setTimeout(resolve, 150));
}

console.log('GET /api/hub/:slug/openapi.json route');

async function runAssertions(baseFetch) {
  // ----- fixture 1: cached spec is returned verbatim -----
  const cachedRes = await baseFetch(`/api/hub/${cachedSlug}/openapi.json`);
  log('cached: 200', cachedRes.status === 200, `got ${cachedRes.status}`);
  log(
    'cached: content-type is JSON',
    (cachedRes.headers.get('content-type') || '').includes('application/json'),
    cachedRes.headers.get('content-type') || '',
  );
  const cachedBody = await cachedRes.json().catch(() => null);
  log(
    'cached: spec round-trips info.title',
    cachedBody && cachedBody.info && cachedBody.info.title === 'Fixture Cached',
    JSON.stringify(cachedBody?.info ?? null),
  );
  log(
    'cached: spec round-trips info.version',
    cachedBody && cachedBody.info && cachedBody.info.version === '7.7.7',
    JSON.stringify(cachedBody?.info ?? null),
  );

  // ----- fixture 2: docker app synthesizes from manifest.actions -----
  const dockerRes = await baseFetch(`/api/hub/${dockerSlug}/openapi.json`);
  log('docker: 200', dockerRes.status === 200, `got ${dockerRes.status}`);
  const dockerBody = await dockerRes.json().catch(() => null);
  log(
    'docker: openapi version is 3.0.0',
    dockerBody && dockerBody.openapi === '3.0.0',
    String(dockerBody?.openapi),
  );
  log(
    'docker: info.title matches manifest name',
    dockerBody && dockerBody.info && dockerBody.info.title === 'Fixture Docker',
    JSON.stringify(dockerBody?.info ?? null),
  );
  log(
    'docker: spec has analyze operation',
    dockerBody &&
      dockerBody.paths &&
      Object.values(dockerBody.paths).some((p) => p?.post?.operationId === 'analyze'),
    JSON.stringify(dockerBody?.paths ?? null).slice(0, 200),
  );
  // Drill into the analyze operation to verify input typing.
  const analyzePath = dockerBody &&
    dockerBody.paths &&
    Object.values(dockerBody.paths).find((p) => p?.post?.operationId === 'analyze');
  const inputProps = analyzePath?.post?.requestBody?.content?.['application/json']?.schema?.properties?.inputs?.properties;
  log(
    'docker: url input typed as string + format uri',
    inputProps && inputProps.url && inputProps.url.type === 'string' && inputProps.url.format === 'uri',
    JSON.stringify(inputProps?.url),
  );
  log(
    'docker: count input typed as number',
    inputProps && inputProps.count && inputProps.count.type === 'number',
    JSON.stringify(inputProps?.count),
  );
  log(
    'docker: mode input typed as string with enum',
    inputProps && inputProps.mode && inputProps.mode.type === 'string' && Array.isArray(inputProps.mode.enum),
    JSON.stringify(inputProps?.mode),
  );

  // ----- fixture 3: app with empty actions returns no_openapi_spec -----
  const emptyRes = await baseFetch(`/api/hub/${emptySlug}/openapi.json`);
  log('empty: 404', emptyRes.status === 404, `got ${emptyRes.status}`);
  const emptyBody = await emptyRes.json().catch(() => null);
  log(
    'empty: code is no_openapi_spec',
    emptyBody && emptyBody.code === 'no_openapi_spec',
    JSON.stringify(emptyBody),
  );
  log(
    'empty: error mentions Docker',
    emptyBody && typeof emptyBody.error === 'string' && /docker image/i.test(emptyBody.error),
    JSON.stringify(emptyBody),
  );

  // ----- nonexistent slug -----
  const missingRes = await baseFetch('/api/hub/this-slug-does-not-exist/openapi.json');
  log('missing: 404', missingRes.status === 404, `got ${missingRes.status}`);
  const missingBody = await missingRes.json().catch(() => null);
  log(
    'missing: code is not_found',
    missingBody && missingBody.code === 'not_found',
    JSON.stringify(missingBody),
  );
}

let server = null;
const listenAllowed = await canBindLocalhost();
if (listenAllowed) {
  server = await bootServer();
  await runAssertions((path) => fetch(`http://localhost:${server.port}${path}`));
} else {
  const { hubRouter } = await import('../../apps/server/dist/routes/hub.js');
  await runAssertions((path) => {
    // hubRouter is mounted on the parent app at /api/hub, so strip the
    // prefix when fetching directly.
    const stripped = path.replace(/^\/api\/hub/, '');
    return hubRouter.fetch(new Request(`http://localhost${stripped}`));
  });
}

if (server) await stopServer(server);
rmSync(tmp, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

#!/usr/bin/env node
// Contract tests for the RuntimeAdapter.
//
// These tests define executable conformance checks for the runtime concern.
// They always exit 0 so direct documentation runs and CI smoke jobs can print
// the complete tally; the conformance runner parses the tally and returns a
// failing status when any assertion fails.
//
// Run: tsx test/stress/test-adapters-runtime-contract.mjs

import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'floom-runtime-contract-'));
process.env.DATA_DIR = tmp;
process.env.FLOOM_DISABLE_JOB_WORKER = 'true';
process.env.FLOOM_MASTER_KEY =
  '0'.repeat(16) + '1'.repeat(16) + '2'.repeat(16) + '3'.repeat(16);

function preserveSelectedConcernEnv() {
  const selected = process.env.FLOOM_CONFORMANCE_CONCERN;
  for (const k of [
    'FLOOM_RUNTIME',
    'FLOOM_STORAGE',
    'FLOOM_AUTH',
    'FLOOM_SECRETS',
    'FLOOM_OBSERVABILITY',
  ]) {
    if (selected && k === `FLOOM_${selected.toUpperCase()}`) continue;
    delete process.env[k];
  }
}
preserveSelectedConcernEnv();

const { db, DEFAULT_USER_ID, DEFAULT_WORKSPACE_ID } = await import(
  '../../apps/server/src/db.ts'
);
const { adapters } = await import('../../apps/server/src/adapters/index.ts');
const { proxyRuntimeAdapter } = await import(
  '../../apps/server/src/adapters/runtime-proxy.ts'
);

let passed = 0;
let failed = 0;
let skipped = 0;

function ok(label) {
  passed++;
  console.log(`  ok    ${label}`);
}

function fail(label, reason) {
  failed++;
  console.log(`  FAIL  ${label}: ${reason}`);
}

function skip(label, reason) {
  skipped++;
  console.log(`  skip  ${label}: ${reason}`);
}

async function check(label, fn) {
  try {
    await fn();
    ok(label);
  } catch (err) {
    fail(label, err && err.message ? err.message : String(err));
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function appRecord(baseUrl) {
  return {
    id: 'runtime-contract-app',
    slug: 'runtime-contract-app',
    name: 'Runtime Contract App',
    description: 'Runtime contract fixture',
    manifest: JSON.stringify(manifest),
    status: 'active',
    docker_image: null,
    code_path: '/tmp/runtime-contract',
    category: null,
    author: null,
    icon: null,
    app_type: 'proxied',
    base_url: baseUrl,
    auth_type: 'bearer',
    auth_config: null,
    openapi_spec_url: null,
    openapi_spec_cached: JSON.stringify(openapiSpec),
    visibility: 'public',
    is_async: 0,
    webhook_url: null,
    timeout_ms: 1_000,
    retries: 0,
    async_mode: null,
    workspace_id: DEFAULT_WORKSPACE_ID,
    memory_keys: null,
    featured: 0,
    avg_run_ms: null,
    publish_status: 'published',
    thumbnail_url: null,
    stars: 0,
    hero: 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

const ctx = {
  workspace_id: DEFAULT_WORKSPACE_ID,
  user_id: DEFAULT_USER_ID,
  device_id: 'runtime-contract-device',
  is_authenticated: false,
};

const manifest = {
  name: 'runtime-contract',
  description: 'Runtime contract fixture',
  actions: {
    ok: { label: 'OK', inputs: [], outputs: [], secrets_needed: [] },
    echo: { label: 'Echo', inputs: [], outputs: [], secrets_needed: [] },
    secret_echo: {
      label: 'Secret Echo',
      inputs: [],
      outputs: [],
      secrets_needed: ['API_KEY'],
    },
    user_error: { label: 'User Error', inputs: [], outputs: [], secrets_needed: [] },
    auth_error: { label: 'Auth Error', inputs: [], outputs: [], secrets_needed: [] },
    upstream_error: {
      label: 'Upstream Error',
      inputs: [],
      outputs: [],
      secrets_needed: [],
    },
  },
  runtime: 'python',
  python_dependencies: [],
  node_dependencies: {},
  secrets_needed: ['API_KEY'],
  manifest_version: '1.0',
};

const openapiSpec = {
  openapi: '3.1.0',
  info: { title: 'Runtime Contract', version: '1.0.0' },
  paths: {
    '/ok': { get: { operationId: 'ok', responses: { 200: { description: 'OK' } } } },
    '/echo': { post: { operationId: 'echo', responses: { 200: { description: 'OK' } } } },
    '/secret': {
      get: { operationId: 'secret_echo', responses: { 200: { description: 'OK' } } },
    },
    '/user-error': {
      get: { operationId: 'user_error', responses: { 400: { description: 'Bad' } } },
    },
    '/auth-error': {
      get: { operationId: 'auth_error', responses: { 401: { description: 'No' } } },
    },
    '/upstream-error': {
      get: { operationId: 'upstream_error', responses: { 503: { description: 'Down' } } },
    },
  },
};

function startFixtureServer() {
  const server = createServer(async (req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    await new Promise((resolve) => req.on('end', resolve));
    const body = Buffer.concat(chunks).toString('utf-8');
    res.setHeader('content-type', 'application/json');
    if (req.url === '/ok') {
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.url === '/echo') {
      res.end(JSON.stringify({ input: body ? JSON.parse(body) : null }));
      return;
    }
    if (req.url === '/secret') {
      res.end(JSON.stringify({ authorization: req.headers.authorization || null }));
      return;
    }
    if (req.url === '/user-error') {
      res.statusCode = 400;
      res.end(JSON.stringify({ message: 'bad request shape' }));
      return;
    }
    if (req.url === '/auth-error') {
      res.statusCode = 401;
      res.end(JSON.stringify({ message: 'bad credentials' }));
      return;
    }
    if (req.url === '/upstream-error') {
      res.statusCode = 503;
      res.end(JSON.stringify({ message: 'upstream unavailable' }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ message: 'not found' }));
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${address.port}` });
    });
  });
}

console.log('adapter-runtime contract tests');

const { server, baseUrl } = await startFixtureServer();
const app = appRecord(baseUrl);

try {
  await check('success path returns outputs and duration', async () => {
    const result = await proxyRuntimeAdapter.execute(app, manifest, 'ok', {}, {}, ctx);
    assert(result.status === 'success', `status=${result.status}`);
    assert(JSON.stringify(result.outputs) === JSON.stringify({ ok: true }), 'outputs mismatch');
    assert(result.duration_ms >= 0, `duration_ms=${result.duration_ms}`);
    assert(!result.error, `error=${result.error}`);
    assert(!result.error_type, `error_type=${result.error_type}`);
  });

  await check('error_type classification uses the ErrorType taxonomy', async () => {
    const expected = {
      user_error: 'user_input_error',
      auth_error: 'auth_error',
      upstream_error: 'upstream_outage',
    };
    for (const [action, errorType] of Object.entries(expected)) {
      const result = await proxyRuntimeAdapter.execute(app, manifest, action, {}, {}, ctx);
      assert(result.status === 'error', `${action} status=${result.status}`);
      assert(result.error_type === errorType, `${action} error_type=${result.error_type}`);
      assert(typeof result.error === 'string' && result.error.length > 0, `${action} missing error`);
    }
  });

  await check('secret non-leakage redacts outputs, logs, and errors', async () => {
    const canary = 'sk-runtime-contract-canary';
    const result = await proxyRuntimeAdapter.execute(
      app,
      manifest,
      'secret_echo',
      {},
      { API_KEY: canary },
      ctx,
    );
    const serialized = JSON.stringify({
      outputs: result.outputs,
      logs: result.logs,
      error: result.error,
    });
    assert(!serialized.includes(canary), serialized);
    assert(serialized.includes('[redacted]'), 'redaction marker missing');
  });

  await check('concurrent isolation keeps per-call inputs separate', async () => {
    const [a, b] = await Promise.all([
      proxyRuntimeAdapter.execute(app, manifest, 'echo', { value: 'alpha' }, {}, ctx),
      proxyRuntimeAdapter.execute(app, manifest, 'echo', { value: 'bravo' }, {}, ctx),
    ]);
    assert(a.status === 'success' && b.status === 'success', 'one run failed');
    assert(a.outputs?.input?.value === 'alpha', `alpha output=${JSON.stringify(a.outputs)}`);
    assert(b.outputs?.input?.value === 'bravo', `bravo output=${JSON.stringify(b.outputs)}`);
  });

  if (adapters.runtime === proxyRuntimeAdapter) {
    skip(
      'timeout enforcement',
      'proxy runtime clamps request timeouts to 30s minimum; deterministic 500ms timeout belongs to Docker/runtime substrate tests',
    );
    skip('stream callback ordering', 'proxy runtime does not expose process stdout/stderr streams');
  } else {
    skip(
      'timeout enforcement',
      'direct contract uses proxyRuntimeAdapter for deterministic local assertions; Docker image lifecycle is environment-dependent',
    );
    skip(
      'stream callback ordering',
      'direct contract uses proxyRuntimeAdapter; Docker-specific stream ordering requires a prebuilt container fixture',
    );
  }
} finally {
  await new Promise((resolve) => server.close(resolve));
  try {
    db.close();
  } catch {
    // best effort
  }
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${passed} passing, ${skipped} skipped, ${failed} failing`);
process.exit(0);

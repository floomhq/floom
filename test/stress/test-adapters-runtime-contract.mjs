#!/usr/bin/env node
// Contract tests for the RuntimeAdapter.
//
// These tests define executable conformance checks for the runtime concern.
// They print the complete tally and exit non-zero when any assertion fails.
//
// Run: tsx test/stress/test-adapters-runtime-contract.mjs

import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';

const tmp = mkdtempSync(join(tmpdir(), 'floom-runtime-contract-'));
const execFileAsync = promisify(execFile);
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
    slow: { label: 'Slow', inputs: [], outputs: [], secrets_needed: [] },
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
    '/slow': { get: { operationId: 'slow', responses: { 200: { description: 'OK' } } } },
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
    if (req.url === '/slow') {
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      res.end(JSON.stringify({ ok: true, slow: true }));
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

async function dockerAvailable() {
  try {
    await execFileAsync('docker', ['version', '--format', '{{.Server.Version}}'], {
      timeout: 10_000,
    });
    return true;
  } catch {
    return false;
  }
}

async function buildStreamFixtureImage() {
  const dir = mkdtempSync(join(tmpdir(), 'floom-runtime-stream-'));
  const tag = `floom-runtime-contract-stream:${randomUUID().slice(0, 12)}`;
  writeFileSync(
    join(dir, 'Dockerfile'),
    `FROM alpine:3.20
RUN adduser -D -u 1000 app
USER 1000:1000
ENTRYPOINT ["/bin/sh", "-c", "printf 'stdout-one\\\\n'; sleep 1; printf 'stderr-two\\\\n' >&2; sleep 1; printf '__FLOOM_RESULT__{\\"ok\\":true,\\"outputs\\":{\\"done\\":true}}\\\\n'"]
`,
  );
  await execFileAsync('docker', ['build', '-q', '-t', tag, dir], { timeout: 120_000 });
  return {
    tag,
    cleanup: async () => {
      await execFileAsync('docker', ['rmi', '-f', tag]).catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function dockerAppRecord(image) {
  return {
    ...appRecord(null),
    id: `runtime-contract-docker-${randomUUID().slice(0, 8)}`,
    slug: 'runtime-contract-docker',
    app_type: 'docker',
    docker_image: image,
    base_url: null,
    auth_type: null,
    openapi_spec_cached: null,
  };
}

console.log('adapter-runtime contract tests');

const { server, baseUrl } = await startFixtureServer();
const app = appRecord(baseUrl);

try {
  await check('success path returns outputs and duration', async () => {
    const result = await adapters.runtime.execute(app, manifest, 'ok', {}, {}, ctx);
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
      const result = await adapters.runtime.execute(app, manifest, action, {}, {}, ctx);
      assert(result.status === 'error', `${action} status=${result.status}`);
      assert(result.error_type === errorType, `${action} error_type=${result.error_type}`);
      assert(typeof result.error === 'string' && result.error.length > 0, `${action} missing error`);
    }
  });

  await check('secret non-leakage redacts outputs, logs, and errors', async () => {
    const canary = 'sk-runtime-contract-canary';
    const result = await adapters.runtime.execute(
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
      adapters.runtime.execute(app, manifest, 'echo', { value: 'alpha' }, {}, ctx),
      adapters.runtime.execute(app, manifest, 'echo', { value: 'bravo' }, {}, ctx),
    ]);
    assert(a.status === 'success' && b.status === 'success', 'one run failed');
    assert(a.outputs?.input?.value === 'alpha', `alpha output=${JSON.stringify(a.outputs)}`);
    assert(b.outputs?.input?.value === 'bravo', `bravo output=${JSON.stringify(b.outputs)}`);
  });

  await check('timeout enforcement', async () => {
    const start = Date.now();
    const result = await adapters.runtime.execute(
      app,
      manifest,
      'slow',
      {},
      {},
      ctx,
      undefined,
      { runId: `runtime-timeout-${Date.now()}`, timeoutMs: 250 },
    );
    const elapsed = Date.now() - start;
    assert(elapsed < 2_000, `elapsed=${elapsed}`);
    assert(result.status === 'timeout', `status=${result.status}`);
    assert(result.error_type === 'timeout', `error_type=${result.error_type}`);
  });

  const selectedRuntime = process.env.FLOOM_RUNTIME || 'docker';
  if (selectedRuntime === 'proxy') {
    skip(
      'stream callback ordering',
      'selected FLOOM_RUNTIME=proxy forwards HTTP traffic and has no process stderr stream',
    );
  } else if (!(await dockerAvailable())) {
    skip('stream callback ordering', 'Docker daemon not reachable on this host');
  } else {
    let image;
    try {
      image = await buildStreamFixtureImage();
      await check('stream callback ordering', async () => {
        const events = [];
        const dockerManifest = {
          ...manifest,
          actions: {
            stream: { label: 'Stream', inputs: [], outputs: [], secrets_needed: [] },
          },
          secrets_needed: [],
        };
        const result = await adapters.runtime.execute(
          dockerAppRecord(image.tag),
          dockerManifest,
          'stream',
          {},
          {},
          ctx,
          (chunk, stream) => events.push({ stream, chunk }),
          { runId: `runtime-stream-${Date.now()}`, timeoutMs: 5_000 },
        );
        assert(result.status === 'success', `status=${result.status} error=${result.error}`);
        assert(events.length >= 3, `events=${JSON.stringify(events)}`);
        assert(events[0].stream === 'stdout', `first stream=${events[0]?.stream}`);
        assert(events[0].chunk.includes('stdout-one'), `first chunk=${events[0]?.chunk}`);
        assert(
          events.some((event) => event.stream === 'stderr' && event.chunk.includes('stderr-two')),
          `events=${JSON.stringify(events)}`,
        );
        assert(
          events.findIndex((event) => event.chunk.includes('stdout-one')) <
            events.findIndex((event) => event.chunk.includes('stderr-two')),
          `events=${JSON.stringify(events)}`,
        );
      });
    } finally {
      if (image) await image.cleanup();
    }
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
process.exit(failed > 0 ? 1 : 0);

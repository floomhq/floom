#!/usr/bin/env node
// Launch-blocker audit: HTTP run smoke for the three active launch demos.
//
// Uses proxied fixtures with the launch demo slugs so the real /api/:slug/run
// path proves workspace BYOK secret loading and run-row tenant attribution.

import http from 'node:http';
import { spawn } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const tmp = mkdtempSync(join(tmpdir(), 'floom-launch-demo-http-'));
const dataDir = join(tmp, 'data');
mkdirSync(dataDir, { recursive: true });

process.env.DATA_DIR = dataDir;
process.env.FLOOM_DISABLE_JOB_WORKER = 'true';
process.env.FLOOM_DISABLE_TRIGGERS_WORKER = 'true';
process.env.FLOOM_DISABLE_ZOMBIE_SWEEPER = 'true';
process.env.FLOOM_SEED_APPS = 'false';
process.env.FLOOM_SEED_LAUNCH_DEMOS = 'false';
process.env.FLOOM_FAST_APPS = 'false';
process.env.FLOOM_RATE_LIMIT_USER_PER_HOUR = '1000';
process.env.FLOOM_RATE_LIMIT_IP_PER_HOUR = '1000';
process.env.FLOOM_RATE_LIMIT_APP_PER_HOUR = '1000';
process.env.FLOOM_MASTER_KEY = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';
delete process.env.FLOOM_AUTH_TOKEN;
delete process.env.FLOOM_RATE_LIMIT_DISABLED;

const { db, DEFAULT_USER_ID, DEFAULT_WORKSPACE_ID } = await import('../../apps/server/dist/db.js');
const userSecrets = await import('../../apps/server/dist/services/user_secrets.js');

const DEMOS = ['competitor-lens', 'ai-readiness-audit', 'pitch-coach'];
const WORKSPACE_KEY = 'workspace-gemini-test-key-for-launch-smoke';
const upstreamCalls = [];

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

async function listen(server) {
  return await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

async function getFreePort(host = '127.0.0.1') {
  return await new Promise((resolve, reject) => {
    const server = createNetServer();
    server.on('error', reject);
    server.listen(0, host, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Could not allocate port')));
        return;
      }
      server.close((err) => (err ? reject(err) : resolve(address.port)));
    });
  });
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
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${url}: ${lastErr?.message || 'no response'}`);
}

async function bootServer() {
  const port = await getFreePort();
  const proc = spawn('node', [join(REPO_ROOT, 'apps/server/dist/index.js')], {
    env: {
      ...process.env,
      PORT: String(port),
      PUBLIC_URL: `http://localhost:${port}`,
      DATA_DIR: dataDir,
    },
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
    proc.kill('SIGTERM');
    throw new Error(`${err.message}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }
  return { port, proc };
}

async function stopServer(server) {
  server.proc.kill('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 150));
}

function insertDemoFixture(slug, baseUrl) {
  const manifest = {
    name: slug,
    description: `${slug} launch smoke fixture`,
    runtime: 'python',
    manifest_version: '2.0',
    python_dependencies: [],
    node_dependencies: {},
    secrets_needed: ['GEMINI_API_KEY'],
    actions: {
      run: {
        label: 'Run',
        inputs: [{ name: 'prompt', type: 'text', label: 'Prompt', required: true }],
        outputs: [{ name: 'ok', type: 'json', label: 'Result' }],
        secrets_needed: ['GEMINI_API_KEY'],
      },
    },
  };
  const spec = {
    openapi: '3.0.0',
    info: { title: slug, version: '1.0.0' },
    servers: [{ url: `${baseUrl}/${slug}` }],
    paths: {
      '/run': {
        post: {
          operationId: 'run',
          requestBody: { content: { 'application/json': { schema: { type: 'object' } } } },
          responses: { 200: { description: 'ok' } },
        },
      },
    },
  };
  db.prepare(
    `INSERT INTO apps
       (id, slug, name, description, manifest, status, docker_image, code_path,
        category, author, icon, app_type, base_url, auth_type, auth_config,
        openapi_spec_url, openapi_spec_cached, visibility, is_async, webhook_url,
        timeout_ms, retries, async_mode, workspace_id, publish_status)
     VALUES (?, ?, ?, ?, ?, 'active', NULL, '', 'testing', ?, NULL,
        'proxied', ?, 'apikey', ?, NULL, ?, 'public', 0, NULL, NULL, 0, NULL,
        ?, 'published')`,
  ).run(
    `app_smoke_${slug.replace(/-/g, '_')}`,
    slug,
    slug,
    `${slug} launch smoke fixture`,
    JSON.stringify(manifest),
    DEFAULT_USER_ID,
    `${baseUrl}/${slug}`,
    JSON.stringify({ apikey_header: 'X-Gemini-Key' }),
    JSON.stringify(spec),
    DEFAULT_WORKSPACE_ID,
  );
}

async function jsonFetch(port, path, body) {
  const res = await fetch(`http://localhost:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'launch-demo-http-smoke' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}
  return { res, text, json };
}

async function pollRun(port, runId) {
  const deadline = Date.now() + 10_000;
  let last = null;
  while (Date.now() < deadline) {
    const res = await fetch(`http://localhost:${port}/api/run/${runId}`);
    const text = await res.text();
    try {
      last = text ? JSON.parse(text) : null;
    } catch {
      last = { text };
    }
    if (last && ['success', 'error', 'timeout'].includes(last.status)) return last;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for run ${runId}: ${JSON.stringify(last)}`);
}

const upstream = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const slug = url.pathname.split('/').filter(Boolean)[0] || 'unknown';
    upstreamCalls.push({
      slug,
      method: req.method,
      gemini: req.headers['x-gemini-key'],
      body: Buffer.concat(chunks).toString('utf8'),
    });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, slug, saw_secret: req.headers['x-gemini-key'] === WORKSPACE_KEY }));
  });
});

console.log('Launch demo HTTP smoke');

const upstreamPort = await listen(upstream);
const upstreamBase = `http://127.0.0.1:${upstreamPort}`;
userSecrets.setWorkspaceSecret(DEFAULT_WORKSPACE_ID, 'GEMINI_API_KEY', WORKSPACE_KEY);
for (const slug of DEMOS) insertDemoFixture(slug, upstreamBase);
db.pragma('wal_checkpoint(TRUNCATE)');

const server = await bootServer();
try {
  for (const slug of DEMOS) {
    const started = await jsonFetch(server.port, `/api/${slug}/run`, {
      action: 'run',
      inputs: { prompt: `smoke ${slug}` },
    });
    log(`${slug}: POST /api/:slug/run returns 200`, started.res.status === 200, started.text);
    const runId = started.json?.run_id;
    log(`${slug}: run_id returned`, typeof runId === 'string' && runId.length > 0, started.text);
    const run = await pollRun(server.port, runId);
    log(`${slug}: run succeeds`, run.status === 'success', JSON.stringify(run));
    log(`${slug}: result returns`, run.outputs?.saw_secret === true, JSON.stringify(run.outputs));
    const row = db.prepare(`SELECT workspace_id, user_id FROM runs WHERE id = ?`).get(runId);
    log(
      `${slug}: run row writes workspace_id/user_id`,
      row?.workspace_id === DEFAULT_WORKSPACE_ID && row?.user_id === DEFAULT_USER_ID,
      JSON.stringify(row),
    );
  }

  for (const slug of DEMOS) {
    const call = upstreamCalls.find((entry) => entry.slug === slug);
    log(`${slug}: upstream received workspace BYOK key`, call?.gemini === WORKSPACE_KEY, JSON.stringify(call));
  }
} finally {
  await stopServer(server);
  upstream.close();
  db.close();
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

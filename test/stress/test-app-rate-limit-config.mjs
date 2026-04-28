#!/usr/bin/env node
// Creator-configured per-app run rate limits.

import { spawn } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const tmp = mkdtempSync(join(tmpdir(), 'floom-app-rate-limit-'));
const dataDir = join(tmp, 'data');
mkdirSync(dataDir, { recursive: true });

process.env.DATA_DIR = dataDir;
process.env.FLOOM_DISABLE_JOB_WORKER = 'true';
process.env.FLOOM_DISABLE_TRIGGERS_WORKER = 'true';
process.env.FLOOM_DISABLE_ZOMBIE_SWEEPER = 'true';
process.env.FLOOM_SEED_APPS = 'false';
process.env.FLOOM_SEED_LAUNCH_DEMOS = 'false';
process.env.FLOOM_FAST_APPS = 'false';
delete process.env.FLOOM_CLOUD_MODE;

const { db } = await import('../../apps/server/dist/db.js');

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

const manifest = {
  name: 'Rate Limit Fixture',
  description: 'Fixture',
  manifest_version: '2.0',
  runtime: 'python',
  actions: { run: { label: 'Run', inputs: [], outputs: [] } },
  python_dependencies: [],
  node_dependencies: {},
  secrets_needed: [],
};

console.log('App rate-limit config');

db.prepare(
  `INSERT INTO apps (
     id, slug, name, description, manifest, status, code_path, author,
     workspace_id, visibility, publish_status, run_rate_limit_per_hour
   ) VALUES (
     'app_rate_fixture', 'rate-fixture', 'Rate Fixture', 'Fixture', ?,
     'active', 'proxied:rate-fixture', 'local',
     'local', 'public_live', 'published', 1
   )`,
).run(JSON.stringify(manifest));

const server = await bootServer();
try {
  const first = await fetch(`http://localhost:${server.port}/api/rate-fixture/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-real-ip': '203.0.113.10' },
    body: '{}',
  });
  log('first run passes per-app limit', first.status !== 429, `status=${first.status} ${await first.text()}`);

  const second = await fetch(`http://localhost:${server.port}/api/rate-fixture/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-real-ip': '203.0.113.10' },
    body: '{}',
  });
  const secondJson = await second.json().catch(() => null);
  log('second run is blocked by app scope', second.status === 429 && secondJson?.scope === 'app', `status=${second.status} ${JSON.stringify(secondJson)}`);

  db.prepare(`UPDATE apps SET run_rate_limit_per_hour = NULL WHERE slug = 'rate-fixture'`).run();
  const third = await fetch(`http://localhost:${server.port}/api/rate-fixture/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-real-ip': '203.0.113.11' },
    body: '{}',
  });
  log('clearing app limit falls back to global default', third.status !== 429, `status=${third.status} ${await third.text()}`);
} finally {
  await stopServer(server);
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

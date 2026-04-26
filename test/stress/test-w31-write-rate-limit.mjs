#!/usr/bin/env node
// Issue #600 regression:
// - Global write rate-limit applies to /api/* POST/PUT/PATCH/DELETE routes.
// - Existing per-route limiters (waitlist, feedback, run surfaces) are
//   skipped to avoid double-throttling.
// - Read routes remain unthrottled.

import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');

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
      server.close((err) => {
        if (err) reject(err);
        else resolve(address.port);
      });
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
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`timed out waiting for ${url}: ${lastErr?.message || 'no response'}`);
}

async function bootServer() {
  const tmp = mkdtempSync(join(tmpdir(), 'floom-write-ratelimit-'));
  const dataDir = join(tmp, 'data');
  mkdirSync(dataDir, { recursive: true });
  const port = await getFreePort();
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
    FLOOM_WRITE_RATE_LIMIT_IP_PER_MINUTE: '2',
    FLOOM_WRITE_RATE_LIMIT_USER_PER_MINUTE: '4',
    FLOOM_WAITLIST_IP_PER_HOUR: '2',
  };
  delete env.FLOOM_AUTH_TOKEN;
  delete env.FLOOM_RATE_LIMIT_DISABLED;
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
    throw new Error(`${err.message}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }
  return { port, proc, tmp };
}

async function stopServer(server) {
  try {
    server.proc.kill('SIGTERM');
  } catch {}
  await new Promise((resolve) => setTimeout(resolve, 150));
  try {
    rmSync(server.tmp, { recursive: true, force: true });
  } catch {}
}

async function callApi(port, { method, path, ip, body }) {
  const headers = new Headers();
  headers.set('x-forwarded-for', ip);
  if (body !== undefined) headers.set('content-type', 'application/json');
  const res = await fetch(`http://localhost:${port}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // ignore non-JSON responses
  }
  return { status: res.status, headers: res.headers, text, json };
}

function waitlistBody(email) {
  return { email, source: 'stress-test' };
}

console.log('W3.1 global write rate limiter');
const server = await bootServer();
try {
  // 1) Generic write route (/api/parse) is globally limited.
  const parsePath = '/api/parse';
  const parseIp = '203.0.113.21';
  const p1 = await callApi(server.port, {
    method: 'POST',
    path: parsePath,
    ip: parseIp,
    body: {},
  });
  const p2 = await callApi(server.port, {
    method: 'POST',
    path: parsePath,
    ip: parseIp,
    body: {},
  });
  const p3 = await callApi(server.port, {
    method: 'POST',
    path: parsePath,
    ip: parseIp,
    body: {},
  });
  log(
    'first two writes to /api/parse are not globally blocked',
    p1.status !== 429 && p2.status !== 429,
    `${p1.status}/${p2.status}`,
  );
  log(
    'third write to /api/parse is globally rate-limited',
    p3.status === 429 && p3.json?.error === 'rate_limit_exceeded',
    `status=${p3.status} body=${p3.text}`,
  );
  log(
    'global 429 includes Retry-After header',
    Number(p3.headers.get('retry-after')) > 0,
    `retry-after=${p3.headers.get('retry-after')}`,
  );
  log(
    'global 429 body includes retryAfter',
    Number(p3.json?.retryAfter) > 0,
    JSON.stringify(p3.json),
  );

  // 2) Waitlist keeps its own limiter response (skiplist prevents double-throttle).
  const waitlistPath = '/api/waitlist';
  const waitlistIp = '203.0.113.31';
  const w1 = await callApi(server.port, {
    method: 'POST',
    path: waitlistPath,
    ip: waitlistIp,
    body: waitlistBody('skip-a@example.com'),
  });
  const w2 = await callApi(server.port, {
    method: 'POST',
    path: waitlistPath,
    ip: waitlistIp,
    body: waitlistBody('skip-b@example.com'),
  });
  const w3 = await callApi(server.port, {
    method: 'POST',
    path: waitlistPath,
    ip: waitlistIp,
    body: waitlistBody('skip-c@example.com'),
  });
  log(
    'first two waitlist writes succeed under waitlist cap',
    w1.status === 200 && w2.status === 200,
    `${w1.status}/${w2.status}`,
  );
  log(
    'third waitlist write hits waitlist limiter (not global limiter)',
    w3.status === 429 &&
      w3.json?.error === 'rate_limit_exceeded' &&
      w3.json?.retry_after_seconds === 3600 &&
      w3.json?.retryAfter === undefined &&
      w3.headers.get('retry-after') === '3600',
    `status=${w3.status} body=${w3.text} retry-after=${w3.headers.get('retry-after')}`,
  );

  // 3) Reads are not rate-limited.
  let readOk = true;
  let readStatus = '';
  for (let i = 0; i < 12; i++) {
    const r = await callApi(server.port, {
      method: 'GET',
      path: '/api/health',
      ip: '203.0.113.41',
    });
    if (r.status !== 200) {
      readOk = false;
      readStatus = String(r.status);
      break;
    }
  }
  log(
    'GET /api/health remains unthrottled',
    readOk,
    readStatus ? `status=${readStatus}` : '',
  );
} finally {
  await stopServer(server);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

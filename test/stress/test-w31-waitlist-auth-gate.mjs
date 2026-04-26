#!/usr/bin/env node
// Issue #767 regression:
// In waitlist mode (DEPLOY_ENABLED=false), direct POST /auth/sign-up/email
// must be blocked at the server boundary (403), while GET /auth/* remains
// reachable. In deploy-enabled mode, sign-up flows through as normal.

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const BETTER_AUTH_SECRET =
  '0'.repeat(16) + '1'.repeat(16) + '2'.repeat(16) + '3'.repeat(16);

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

async function bootServer(deployEnabled) {
  const tmp = mkdtempSync(join(tmpdir(), 'floom-w31-auth-gate-'));
  const dataDir = join(tmp, 'data');
  mkdirSync(dataDir, { recursive: true });
  const port = await getFreePort();
  const env = {
    ...process.env,
    PORT: String(port),
    PUBLIC_URL: `http://localhost:${port}`,
    DATA_DIR: dataDir,
    DEPLOY_ENABLED: deployEnabled ? 'true' : 'false',
    FLOOM_CLOUD_MODE: 'true',
    BETTER_AUTH_SECRET,
    BETTER_AUTH_URL: `http://localhost:${port}`,
    FLOOM_SEED_APPS: 'false',
    FLOOM_SEED_LAUNCH_DEMOS: 'false',
    FLOOM_FAST_APPS: 'false',
    FLOOM_DISABLE_JOB_WORKER: 'true',
    FLOOM_DISABLE_TRIGGERS_WORKER: 'true',
    FLOOM_DISABLE_ZOMBIE_SWEEPER: 'true',
  };
  delete env.FLOOM_WAITLIST_MODE;
  delete env.RESEND_API_KEY;
  delete env.FLOOM_APPS_CONFIG;
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

async function authCall(port, method, path, body) {
  const headers = new Headers();
  headers.set('origin', `http://localhost:${port}`);
  if (body !== undefined) headers.set('content-type', 'application/json');
  const res = await fetch(`http://localhost:${port}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: res.status,
    text: await res.text(),
  };
}

function signupPayload(tag, port) {
  return {
    email: `waitlist-gate-${tag}-${randomUUID()}@example.com`,
    password: 'hunter2-hunter2',
    name: 'Waitlist Gate',
    callbackURL: `http://localhost:${port}/after-verify`,
  };
}

console.log('W3.1 waitlist auth gate');

const waitlistServer = await bootServer(false);
try {
  const blocked = await authCall(
    waitlistServer.port,
    'POST',
    '/auth/sign-up/email',
    signupPayload('blocked', waitlistServer.port),
  );
  log(
    'DEPLOY_ENABLED=false: POST /auth/sign-up/email returns 403',
    blocked.status === 403,
    blocked.text || `got ${blocked.status}`,
  );
  log(
    'DEPLOY_ENABLED=false: response message references waitlist',
    /sign-up disabled/i.test(blocked.text) && /waitlist/i.test(blocked.text),
    blocked.text,
  );

  const blockedAlias = await authCall(
    waitlistServer.port,
    'POST',
    '/auth/sign-up',
    signupPayload('blocked-alias', waitlistServer.port),
  );
  log(
    'DEPLOY_ENABLED=false: POST /auth/sign-up also returns 403',
    blockedAlias.status === 403,
    blockedAlias.text || `got ${blockedAlias.status}`,
  );

  const sessionGet = await authCall(waitlistServer.port, 'GET', '/auth/get-session');
  log(
    'DEPLOY_ENABLED=false: GET /auth/get-session remains reachable (not 403)',
    sessionGet.status !== 403,
    `got ${sessionGet.status} ${sessionGet.text}`,
  );
} finally {
  await stopServer(waitlistServer);
}

const deployServer = await bootServer(true);
try {
  const allowed = await authCall(
    deployServer.port,
    'POST',
    '/auth/sign-up/email',
    signupPayload('allowed', deployServer.port),
  );
  log(
    'DEPLOY_ENABLED=true: POST /auth/sign-up/email returns 200',
    allowed.status === 200,
    allowed.text || `got ${allowed.status}`,
  );
} finally {
  await stopServer(deployServer);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

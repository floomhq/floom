#!/usr/bin/env node
// Resend production startup guard.
//
// Covers:
//   1. NODE_ENV=production without RESEND_API_KEY exits before listening.
//   2. NODE_ENV=development without RESEND_API_KEY still starts, and the
//      existing sendEmail stdout fallback still warns/logs.
//   3. NODE_ENV=production on preview without RESEND_API_KEY starts normally.
//   4. NODE_ENV=production with RESEND_API_KEY starts normally.
//
// Run after `pnpm --filter @floom/server build`.

import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const SERVER_ENTRY = join(REPO_ROOT, 'apps/server/dist/index.js');

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
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${url}: ${lastErr?.message || 'no response'}`);
}

function makeServerEnv(overrides = {}) {
  const tmp = mkdtempSync(join(tmpdir(), 'floom-resend-startup-'));
  const dataDir = join(tmp, 'data');
  mkdirSync(dataDir, { recursive: true });
  const env = {
    ...process.env,
    DATA_DIR: dataDir,
    FLOOM_SEED_APPS: 'false',
    FLOOM_SEED_LAUNCH_DEMOS: 'false',
    FLOOM_FAST_APPS: 'false',
    FLOOM_DISABLE_JOB_WORKER: 'true',
    FLOOM_DISABLE_TRIGGERS_WORKER: 'true',
    FLOOM_DISABLE_ZOMBIE_SWEEPER: 'true',
    ...overrides,
  };
  delete env.FLOOM_CLOUD_MODE;
  delete env.FLOOM_APPS_CONFIG;
  return { env, tmp };
}

function spawnServer(env) {
  const proc = spawn('node', [SERVER_ENTRY], {
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
  return { proc, get stdout() { return stdout; }, get stderr() { return stderr; } };
}

async function waitForExit(proc, timeoutMs) {
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        proc.kill('SIGTERM');
      } catch {}
      reject(new Error(`process did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    proc.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

async function bootServer(overrides) {
  const port = await getFreePort();
  const setup = makeServerEnv({
    PORT: String(port),
    PUBLIC_URL: `http://localhost:${port}`,
    ...overrides,
  });
  const child = spawnServer(setup.env);
  try {
    await waitForHttp(`http://localhost:${port}/api/health`, 20_000);
  } catch (err) {
    try {
      child.proc.kill('SIGTERM');
    } catch {}
    throw new Error(`${err.message}\nstdout:\n${child.stdout}\nstderr:\n${child.stderr}`);
  }
  return { ...child, tmp: setup.tmp, port };
}

async function stopServer(server) {
  try {
    server.proc.kill('SIGTERM');
  } catch {}
  await waitForExit(server.proc, 2_000).catch(() => {});
  rmSync(server.tmp, { recursive: true, force: true });
}

async function captureConsole(run) {
  const warnings = [];
  const logs = [];
  const originalWarn = console.warn;
  const originalLog = console.log;
  console.warn = (...args) => {
    warnings.push(args.join(' '));
  };
  console.log = (...args) => {
    logs.push(args.join(' '));
  };
  try {
    const result = await run();
    return { result, warnings, logs };
  } finally {
    console.warn = originalWarn;
    console.log = originalLog;
  }
}

console.log('Resend startup hard-fail');

// -- 1. production without key fails before listen ----------------------
{
  const setup = makeServerEnv({
    NODE_ENV: 'production',
    PORT: String(await getFreePort()),
    PUBLIC_URL: 'https://floom.dev',
  });
  delete setup.env.RESEND_API_KEY;
  const child = spawnServer(setup.env);
  const exit = await waitForExit(child.proc, 5_000).catch((err) => ({ err }));
  log(
    'production without RESEND_API_KEY exits with code 1',
    !exit.err && exit.code === 1,
    exit.err ? exit.err.message : `code=${exit.code} signal=${exit.signal}`,
  );
  log(
    'production failure logs clear fatal Resend error',
    child.stderr.includes('NODE_ENV=production with non-preview PUBLIC_URL requires RESEND_API_KEY') &&
      child.stderr.includes('ADR-010'),
    child.stderr,
  );
  rmSync(setup.tmp, { recursive: true, force: true });
}

// -- 2. development without key starts and keeps stdout fallback --------
{
  const server = await bootServer({ NODE_ENV: 'development', RESEND_API_KEY: '' });
  log('development without RESEND_API_KEY reaches /api/health', true);
  await stopServer(server);

  const previousNodeEnv = process.env.NODE_ENV;
  const previousResendKey = process.env.RESEND_API_KEY;
  process.env.NODE_ENV = 'development';
  delete process.env.RESEND_API_KEY;
  const email = await import('../../apps/server/dist/lib/email.js');
  email._resetEmailForTests();
  const captured = await captureConsole(() =>
    email.sendEmail({
      to: 'dev-fallback@example.com',
      subject: 'Dev fallback',
      html: '<p>Fallback</p>',
      text: 'Fallback',
    }),
  );
  log(
    'development sendEmail returns stdout_fallback',
    captured.result.ok === true && captured.result.reason === 'stdout_fallback',
    JSON.stringify(captured.result),
  );
  log(
    'development sendEmail warns about missing RESEND_API_KEY',
    captured.warnings.some((line) => line.includes('RESEND_API_KEY is not set')) &&
      captured.logs.some((line) => line.includes('[email:stdout]')),
    `warnings=${captured.warnings.join('\n')} logs=${captured.logs.join('\n')}`,
  );
  if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousNodeEnv;
  if (previousResendKey === undefined) delete process.env.RESEND_API_KEY;
  else process.env.RESEND_API_KEY = previousResendKey;
}

// -- 3. production preview without key starts normally ------------------
{
  const server = await bootServer({
    NODE_ENV: 'production',
    PUBLIC_URL: 'https://preview.floom.dev',
    RESEND_API_KEY: '',
  });
  log('production preview without RESEND_API_KEY reaches /api/health', true);
  await stopServer(server);
}

// -- 4. production with key starts normally -----------------------------
{
  const server = await bootServer({
    NODE_ENV: 'production',
    RESEND_API_KEY: 're_test_startup_guard',
  });
  log('production with RESEND_API_KEY reaches /api/health', true);
  await stopServer(server);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

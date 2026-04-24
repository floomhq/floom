#!/usr/bin/env node
// SPA HTML bootstrap: inject a same-origin script before the module bundle
// so the client reads window.__FLOOM__.deployEnabled on first paint without
// tripping CSP `script-src 'self'`.

import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const FIXTURE_HTML = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Fixture</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/assets/main.js"></script>
  </body>
</html>
`;

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
  const tmp = mkdtempSync(join(tmpdir(), 'floom-html-flag-'));
  const webDist = join(tmp, 'web-dist');
  mkdirSync(webDist, { recursive: true });
  writeFileSync(join(webDist, 'index.html'), FIXTURE_HTML);
  const port = await getFreePort();
  const env = {
    ...process.env,
    PORT: String(port),
    PUBLIC_URL: `http://localhost:${port}`,
    DATA_DIR: join(tmp, 'data'),
    WEB_DIST: webDist,
    DEPLOY_ENABLED: deployEnabled ? 'true' : 'false',
    FLOOM_DISABLE_JOB_WORKER: 'true',
    FLOOM_DISABLE_TRIGGERS_WORKER: 'true',
    FLOOM_DISABLE_ZOMBIE_SWEEPER: 'true',
    FLOOM_FAST_APPS: 'false',
    FLOOM_SEED_APPS: 'false',
    FLOOM_SEED_LAUNCH_DEMOS: 'false',
  };
  delete env.FLOOM_WAITLIST_MODE;
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

async function fetchHtml(port) {
  const res = await fetch(`http://localhost:${port}/`);
  return {
    status: res.status,
    contentType: res.headers.get('content-type') || '',
    text: await res.text(),
  };
}

async function fetchBootstrap(port) {
  const res = await fetch(`http://localhost:${port}/__floom/bootstrap.js`);
  return {
    status: res.status,
    contentType: res.headers.get('content-type') || '',
    cacheControl: res.headers.get('cache-control') || '',
    text: await res.text(),
  };
}

console.log('HTML deploy flag bootstrap');

for (const deployEnabled of [false, true]) {
  const server = await bootServer(deployEnabled);
  try {
    const first = await fetchHtml(server.port);
    const second = await fetchHtml(server.port);
    const bootstrap = await fetchBootstrap(server.port);
    const scriptNeedle = "<script defer src='/__floom/bootstrap.js' data-floom-bootstrap></script>";
    const scriptIndex = first.text.indexOf(scriptNeedle);
    const bundleIndex = first.text.indexOf('<script type="module"');
    log(
      `DEPLOY_ENABLED=${deployEnabled}: GET / returns 200`,
      first.status === 200,
      `got ${first.status}`,
    );
    log(
      `DEPLOY_ENABLED=${deployEnabled}: content-type is text/html`,
      first.contentType.includes('text/html'),
      first.contentType,
    );
    log(
      `DEPLOY_ENABLED=${deployEnabled}: HTML contains bootstrap script tag`,
      scriptIndex !== -1,
    );
    log(
      `DEPLOY_ENABLED=${deployEnabled}: bootstrap script appears before module bundle`,
      scriptIndex !== -1 && bundleIndex !== -1 && scriptIndex < bundleIndex,
      `scriptIndex=${scriptIndex} bundleIndex=${bundleIndex}`,
    );
    log(
      `DEPLOY_ENABLED=${deployEnabled}: GET /__floom/bootstrap.js returns 200`,
      bootstrap.status === 200,
      `got ${bootstrap.status}`,
    );
    log(
      `DEPLOY_ENABLED=${deployEnabled}: bootstrap content-type is application/javascript`,
      bootstrap.contentType.includes('application/javascript'),
      bootstrap.contentType,
    );
    log(
      `DEPLOY_ENABLED=${deployEnabled}: bootstrap body exposes deployEnabled=${deployEnabled}`,
      bootstrap.text.includes(`window.__FLOOM__.deployEnabled=${deployEnabled}`),
    );
    log(
      `DEPLOY_ENABLED=${deployEnabled}: bootstrap is not cacheable`,
      bootstrap.cacheControl.includes('no-cache') && bootstrap.cacheControl.includes('no-store'),
      bootstrap.cacheControl,
    );
    log(
      `DEPLOY_ENABLED=${deployEnabled}: repeated GET / is byte-identical`,
      first.text === second.text,
    );
  } finally {
    await stopServer(server);
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

#!/usr/bin/env node
// Layer 5 Round 2: legacy workspace UI redirects.
//
// Run after server build:
//   node test/stress/test-redirects.mjs

import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import net from 'node:net';

const tmp = mkdtempSync(join(tmpdir(), 'floom-l5-r2-redirects-'));
const webDist = join(tmp, 'web-dist');
mkdirSync(webDist, { recursive: true });
writeFileSync(join(webDist, 'index.html'), minimalIndexHtml());

const port = await getFreePort();
const env = serverEnv(tmp, webDist, port);
const server = spawn(process.execPath, ['apps/server/dist/index.js'], {
  cwd: process.cwd(),
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
});

let output = '';
server.stdout.on('data', (buf) => {
  output += buf.toString();
});
server.stderr.on('data', (buf) => {
  output += buf.toString();
});

let passed = 0;
let failed = 0;
function log(label, ok, detail = '') {
  if (ok) {
    passed++;
    console.log(`  ok  ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${detail ? ' :: ' + detail : ''}`);
  }
}

try {
  await waitForHttp(`http://127.0.0.1:${port}/api/health`, 15_000);

  const cases = [
    ['/me', '/run'],
    ['/me/apps', '/run/apps'],
    ['/me/apps/flyfast', '/run/apps/flyfast'],
    ['/me/apps/flyfast/run', '/run/apps/flyfast/run'],
    ['/me/apps/flyfast/triggers', '/run/apps/flyfast/triggers'],
    ['/me/runs', '/run/runs'],
    ['/me/runs/run_123', '/run/runs/run_123'],
    ['/me/install', '/run/install'],
    ['/me/secrets', '/settings/byok-keys'],
    ['/me/agent-keys', '/settings/agent-tokens'],
    ['/me/api-keys', '/settings/agent-tokens'],
    ['/me/settings', '/account/settings'],
    ['/studio/settings', '/settings/studio'],
  ];

  console.log('Layer 5 Round 2 redirect tests');
  for (const [from, to] of cases) {
    const res = await fetch(`http://127.0.0.1:${port}${from}`, {
      redirect: 'manual',
    });
    log(`${from}: 301`, res.status === 301, `got ${res.status}`);
    log(`${from}: location ${to}`, res.headers.get('location') === to, `got ${res.headers.get('location')}`);
  }

  const queryRes = await fetch(`http://127.0.0.1:${port}/me/runs?filter=failed`, {
    redirect: 'manual',
  });
  log(
    '/me/runs preserves query string',
    queryRes.headers.get('location') === '/run/runs?filter=failed',
    `got ${queryRes.headers.get('location')}`,
  );
} finally {
  server.kill('SIGTERM');
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error(output);
}
process.exit(failed > 0 ? 1 : 0);

function serverEnv(dataDir, dist, listenPort) {
  return {
    ...process.env,
    DATA_DIR: dataDir,
    WEB_DIST: dist,
    PORT: String(listenPort),
    PUBLIC_URL: `http://127.0.0.1:${listenPort}`,
    FLOOM_MASTER_KEY: '0'.repeat(16) + '1'.repeat(16) + '2'.repeat(16) + '3'.repeat(16),
    FLOOM_DISABLE_JOB_WORKER: 'true',
    FLOOM_DISABLE_ZOMBIE_SWEEPER: 'true',
    FLOOM_DISABLE_RETENTION_SWEEPER: 'true',
    FLOOM_DISABLE_TRIGGERS_WORKER: 'true',
    FLOOM_DISABLE_ACCOUNT_DELETE_SWEEPER: 'true',
    FLOOM_DISABLE_AUDIT_SWEEPER: 'true',
    FLOOM_FAST_APPS: 'false',
    GITHUB_DEPLOY_WORKER_DISABLED: 'true',
  };
}

function minimalIndexHtml() {
  return `<!doctype html>
<html lang="en">
  <head>
    <title>Floom</title>
    <meta name="description" content="Floom" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="canonical" href="http://127.0.0.1/" />
    <meta property="og:url" content="http://127.0.0.1/" />
    <meta property="og:title" content="Floom" />
    <meta property="og:description" content="Floom" />
    <meta property="og:image" content="/og-main.png" />
    <meta name="twitter:title" content="Floom" />
    <meta name="twitter:description" content="Floom" />
    <meta name="twitter:image" content="/og-main.png" />
  </head>
  <body>
    <div id="root"></div>
    <div style="display:none" data-spa-fallback><h1>Floom</h1></div>
    <script type="module" src="/assets/index.js"></script>
  </body>
</html>`;
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      const selected = typeof address === 'object' && address ? address.port : 0;
      srv.close(() => resolve(selected));
    });
    srv.on('error', reject);
  });
}

async function waitForHttp(url, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.status < 500) return;
    } catch {
      // keep polling
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

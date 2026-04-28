#!/usr/bin/env node
// Layer 5 Round 2: canonical workspace UI routes return the SPA shell.
//
// Run after server build:
//   node test/stress/test-routes.mjs

import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import net from 'node:net';

const tmp = mkdtempSync(join(tmpdir(), 'floom-l5-r2-routes-'));
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

  const paths = [
    '/run',
    '/run/apps',
    '/run/runs',
    '/run/runs/run_123',
    '/run/install',
    '/run/apps/flyfast/run',
    '/run/apps/flyfast/triggers',
    '/run/apps/flyfast/triggers/schedule',
    '/run/apps/flyfast/triggers/webhook',
    '/settings/byok-keys',
    '/settings/agent-tokens',
    '/settings/studio',
    '/account/settings',
    '/status',
  ];

  console.log('Layer 5 Round 2 canonical route tests');
  for (const path of paths) {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      redirect: 'manual',
    });
    const text = await res.text();
    log(`${path}: 200`, res.status === 200, `got ${res.status}`);
    log(
      `${path}: HTML SPA shell`,
      /text\/html/.test(res.headers.get('content-type') || '') && text.includes('id="root"'),
      `content-type=${res.headers.get('content-type')}`,
    );
  }

  const embedRes = await fetch(`http://127.0.0.1:${port}/embed/competitor-lens`, {
    redirect: 'manual',
  });
  log('/embed/:slug redirects instead of 404', embedRes.status === 302, `got ${embedRes.status}`);
  log(
    '/embed/:slug redirects to /p/:slug',
    embedRes.headers.get('location') === '/p/competitor-lens',
    `location=${embedRes.headers.get('location')}`,
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

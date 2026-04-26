#!/usr/bin/env node
// Sharing P1: link-share keys authorize the HTML, metadata, and run API paths.

import { spawn } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const tmp = mkdtempSync(join(tmpdir(), 'floom-link-token-api-'));
const dataDir = join(tmp, 'data');
const webDist = join(tmp, 'web-dist');
const FLOOM_PORT = await getFreePort();
const UPSTREAM_PORT = await getFreePort();

process.env.DATA_DIR = dataDir;
process.env.FLOOM_DISABLE_JOB_WORKER = 'true';
process.env.FLOOM_DISABLE_TRIGGERS_WORKER = 'true';
process.env.FLOOM_DISABLE_ZOMBIE_SWEEPER = 'true';

let passed = 0;
let failed = 0;
const processes = [];
let upstream;
let upstreamHits = 0;

const log = (label, ok, detail = '') => {
  if (ok) {
    passed++;
    console.log(`  ok  ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${detail ? ' :: ' + detail : ''}`);
  }
};

function cleanup() {
  for (const p of processes) {
    try {
      p.kill('SIGTERM');
    } catch {}
  }
  if (upstream) {
    try {
      upstream.close();
    } catch {}
  }
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {}
}
process.on('exit', cleanup);
process.on('SIGINT', () => {
  cleanup();
  process.exit(130);
});
process.on('SIGTERM', () => {
  cleanup();
  process.exit(143);
});

async function getFreePort(host = '127.0.0.1') {
  return await new Promise((resolve, reject) => {
    const server = createNetServer();
    server.on('error', reject);
    server.listen(0, host, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Could not allocate a TCP port')));
        return;
      }
      const { port } = address;
      server.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
  });
}

async function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${url}: ${lastErr?.message || 'no response'}`);
}

async function waitForCondition(fn, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

async function api(path, init) {
  const res = await fetch(`http://127.0.0.1:${FLOOM_PORT}${path}`, init);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text };
}

function startUpstream() {
  return new Promise((resolve, reject) => {
    upstream = createHttpServer((req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'method_not_allowed' }));
        return;
      }
      upstreamHits++;
      req.resume();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, upstreamHits }));
    });
    upstream.on('error', reject);
    upstream.listen(UPSTREAM_PORT, '127.0.0.1', () => resolve());
  });
}

mkdirSync(webDist, { recursive: true });
writeFileSync(
  join(webDist, 'index.html'),
  '<!doctype html><html><head><title>Test</title><link rel="canonical" href="/"></head><body><div id="root"></div></body></html>',
);

const { db } = await import(pathToFileURL(join(REPO_ROOT, 'apps/server/dist/db.js')).href);
const { transitionVisibility } = await import(
  pathToFileURL(join(REPO_ROOT, 'apps/server/dist/services/sharing.js')).href
);

const appId = `app_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
const manifest = {
  name: 'Link API App',
  description: 'test app',
  runtime: 'node',
  python_dependencies: [],
  node_dependencies: {},
  manifest_version: '2.0',
  actions: {
    run: {
      label: 'Run',
      description: 'run',
      inputs: [],
      outputs: [{ name: 'result', label: 'Result', type: 'json' }],
    },
  },
  secrets_needed: [],
};
db.prepare(
  `INSERT INTO apps
     (id, slug, name, description, manifest, status, code_path, author, workspace_id, app_type, base_url, visibility, publish_status)
   VALUES (?, 'link-api-app', 'Link API App', 'test app', ?, 'active', 'proxied:test', 'local', 'local', 'proxied', ?, 'private', 'pending_review')`,
).run(appId, JSON.stringify(manifest), `http://127.0.0.1:${UPSTREAM_PORT}`);

const linked = transitionVisibility(db.prepare(`SELECT * FROM apps WHERE id = ?`).get(appId), 'link', {
  actorUserId: 'local',
  reason: 'owner_enable_link',
});
const token = linked.link_share_token;

await startUpstream();

const floom = spawn('node', [join(REPO_ROOT, 'apps/server/dist/index.js')], {
  env: {
    ...process.env,
    PORT: String(FLOOM_PORT),
    PUBLIC_URL: `http://127.0.0.1:${FLOOM_PORT}`,
    DATA_DIR: dataDir,
    WEB_DIST: webDist,
    FLOOM_SEED_APPS: 'false',
    FLOOM_SEED_LAUNCH_DEMOS: 'false',
    FLOOM_FAST_APPS: 'false',
    FLOOM_DISABLE_JOB_WORKER: 'true',
    FLOOM_DISABLE_TRIGGERS_WORKER: 'true',
    FLOOM_DISABLE_ZOMBIE_SWEEPER: 'true',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
processes.push(floom);
floom.stdout.on('data', (d) => process.stdout.write(`[floom] ${d}`));
floom.stderr.on('data', (d) => process.stderr.write(`[floom] ${d}`));

console.log('Sharing P1 · link token API paths');
await waitForHttp(`http://127.0.0.1:${FLOOM_PORT}/api/health`, 20_000);

const htmlNoKey = await api('/p/link-api-app');
log('/p/:slug without key returns 404', htmlNoKey.status === 404, `got ${htmlNoKey.status}`);
const htmlWrongKey = await api('/p/link-api-app?key=wrong');
log('/p/:slug with wrong key returns 404', htmlWrongKey.status === 404, `got ${htmlWrongKey.status}`);
const htmlWithKey = await api(`/p/link-api-app?key=${token}`);
log('/p/:slug with key returns 200', htmlWithKey.status === 200, `got ${htmlWithKey.status}`);

const hubNoKey = await api('/api/hub/link-api-app');
log('/api/hub/:slug without key returns 404', hubNoKey.status === 404, `got ${hubNoKey.status}`);
const hubWrongKey = await api('/api/hub/link-api-app?key=wrong');
log('/api/hub/:slug with wrong key returns 404', hubWrongKey.status === 404, `got ${hubWrongKey.status}`);
const hubWithKey = await api(`/api/hub/link-api-app?key=${token}`);
log(
  '/api/hub/:slug with key returns app metadata',
  hubWithKey.status === 200 && hubWithKey.json?.slug === 'link-api-app',
  hubWithKey.text,
);

const runBody = {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ app_slug: 'link-api-app', inputs: {} }),
};
const runNoKey = await api('/api/run', runBody);
log('/api/run without key returns 404', runNoKey.status === 404, `got ${runNoKey.status}`);
const runWrongKey = await api('/api/run?key=wrong', runBody);
log('/api/run with wrong key returns 404', runWrongKey.status === 404, `got ${runWrongKey.status}`);
const runWithKey = await api(`/api/run?key=${token}`, runBody);
log(
  '/api/run with key returns 200 and run_id',
  runWithKey.status === 200 && typeof runWithKey.json?.run_id === 'string',
  runWithKey.text,
);

const dispatched = await waitForCondition(
  async () => {
    const row = db.prepare(`SELECT status FROM runs WHERE app_id = ?`).get(appId);
    return Boolean(row && upstreamHits >= 1);
  },
  5_000,
);
log('/api/run with key dispatches the run upstream', dispatched, `hits=${upstreamHits}`);

console.log(`\n${passed} passed, ${failed} failed`);
cleanup();
if (failed > 0) process.exit(1);

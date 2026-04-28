#!/usr/bin/env node
// Layer 5 Round 1: per-app MCP run insert carries the same scope columns as HTTP run.

import http from 'node:http';
import { spawn } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const tmp = mkdtempSync(join(tmpdir(), 'floom-mcp-run-parity-'));
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
delete process.env.FLOOM_CLOUD_MODE;
delete process.env.FLOOM_AUTH_TOKEN;

const { db } = await import('../../apps/server/dist/db.js');
const agentTokens = await import('../../apps/server/dist/lib/agent-tokens.js');

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

async function jsonFetch(port, path, { method = 'GET', token, body } = {}) {
  const headers = new Headers();
  if (body !== undefined) headers.set('content-type', 'application/json');
  if (token) headers.set('authorization', `Bearer ${token}`);
  const res = await fetch(`http://localhost:${port}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}
  return { res, text, json };
}

async function callPerAppMcp(port, token, name, args) {
  const res = await fetch(`http://localhost:${port}/mcp/app/mcp-run-parity`, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  let payload = null;
  try {
    payload = JSON.parse(json?.result?.content?.[0]?.text);
  } catch {}
  return { res, text, json, payload };
}

function createToken() {
  const raw = agentTokens.generateAgentToken();
  db.prepare(
    `INSERT INTO agent_tokens
       (id, prefix, hash, label, scope, workspace_id, user_id, created_at,
        last_used_at, revoked_at, rate_limit_per_minute)
     VALUES ('agtok_mcp_run_parity', ?, ?, 'mcp parity', 'read-write',
        'local', 'local', ?, NULL, NULL, 1000)`,
  ).run(
    agentTokens.extractAgentTokenPrefix(raw),
    agentTokens.hashAgentToken(raw),
    new Date().toISOString(),
  );
  return raw;
}

function insertApp(baseUrl) {
  const spec = {
    openapi: '3.0.0',
    info: { title: 'MCP Run Parity', version: '1.0.0' },
    servers: [{ url: baseUrl }],
    paths: {
      '/echo': {
        get: {
          operationId: 'echo',
          parameters: [{ name: 'message', in: 'query', schema: { type: 'string' } }],
          responses: { 200: { description: 'ok' } },
        },
      },
    },
  };
  const manifest = {
    name: 'MCP Run Parity',
    description: 'MCP run insert parity fixture',
    runtime: 'python',
    manifest_version: '2.0',
    python_dependencies: [],
    node_dependencies: {},
    secrets_needed: [],
    actions: {
      echo: {
        label: 'Echo',
        inputs: [{ name: 'message', type: 'text', label: 'Message', required: true }],
        outputs: [{ name: 'response', type: 'json', label: 'Response' }],
        secrets_needed: [],
      },
    },
  };
  db.prepare(
    `INSERT INTO apps
       (id, slug, name, description, manifest, status, docker_image, code_path,
        category, author, icon, app_type, base_url, auth_type, auth_config,
        openapi_spec_url, openapi_spec_cached, visibility, is_async, webhook_url,
        timeout_ms, retries, async_mode, workspace_id, publish_status)
     VALUES ('app_mcp_run_parity', 'mcp-run-parity', 'MCP Run Parity',
        'MCP run insert parity fixture', ?, 'active', NULL, '', 'testing',
        'local', NULL, 'proxied', ?, NULL, NULL, NULL, ?, 'public',
        0, NULL, NULL, 0, NULL, 'local', 'published')`,
  ).run(JSON.stringify(manifest), baseUrl, JSON.stringify(spec));
}

const upstream = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  if (url.pathname === '/echo') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, message: url.searchParams.get('message') }));
    return;
  }
  res.writeHead(404);
  res.end('not found');
});

console.log('Layer 5 MCP run parity tests');

const upstreamPort = await listen(upstream);
insertApp(`http://127.0.0.1:${upstreamPort}`);
const token = createToken();
db.pragma('wal_checkpoint(TRUNCATE)');

const server = await bootServer();
try {
  const httpRun = await jsonFetch(server.port, '/api/mcp-run-parity/run', {
    method: 'POST',
    token,
    body: { action: 'echo', inputs: { message: 'http' } },
  });
  log('HTTP slug run returns pending run id', httpRun.res.status === 200 && /^run_/.test(httpRun.json?.run_id || ''), httpRun.text);

  const mcpRun = await callPerAppMcp(server.port, token, 'echo', { message: 'mcp' });
  log('per-app MCP run returns run snapshot', mcpRun.payload?.id && mcpRun.payload?.action === 'echo', mcpRun.text);

  const httpRow = db.prepare('SELECT * FROM runs WHERE id = ?').get(httpRun.json?.run_id);
  const mcpRow = db.prepare('SELECT * FROM runs WHERE id = ?').get(mcpRun.payload?.id);

  log('HTTP run row has workspace_id', httpRow?.workspace_id === 'local', JSON.stringify(httpRow));
  log('HTTP run row has user_id', httpRow?.user_id === 'local', JSON.stringify(httpRow));
  log('HTTP run row has device_id', typeof httpRow?.device_id === 'string' && httpRow.device_id.length > 0, JSON.stringify(httpRow));
  log('HTTP run row has thread_id column', Object.prototype.hasOwnProperty.call(httpRow || {}, 'thread_id'));

  log('MCP run row has workspace_id', mcpRow?.workspace_id === httpRow?.workspace_id, JSON.stringify(mcpRow));
  log('MCP run row has user_id', mcpRow?.user_id === httpRow?.user_id, JSON.stringify(mcpRow));
  log('MCP run row has device_id', typeof mcpRow?.device_id === 'string' && mcpRow.device_id.length > 0, JSON.stringify(mcpRow));
  log('MCP run row has thread_id column', Object.prototype.hasOwnProperty.call(mcpRow || {}, 'thread_id'));

  const listed = await jsonFetch(server.port, '/api/me/runs?limit=20', { token });
  const listedIds = new Set((listed.json?.runs || []).map((run) => run.id));
  log('/api/me/runs returns HTTP run', listedIds.has(httpRun.json?.run_id), listed.text);
  log('/api/me/runs returns MCP-initiated run', listedIds.has(mcpRun.payload?.id), listed.text);
} finally {
  await stopServer(server);
  upstream.close();
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

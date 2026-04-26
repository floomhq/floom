#!/usr/bin/env node
// PR #789 P1 regression: MCP run_app on POST /mcp must consume the same
// agent-token run budget as REST run surfaces and reject oversized MCP bodies
// before JSON-RPC dispatch.

import http from 'node:http';
import { spawn } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const tmp = mkdtempSync(join(tmpdir(), 'floom-mcp-run-limits-'));
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
delete process.env.FLOOM_AUTH_TOKEN;
delete process.env.FLOOM_RATE_LIMIT_DISABLED;
delete process.env.FLOOM_RUN_BODY_LIMIT_DISABLED;

const { db } = await import('../../apps/server/dist/db.js');
const agentTokens = await import('../../apps/server/dist/lib/agent-tokens.js');
const { RUN_BODY_LIMIT_BYTES } = await import('../../apps/server/dist/middleware/body-size.js');

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

function createToken({ id, rateLimit }) {
  const raw = agentTokens.generateAgentToken();
  db.prepare(
    `INSERT INTO agent_tokens
       (id, prefix, hash, label, scope, workspace_id, user_id, created_at,
        last_used_at, revoked_at, rate_limit_per_minute)
     VALUES (?, ?, ?, ?, 'read-write', 'local', 'local', ?, NULL, NULL, ?)`,
  ).run(
    id,
    agentTokens.extractAgentTokenPrefix(raw),
    agentTokens.hashAgentToken(raw),
    id,
    new Date().toISOString(),
    rateLimit,
  );
  return raw;
}

function insertApp(baseUrl) {
  const spec = {
    openapi: '3.0.0',
    info: { title: 'MCP Limit App', version: '1.0.0' },
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
    name: 'MCP Limit App',
    description: 'run limit fixture',
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
     VALUES ('app_mcp_run_limits', 'mcp-run-limits', 'MCP Limit App',
        'run limit fixture', ?, 'active', NULL, '', 'testing', 'local', NULL,
        'proxied', ?, NULL, NULL, NULL, ?, 'public', 0, NULL, NULL, 0, NULL,
        'local', 'published')`,
  ).run(JSON.stringify(manifest), baseUrl, JSON.stringify(spec));
}

async function callMcp(port, token, name, args) {
  const res = await fetch(`http://localhost:${port}/mcp`, {
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

async function oversizedMcpPost(port, token) {
  return await new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/mcp',
        method: 'POST',
        headers: {
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'content-length': String(RUN_BODY_LIMIT_BYTES + 1),
        },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          text += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode, text }));
      },
    );
    req.on('error', reject);
    req.end('{}');
  });
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

console.log('MCP run_app run-surface limits');

const upstreamPort = await listen(upstream);
insertApp(`http://127.0.0.1:${upstreamPort}`);
const limitedToken = createToken({ id: 'agtok_mcp_run_limits', rateLimit: 2 });
const oversizedToken = createToken({ id: 'agtok_mcp_oversized', rateLimit: 1000 });
db.pragma('wal_checkpoint(TRUNCATE)');

const server = await bootServer();
try {
  const first = await callMcp(server.port, limitedToken, 'run_app', {
    slug: 'mcp-run-limits',
    inputs: { message: 'one' },
  });
  const second = await callMcp(server.port, limitedToken, 'run_app', {
    slug: 'mcp-run-limits',
    inputs: { message: 'two' },
  });
  const third = await callMcp(server.port, limitedToken, 'run_app', {
    slug: 'mcp-run-limits',
    inputs: { message: 'three' },
  });

  log('first run_app succeeds under token budget', first.payload?.status === 'success', first.text);
  log('second run_app succeeds at token budget', second.payload?.status === 'success', second.text);
  log('third run_app returns MCP tool error', third.json?.result?.isError === true, third.text);
  log(
    'third run_app is agent-token rate-limited',
    third.payload?.error === 'rate_limit_exceeded' &&
      third.payload?.status === 429 &&
      third.payload?.details?.scope === 'agent_token',
    JSON.stringify(third.payload),
  );

  const oversized = await oversizedMcpPost(server.port, oversizedToken);
  let oversizedBody = null;
  try {
    oversizedBody = JSON.parse(oversized.text);
  } catch {}
  log('oversized MCP POST returns 413', oversized.status === 413, oversized.text);
  log('oversized MCP POST uses run body limit envelope', oversizedBody?.error === 'request_body_too_large', oversized.text);
} finally {
  await stopServer(server);
  upstream.close();
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

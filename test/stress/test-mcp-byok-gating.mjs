#!/usr/bin/env node
// PR #789 P1 regression: agent-token runs through MCP run_app must preserve
// the launch BYOK gate for competitor-lens / ai-readiness-audit / pitch-coach.

import http from 'node:http';
import { spawn } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const tmp = mkdtempSync(join(tmpdir(), 'floom-mcp-byok-'));
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

function createToken() {
  const raw = agentTokens.generateAgentToken();
  db.prepare(
    `INSERT INTO agent_tokens
       (id, prefix, hash, label, scope, workspace_id, user_id, created_at,
        last_used_at, revoked_at, rate_limit_per_minute)
     VALUES ('agtok_mcp_byok', ?, ?, 'byok', 'read-write', 'local', 'local',
        ?, NULL, NULL, 1000)`,
  ).run(
    agentTokens.extractAgentTokenPrefix(raw),
    agentTokens.hashAgentToken(raw),
    new Date().toISOString(),
  );
  return raw;
}

function insertCompetitorLens(baseUrl) {
  const spec = {
    openapi: '3.0.0',
    info: { title: 'Competitor Lens', version: '1.0.0' },
    servers: [{ url: baseUrl }],
    paths: {
      '/analyze': {
        get: {
          operationId: 'analyze',
          parameters: [{ name: 'target', in: 'query', schema: { type: 'string' } }],
          responses: { 200: { description: 'ok' } },
        },
      },
    },
  };
  const manifest = {
    name: 'Competitor Lens',
    description: 'BYOK gated fixture',
    runtime: 'python',
    manifest_version: '2.0',
    python_dependencies: [],
    node_dependencies: {},
    secrets_needed: ['GEMINI_API_KEY'],
    actions: {
      analyze: {
        label: 'Analyze',
        inputs: [{ name: 'target', type: 'text', label: 'Target', required: true }],
        outputs: [{ name: 'response', type: 'json', label: 'Response' }],
        secrets_needed: ['GEMINI_API_KEY'],
      },
    },
  };
  db.prepare(
    `INSERT INTO apps
       (id, slug, name, description, manifest, status, docker_image, code_path,
        category, author, icon, app_type, base_url, auth_type, auth_config,
        openapi_spec_url, openapi_spec_cached, visibility, is_async, webhook_url,
        timeout_ms, retries, async_mode, workspace_id, publish_status)
     VALUES ('app_competitor_lens_byok', 'competitor-lens', 'Competitor Lens',
        'BYOK gated fixture', ?, 'active', NULL, '', 'testing', 'local', NULL,
        'proxied', ?, NULL, NULL, NULL, ?, 'public', 0, NULL, NULL, 0, NULL,
        'local', 'published')`,
  ).run(JSON.stringify(manifest), baseUrl, JSON.stringify(spec));
  db.prepare(
    `INSERT INTO secrets (id, name, value, app_id)
     VALUES ('sec_global_gemini_byok_test', 'GEMINI_API_KEY', 'server-paid-test-key', NULL)`,
  ).run();
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

const upstream = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  if (url.pathname === '/analyze') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, target: url.searchParams.get('target') }));
    return;
  }
  res.writeHead(404);
  res.end('not found');
});

console.log('MCP run_app BYOK gate');

const upstreamPort = await listen(upstream);
insertCompetitorLens(`http://127.0.0.1:${upstreamPort}`);
const token = createToken();
db.pragma('wal_checkpoint(TRUNCATE)');

const server = await bootServer();
try {
  const freeRuns = [];
  for (let i = 0; i < 5; i++) {
    freeRuns.push(
      await callMcp(server.port, token, 'run_app', {
        slug: 'competitor-lens',
        action: 'analyze',
        inputs: { target: `Acme ${i + 1}` },
      }),
    );
  }
  log(
    'first five competitor-lens MCP runs use free quota successfully',
    freeRuns.every((run) => run.payload?.status === 'success'),
    JSON.stringify(freeRuns.map((run) => run.payload)),
  );

  const exhausted = await callMcp(server.port, token, 'run_app', {
    slug: 'competitor-lens',
    action: 'analyze',
    inputs: { target: 'Acme exhausted' },
  });
  log('sixth run without BYOK returns MCP tool error', exhausted.json?.result?.isError === true, exhausted.text);
  log(
    'sixth run without BYOK returns byok_required',
    exhausted.payload?.error === 'byok_required' &&
      exhausted.payload?.status === 429 &&
      exhausted.payload?.details?.usage === 5,
    JSON.stringify(exhausted.payload),
  );

  const withByok = await callMcp(server.port, token, 'run_app', {
    slug: 'competitor-lens',
    action: 'analyze',
    inputs: {
      target: 'Acme BYOK',
      gemini_api_key: 'AIzaSyTestKeyForMcpByokGating123456789',
    },
  });
  log('run with gemini_api_key succeeds after free quota exhaustion', withByok.payload?.status === 'success', withByok.text);
  log('BYOK run returns upstream output', withByok.payload?.output?.target === 'Acme BYOK', withByok.text);
} finally {
  await stopServer(server);
  upstream.close();
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

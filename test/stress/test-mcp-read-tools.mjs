#!/usr/bin/env node
// Phase 2B read/run tools:
// token mint, visibility/scope checks, run execution, run reads, pagination,
// invalid bearer, publish-only denial, and per-token rate limiting.

import http from 'node:http';
import { spawn } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const tmp = mkdtempSync(join(tmpdir(), 'floom-mcp-read-tools-'));
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
  const raw = json?.result?.content?.[0]?.text;
  try {
    payload = JSON.parse(raw);
  } catch {}
  return { res, text, json, payload };
}

function createUser(id, workspaceId) {
  db.prepare(
    `INSERT INTO workspaces (id, slug, name, plan)
     VALUES (?, ?, ?, 'oss')
     ON CONFLICT(id) DO NOTHING`,
  ).run(workspaceId, workspaceId, workspaceId);
  db.prepare(
    `INSERT INTO users (id, workspace_id, email, name, auth_provider)
     VALUES (?, ?, ?, ?, 'test')
     ON CONFLICT(id) DO NOTHING`,
  ).run(id, workspaceId, `${id}@example.com`, id);
  db.prepare(
    `INSERT INTO workspace_members (workspace_id, user_id, role)
     VALUES (?, ?, 'admin')
     ON CONFLICT(workspace_id, user_id) DO NOTHING`,
  ).run(workspaceId, id);
}

function createToken({ id, userId, workspaceId, scope, rateLimit = 1000 }) {
  const raw = agentTokens.generateAgentToken();
  db.prepare(
    `INSERT INTO agent_tokens
       (id, prefix, hash, label, scope, workspace_id, user_id, created_at,
        last_used_at, revoked_at, rate_limit_per_minute)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
  ).run(
    id,
    agentTokens.extractAgentTokenPrefix(raw),
    agentTokens.hashAgentToken(raw),
    id,
    scope,
    workspaceId,
    userId,
    new Date().toISOString(),
    rateLimit,
  );
  return raw;
}

function insertApp({ id, slug, name, visibility, author, workspaceId, baseUrl }) {
  const spec = {
    openapi: '3.0.0',
    info: { title: name, version: '1.0.0' },
    servers: [{ url: baseUrl }],
    paths: {
      '/echo': {
        get: {
          operationId: 'echo',
          parameters: [
            {
              name: 'message',
              in: 'query',
              schema: { type: 'string' },
            },
          ],
          responses: { 200: { description: 'ok' } },
        },
      },
    },
  };
  const manifest = {
    name,
    description: `${name} test fixture`,
    runtime: 'python',
    manifest_version: '2.0',
    python_dependencies: [],
    node_dependencies: {},
    secrets_needed: [],
    actions: {
      echo: {
        label: 'Echo',
        description: 'Echo a message',
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
     VALUES (?, ?, ?, ?, ?, 'active', NULL, '', 'testing', ?, NULL, 'proxied',
        ?, NULL, NULL, NULL, ?, ?, 0, NULL, NULL, 0, NULL, ?, 'published')`,
  ).run(
    id,
    slug,
    name,
    `${name} test fixture`,
    JSON.stringify(manifest),
    author,
    baseUrl,
    JSON.stringify(spec),
    visibility,
    workspaceId,
  );
}

const upstream = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  if (url.pathname === '/echo') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, message: url.searchParams.get('message') }));
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not_found' }));
});

console.log('MCP read/run tools');

const upstreamPort = await listen(upstream);
const baseUrl = `http://127.0.0.1:${upstreamPort}`;
createUser('owner-user', 'owner-ws');
createUser('other-user', 'other-ws');
insertApp({
  id: 'app_public_agent_read',
  slug: 'agent-read-public',
  name: 'Agent Read Public',
  visibility: 'public',
  author: 'owner-user',
  workspaceId: 'owner-ws',
  baseUrl,
});
insertApp({
  id: 'app_private_agent_read',
  slug: 'agent-read-private',
  name: 'Agent Read Private',
  visibility: 'private',
  author: 'owner-user',
  workspaceId: 'owner-ws',
  baseUrl,
});
const otherToken = createToken({
  id: 'agtok_other_readwrite',
  userId: 'other-user',
  workspaceId: 'other-ws',
  scope: 'read-write',
});
db.prepare(
  `INSERT INTO runs (id, app_id, action, inputs, outputs, status, workspace_id, user_id, device_id, duration_ms, finished_at)
   VALUES ('run_other_owner', 'app_public_agent_read', 'echo', '{}', '{"ok":true}', 'success', 'owner-ws', 'owner-user', 'owner-device', 1, datetime('now'))`,
).run();
db.pragma('wal_checkpoint(TRUNCATE)');

const server = await bootServer();

try {
  const minted = await jsonFetch(server.port, '/api/me/agent-keys', {
    method: 'POST',
    body: { label: 'phase-2b-read', scope: 'read' },
  });
  const readToken = minted.json?.raw_token;
  log('token mint returns a read token', minted.res.status === 201 && /^floom_agent_/.test(readToken || ''), minted.text);

  const discover = await callMcp(server.port, readToken, 'discover_apps', { q: 'Agent Read', limit: 20 });
  const slugs = (discover.payload?.apps || []).map((app) => app.slug).sort();
  log('discover_apps includes public accessible app', slugs.includes('agent-read-public'), JSON.stringify(slugs));
  log('discover_apps hides private app from non-owner token', !slugs.includes('agent-read-private'), JSON.stringify(slugs));

  const run = await callMcp(server.port, readToken, 'run_app', {
    slug: 'agent-read-public',
    inputs: { message: 'hello-agent' },
  });
  const runId = run.payload?.run_id;
  log('run_app with public slug succeeds', run.payload?.status === 'success', JSON.stringify(run.payload));
  log('run_app returns upstream output', run.payload?.output?.message === 'hello-agent', JSON.stringify(run.payload));

  const privateRun = await callMcp(server.port, readToken, 'run_app', {
    slug: 'agent-read-private',
    inputs: { message: 'nope' },
  });
  log('run_app private slug for non-owner returns MCP error', privateRun.json?.result?.isError === true, privateRun.text);
  log('private slug error is 403 not_accessible', privateRun.payload?.error === 'not_accessible' && privateRun.payload?.status === 403, JSON.stringify(privateRun.payload));

  const ownRun = await callMcp(server.port, readToken, 'get_run', { run_id: runId });
  log('get_run for own run succeeds', ownRun.payload?.run_id === runId && ownRun.payload?.status === 'success', JSON.stringify(ownRun.payload));

  const otherRun = await callMcp(server.port, readToken, 'get_run', { run_id: 'run_other_owner' });
  log('get_run for another user returns MCP error', otherRun.json?.result?.isError === true, otherRun.text);
  log('get_run for another user is 403', otherRun.payload?.error === 'not_accessible' && otherRun.payload?.status === 403, JSON.stringify(otherRun.payload));

  db.prepare(
    `INSERT INTO runs (id, app_id, action, inputs, outputs, status, workspace_id, user_id, device_id, duration_ms, finished_at)
     VALUES ('run_local_extra', 'app_public_agent_read', 'echo', '{}', '{"ok":true}', 'success', 'local', 'local', 'extra-device', 1, datetime('now'))`,
  ).run();
  db.pragma('wal_checkpoint(TRUNCATE)');
  const page1 = await callMcp(server.port, readToken, 'list_my_runs', { limit: 1 });
  const page2 = await callMcp(server.port, readToken, 'list_my_runs', {
    limit: 1,
    cursor: page1.payload?.next_cursor,
  });
  log('list_my_runs page 1 returns one row', page1.payload?.runs?.length === 1 && typeof page1.payload?.next_cursor === 'string', JSON.stringify(page1.payload));
  log('list_my_runs page 2 returns a different row', page2.payload?.runs?.length === 1 && page2.payload.runs[0].run_id !== page1.payload.runs[0].run_id, JSON.stringify(page2.payload));

  const invalid = await jsonFetch(server.port, '/api/agents/apps', {
    token: 'floom_agent_00000000000000000000000000000000',
  });
  log('invalid bearer returns 401', invalid.res.status === 401 && invalid.json?.error === 'invalid_agent_token', invalid.text);

  const publishMint = await jsonFetch(server.port, '/api/me/agent-keys', {
    method: 'POST',
    body: { label: 'phase-2b-publish-only', scope: 'publish-only' },
  });
  const publishOnly = await callMcp(server.port, publishMint.json?.raw_token, 'discover_apps', {});
  log('publish-only scope is rejected on read tool', publishOnly.payload?.error === 'forbidden_scope' && publishOnly.payload?.status === 403, JSON.stringify(publishOnly.payload));

  const lowLimit = createToken({
    id: 'agtok_low_limit',
    userId: 'other-user',
    workspaceId: 'other-ws',
    scope: 'read',
    rateLimit: 1,
  });
  db.pragma('wal_checkpoint(TRUNCATE)');
  await jsonFetch(server.port, '/api/agents/run', {
    method: 'POST',
    token: lowLimit,
    body: { slug: 'missing-agent-rate-limit', inputs: {} },
  });
  const limited = await jsonFetch(server.port, '/api/agents/run', {
    method: 'POST',
    token: lowLimit,
    body: { slug: 'missing-agent-rate-limit', inputs: {} },
  });
  log('per-token rate limit returns 429', limited.res.status === 429, limited.text);
  log('rate-limit scope is agent_token', limited.res.headers.get('x-ratelimit-scope') === 'agent_token' && limited.json?.scope === 'agent_token', limited.text);

  const otherDiscover = await callMcp(server.port, otherToken, 'discover_apps', {});
  const otherSlugs = (otherDiscover.payload?.apps || []).map((app) => app.slug);
  log('manually inserted non-owner token can discover public app', otherSlugs.includes('agent-read-public'), JSON.stringify(otherSlugs));
} finally {
  await stopServer(server);
  upstream.close();
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

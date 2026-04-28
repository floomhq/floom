#!/usr/bin/env node
// Phase 2B MCP server contract: agent-token calls to /mcp expose the
// read/run toolset with JSON Schema and JSON-RPC tool-call ergonomics.

import { spawn } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const tmp = mkdtempSync(join(tmpdir(), 'floom-mcp-server-'));
const dataDir = join(tmp, 'data');
mkdirSync(dataDir, { recursive: true });

process.env.DATA_DIR = dataDir;
process.env.FLOOM_DISABLE_JOB_WORKER = 'true';
process.env.FLOOM_DISABLE_TRIGGERS_WORKER = 'true';
process.env.FLOOM_DISABLE_ZOMBIE_SWEEPER = 'true';
process.env.FLOOM_SEED_APPS = 'false';
process.env.FLOOM_SEED_LAUNCH_DEMOS = 'false';
process.env.FLOOM_FAST_APPS = 'false';
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

function createToken(scope = 'read-write') {
  const raw = agentTokens.generateAgentToken();
  db.prepare(
    `INSERT INTO agent_tokens
       (id, prefix, hash, label, scope, workspace_id, user_id, created_at,
        last_used_at, revoked_at, rate_limit_per_minute)
     VALUES (?, ?, ?, ?, ?, 'local', 'local', ?, NULL, NULL, 1000)`,
  ).run(
    `agtok_${scope}_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    agentTokens.extractAgentTokenPrefix(raw),
    agentTokens.hashAgentToken(raw),
    `test-${scope}`,
    scope,
    new Date().toISOString(),
  );
  db.pragma('wal_checkpoint(TRUNCATE)');
  return raw;
}

async function callMcp(port, token, body) {
  const res = await fetch(`http://localhost:${port}/mcp`, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { res, text, json };
}

console.log('MCP agent read server');

const readToken = createToken('read');
const writeToken = createToken('read-write');
const publishToken = createToken('publish-only');
const server = await bootServer();

try {
  const readList = await callMcp(server.port, readToken, {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/list',
    params: {},
  });
  const readTools = readList.json?.result?.tools || [];
  const readNames = readTools.map((tool) => tool.name).sort();
  const readExpected = [
    'discover_apps',
    'get_app_skill',
    'get_run',
    'list_my_runs',
    'run_app',
  ];
  log('tools/list returns HTTP 200', readList.res.status === 200, readList.text);
  log('tools/list returns JSON-RPC 2.0', readList.json?.jsonrpc === '2.0', readList.text);
  log('read token /mcp exposes exactly five read/run tools', JSON.stringify(readNames) === JSON.stringify(readExpected), JSON.stringify(readNames));

  const writeList = await callMcp(server.port, writeToken, {
    jsonrpc: '2.0',
    id: 11,
    method: 'tools/list',
    params: {},
  });
  const writeNames = (writeList.json?.result?.tools || []).map((tool) => tool.name).sort();
  const writeExpected = [
    'discover_apps',
    'get_app_skill',
    'get_run',
    'list_my_runs',
    'run_app',
    'studio_detect_app',
    'studio_ingest_hint',
    'studio_list_my_apps',
    'studio_publish_app',
  ];
  log('read-write token exposes run + studio tools', JSON.stringify(writeNames) === JSON.stringify(writeExpected), JSON.stringify(writeNames));

  const publishList = await callMcp(server.port, publishToken, {
    jsonrpc: '2.0',
    id: 12,
    method: 'tools/list',
    params: {},
  });
  const publishNames = (publishList.json?.result?.tools || []).map((tool) => tool.name).sort();
  const publishExpected = [
    'studio_detect_app',
    'studio_ingest_hint',
    'studio_list_my_apps',
    'studio_publish_app',
  ];
  log('publish-only token exposes studio tools without run tools', JSON.stringify(publishNames) === JSON.stringify(publishExpected), JSON.stringify(publishNames));

  const tools = writeList.json?.result?.tools || [];
  const discover = tools.find((tool) => tool.name === 'discover_apps');
  const skill = tools.find((tool) => tool.name === 'get_app_skill');
  const run = tools.find((tool) => tool.name === 'run_app');
  const getRun = tools.find((tool) => tool.name === 'get_run');
  const listRuns = tools.find((tool) => tool.name === 'list_my_runs');
  const publish = tools.find((tool) => tool.name === 'studio_publish_app');
  log('discover_apps schema exposes q + category + limit + cursor', Boolean(discover?.inputSchema?.properties?.q) && Boolean(discover?.inputSchema?.properties?.category) && Boolean(discover?.inputSchema?.properties?.limit) && Boolean(discover?.inputSchema?.properties?.cursor));
  log('get_app_skill requires slug', Array.isArray(skill?.inputSchema?.required) && skill.inputSchema.required.includes('slug'));
  log('run_app schema exposes slug + action + inputs', Boolean(run?.inputSchema?.properties?.slug) && Boolean(run?.inputSchema?.properties?.action) && Boolean(run?.inputSchema?.properties?.inputs));
  log('get_run requires run_id', Array.isArray(getRun?.inputSchema?.required) && getRun.inputSchema.required.includes('run_id'));
  log('list_my_runs schema exposes pagination args', Boolean(listRuns?.inputSchema?.properties?.limit) && Boolean(listRuns?.inputSchema?.properties?.cursor));
  log('studio_publish_app schema exposes OpenAPI publish args', Boolean(publish?.inputSchema?.properties?.openapi_url) && Boolean(publish?.inputSchema?.properties?.openapi_spec) && Boolean(publish?.inputSchema?.properties?.visibility));

  const call = await callMcp(server.port, writeToken, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'discover_apps', arguments: { limit: 5 } },
  });
  const rawPayload = call.json?.result?.content?.[0]?.text;
  let payload = null;
  try {
    payload = JSON.parse(rawPayload);
  } catch {}
  log('tools/call returns a JSON-RPC envelope', call.json?.jsonrpc === '2.0', call.text);
  log('discover_apps tool result is JSON text content', payload && Array.isArray(payload.apps), rawPayload);

  const publishCall = await callMcp(server.port, publishToken, {
    jsonrpc: '2.0',
    id: 20,
    method: 'tools/call',
    params: {
      name: 'studio_publish_app',
      arguments: {
        slug: 'agent-studio-publish',
        name: 'Agent Studio Publish',
        description: 'Published from the agent MCP studio surface',
        visibility: 'private',
        openapi_spec: {
          openapi: '3.0.0',
          info: { title: 'Agent Studio Publish', version: '1.0.0' },
          servers: [{ url: `http://localhost:${server.port}` }],
          paths: {
            '/echo': {
              post: {
                operationId: 'echo',
                requestBody: {
                  content: {
                    'application/json': {
                      schema: {
                        type: 'object',
                        properties: { message: { type: 'string' } },
                      },
                    },
                  },
                },
                responses: { 200: { description: 'ok' } },
              },
            },
          },
        },
      },
    },
  });
  let publishPayload = null;
  try {
    publishPayload = JSON.parse(publishCall.json?.result?.content?.[0]?.text);
  } catch {}
  const publishedRow = db.prepare('SELECT * FROM apps WHERE slug = ?').get('agent-studio-publish');
  log('publish-only token can publish via studio_publish_app', publishPayload?.ok === true && publishPayload?.slug === 'agent-studio-publish', publishCall.text);
  log('studio_publish_app persists owner-scoped app', Boolean(publishedRow) && publishedRow.workspace_id === 'local' && publishedRow.author === 'local', JSON.stringify(publishedRow));
  log('studio_publish_app returns request-origin URLs', publishPayload?.permalink === `http://localhost:${server.port}/p/agent-studio-publish` && publishPayload?.mcp_url === `http://localhost:${server.port}/mcp/app/agent-studio-publish`, JSON.stringify(publishPayload));

  const studioList = await callMcp(server.port, publishToken, {
    jsonrpc: '2.0',
    id: 21,
    method: 'tools/call',
    params: { name: 'studio_list_my_apps', arguments: { limit: 10 } },
  });
  let studioListPayload = null;
  try {
    studioListPayload = JSON.parse(studioList.json?.result?.content?.[0]?.text);
  } catch {}
  log('studio_list_my_apps includes pending private app', Boolean((studioListPayload?.apps || []).find((app) => app.slug === 'agent-studio-publish' && app.visibility === 'private')), studioList.text);
} finally {
  await stopServer(server);
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

#!/usr/bin/env node
// Regression test for MCP per-action secret gating.
//
// One app can have an app-level secrets_needed union while individual
// operations are public. MCP tools/list and tools/call must use the
// action's own secrets_needed, matching /api/run and proxied-runner.

import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'floom-mcp-action-secrets-'));
process.env.DATA_DIR = tmp;
process.env.FLOOM_DISABLE_JOB_WORKER = 'true';
process.env.PUBLIC_URL = 'http://localhost';

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

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

async function postMcp(slug, body) {
  const res = await mcpRouter.fetch(
    new Request(`http://localhost/app/${slug}`, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    }),
  );
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // leave null
  }
  return { status: res.status, json, text };
}

console.log('MCP per-action secrets tests');

const upstream = http.createServer((req, res) => {
  if (req.url === '/public') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, path: req.url }));
    return;
  }
  if (req.url === '/private') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, private: true }));
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not_found' }));
});

let db;
let mcpRouter;
try {
  const port = await listen(upstream);
  const baseUrl = `http://127.0.0.1:${port}`;
  ({ db } = await import('../../apps/server/dist/db.js'));
  ({ mcpRouter } = await import('../../apps/server/dist/routes/mcp.js'));

  const manifest = {
    schema_version: '1',
    name: 'MCP Action Secrets',
    description: 'Fixture app for MCP action-level secrets',
    secrets_needed: ['api_key'],
    actions: {
      publicOp: {
        label: 'Public Op',
        description: 'Public operation',
        inputs: [],
        secrets_needed: [],
      },
      privateOp: {
        label: 'Private Op',
        description: 'Secret operation',
        inputs: [],
        secrets_needed: ['api_key'],
      },
    },
  };

  const spec = {
    openapi: '3.0.0',
    info: { title: 'MCP Action Secrets', version: '1.0.0' },
    servers: [{ url: baseUrl }],
    components: {
      securitySchemes: {
        api_key: { type: 'apiKey', name: 'X-API-Key', in: 'header' },
      },
    },
    paths: {
      '/public': {
        get: {
          operationId: 'publicOp',
          security: [],
          responses: { '200': { description: 'ok' } },
        },
      },
      '/private': {
        get: {
          operationId: 'privateOp',
          security: [{ api_key: [] }],
          responses: { '200': { description: 'ok' } },
        },
      },
    },
  };

  db.prepare(
    `INSERT INTO apps
       (id, slug, name, description, manifest, status, docker_image,
        code_path, category, author, icon, app_type, base_url,
        auth_type, openapi_spec_url, openapi_spec_cached, visibility)
     VALUES (?, ?, ?, ?, ?, 'active', NULL, '', 'qa', 'local', 'tool',
        'proxied', ?, 'none', ?, ?, 'public')`,
  ).run(
    'app_mcp_action_secrets',
    'mcp-action-secrets',
    'MCP Action Secrets',
    'Fixture app for MCP action-level secrets',
    JSON.stringify(manifest),
    baseUrl,
    `${baseUrl}/openapi.json`,
    JSON.stringify(spec),
  );

  const list = await postMcp('mcp-action-secrets', {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/list',
    params: {},
  });
  const tools = list.json?.result?.tools || [];
  const publicTool = tools.find((t) => t.name === 'publicOp');
  const privateTool = tools.find((t) => t.name === 'privateOp');
  log('tools/list includes publicOp', Boolean(publicTool));
  log('tools/list includes privateOp', Boolean(privateTool));
  log(
    'publicOp schema does not advertise _auth',
    publicTool && !('_auth' in (publicTool.inputSchema?.properties || {})),
  );
  log(
    'privateOp schema advertises _auth',
    privateTool && '_auth' in (privateTool.inputSchema?.properties || {}),
  );

  const publicCall = await postMcp('mcp-action-secrets', {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'publicOp', arguments: {} },
  });
  log(
    'tools/call publicOp succeeds without api_key',
    publicCall.json?.result && publicCall.json.result.isError !== true,
    JSON.stringify(publicCall.json),
  );

  const privateCall = await postMcp('mcp-action-secrets', {
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'privateOp', arguments: {} },
  });
  const privateText = privateCall.json?.result?.content?.[0]?.text || '';
  log(
    'tools/call privateOp reports missing api_key',
    privateCall.json?.result?.isError === true &&
      privateText.includes('missing_secrets') &&
      privateText.includes('api_key'),
    JSON.stringify(privateCall.json),
  );
} finally {
  try {
    db?.close();
  } catch {
    // ignore
  }
  await new Promise((resolve) => upstream.close(resolve));
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

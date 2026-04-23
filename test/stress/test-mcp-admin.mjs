#!/usr/bin/env node
// MCP admin surface: /mcp (ingest_app, ingest_hint, detect_inline,
// list_apps, search_apps, get_app). ingest_hint + detect_inline were
// added as the proactive-recovery companion to ingest_app so MCP clients
// (Claude Desktop, Cursor, Claude Code) can self-serve the "I need to
// generate a spec" case without bouncing back to the web UI.
// Verifies tool discovery, input validation, auth gating on ingest, successful
// ingest from URL + inline JSON, duplicate-slug guard, and precedence vs the
// per-app /mcp/app/:slug handler.
//
// Run: node test/stress/test-mcp-admin.mjs

import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'floom-mcp-admin-'));
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

let db;
let mcpRouter;

async function callAdmin(body) {
  const res = await mcpRouter.fetch(
    new Request('http://localhost/', {
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

function parseToolText(resp) {
  const raw = resp.json?.result?.content?.[0]?.text;
  if (typeof raw !== 'string') return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// -- fixture: a tiny upstream that serves an OpenAPI spec ---------------
const upstream = http.createServer((req, res) => {
  if (req.url === '/openapi.json') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        openapi: '3.0.0',
        info: {
          title: 'Fixture Petstore',
          description: 'Tiny petstore fixture used by mcp-admin tests.',
          version: '1.0.0',
        },
        servers: [{ url: `http://127.0.0.1:${upstream.address()?.port || 0}` }],
        paths: {
          '/pets': {
            get: {
              operationId: 'listPets',
              summary: 'List pets',
              responses: { 200: { description: 'ok' } },
            },
            post: {
              operationId: 'createPet',
              summary: 'Create a pet',
              responses: { 201: { description: 'created' } },
            },
          },
        },
      }),
    );
    return;
  }
  if (req.url === '/pets') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ pets: [] }));
    return;
  }
  res.writeHead(404);
  res.end('not found');
});

console.log('MCP admin surface');

try {
  const upPort = await listen(upstream);
  const specUrl = `http://127.0.0.1:${upPort}/openapi.json`;
  ({ db } = await import('../../apps/server/dist/db.js'));
  ({ mcpRouter } = await import('../../apps/server/dist/routes/mcp.js'));

  // ===================================================================
  // 1. tools/list — six tools at /mcp root
  // (ingest_app, ingest_hint, detect_inline, list_apps, search_apps, get_app)
  // ===================================================================
  const list = await callAdmin({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/list',
    params: {},
  });
  const tools = list.json?.result?.tools || [];
  log('POST /mcp returns HTTP 200', list.status === 200);
  log('tools/list returns a JSON-RPC envelope', list.json?.jsonrpc === '2.0');
  log('tools/list returns six tools', tools.length === 6, `got ${tools.length}`);
  const toolNames = tools.map((t) => t.name).sort();
  const expectedTools = [
    'detect_inline',
    'get_app',
    'ingest_app',
    'ingest_hint',
    'list_apps',
    'search_apps',
  ];
  log(
    'tools include ingest_app, ingest_hint, detect_inline, list_apps, search_apps, get_app',
    JSON.stringify(toolNames) === JSON.stringify(expectedTools),
    JSON.stringify(toolNames),
  );

  const ingestTool = tools.find((t) => t.name === 'ingest_app');
  log('ingest_app has a description', typeof ingestTool?.description === 'string');
  log(
    'ingest_app exposes openapi_url in inputSchema',
    Boolean(ingestTool?.inputSchema?.properties?.openapi_url),
  );
  log(
    'ingest_app exposes openapi_spec in inputSchema',
    Boolean(ingestTool?.inputSchema?.properties?.openapi_spec),
  );
  log(
    'ingest_app slug field is constrained',
    typeof ingestTool?.inputSchema?.properties?.slug?.pattern === 'string' ||
      Boolean(ingestTool?.inputSchema?.properties?.slug),
  );

  const listTool = tools.find((t) => t.name === 'list_apps');
  log(
    'list_apps accepts category + keyword + limit',
    Boolean(listTool?.inputSchema?.properties?.category) &&
      Boolean(listTool?.inputSchema?.properties?.keyword) &&
      Boolean(listTool?.inputSchema?.properties?.limit),
  );

  const searchTool = tools.find((t) => t.name === 'search_apps');
  log(
    'search_apps requires a query field',
    Boolean(searchTool?.inputSchema?.properties?.query) &&
      Array.isArray(searchTool.inputSchema.required) &&
      searchTool.inputSchema.required.includes('query'),
  );

  const getTool = tools.find((t) => t.name === 'get_app');
  log(
    'get_app requires a slug field',
    Boolean(getTool?.inputSchema?.properties?.slug) &&
      Array.isArray(getTool.inputSchema.required) &&
      getTool.inputSchema.required.includes('slug'),
  );

  // ===================================================================
  // 2. ingest_app — missing input yields structured MCP error
  // ===================================================================
  const missing = await callAdmin({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'ingest_app', arguments: {} },
  });
  const missingPayload = parseToolText(missing);
  log(
    'ingest_app with no args returns isError',
    missing.json?.result?.isError === true,
  );
  log(
    'ingest_app no-args error code is invalid_input',
    missingPayload?.error === 'invalid_input',
    JSON.stringify(missingPayload),
  );

  // ===================================================================
  // 3. ingest_app — bad URL returns a structured ingest_failed error
  // ===================================================================
  const badUrl = await callAdmin({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: {
      name: 'ingest_app',
      arguments: { openapi_url: 'ftp://not-http.example' },
    },
  });
  const badUrlPayload = parseToolText(badUrl);
  log(
    'ingest_app rejects non-http(s) URL',
    badUrl.json?.result?.isError === true ||
      badUrl.json?.error ||
      Boolean(badUrlPayload?.error),
  );

  // ===================================================================
  // 4. ingest_app — successful ingest from URL
  // ===================================================================
  const okCall = await callAdmin({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: {
      name: 'ingest_app',
      arguments: {
        openapi_url: specUrl,
        slug: 'fixture-petstore',
        name: 'Fixture Petstore',
        category: 'qa',
      },
    },
  });
  const okPayload = parseToolText(okCall);
  log(
    'ingest_app succeeds for a reachable URL',
    okCall.json?.result?.isError !== true && okPayload?.ok === true,
    JSON.stringify(okPayload),
  );
  log(
    'ingest_app response carries the persisted slug',
    okPayload?.slug === 'fixture-petstore',
  );
  log(
    'ingest_app response carries created=true on first insert',
    okPayload?.created === true,
  );
  log(
    'ingest_app response includes a permalink',
    typeof okPayload?.permalink === 'string' &&
      okPayload.permalink.includes('/p/fixture-petstore'),
  );
  log(
    'ingest_app response includes an mcp_url',
    typeof okPayload?.mcp_url === 'string' &&
      okPayload.mcp_url.includes('/mcp/app/fixture-petstore'),
  );

  const row = db
    .prepare('SELECT slug, name, category FROM apps WHERE slug = ?')
    .get('fixture-petstore');
  log('ingest_app persisted the app row', Boolean(row));
  log('persisted name matches override', row?.name === 'Fixture Petstore');
  log('persisted category matches override', row?.category === 'qa');

  // ===================================================================
  // 5. ingest_app — duplicate slug from a different workspace fails
  // ===================================================================
  db.prepare('UPDATE apps SET workspace_id = ? WHERE slug = ?').run(
    'other-ws',
    'fixture-petstore',
  );
  const dup = await callAdmin({
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: {
      name: 'ingest_app',
      arguments: { openapi_url: specUrl, slug: 'fixture-petstore' },
    },
  });
  const dupPayload = parseToolText(dup);
  log(
    'duplicate slug owned by another workspace fails',
    dup.json?.result?.isError === true &&
      dupPayload?.error === 'slug_taken' &&
      typeof dupPayload?.message === 'string' &&
      dupPayload.message.includes('already taken'),
    JSON.stringify(dupPayload),
  );
  // restore so subsequent tests keep ownership of the row
  db.prepare('UPDATE apps SET workspace_id = ? WHERE slug = ?').run(
    'local',
    'fixture-petstore',
  );

  // ===================================================================
  // 6. ingest_app — inline JSON spec path
  // ===================================================================
  const inlineCall = await callAdmin({
    jsonrpc: '2.0',
    id: 6,
    method: 'tools/call',
    params: {
      name: 'ingest_app',
      arguments: {
        slug: 'inline-fixture',
        name: 'Inline Fixture',
        openapi_spec: {
          openapi: '3.0.0',
          info: { title: 'Inline Fixture', version: '1.0.0' },
          servers: [{ url: 'https://example.com' }],
          paths: {
            '/ping': {
              get: {
                operationId: 'ping',
                summary: 'Ping',
                responses: { 200: { description: 'ok' } },
              },
            },
          },
        },
      },
    },
  });
  const inlinePayload = parseToolText(inlineCall);
  log(
    'ingest_app accepts inline openapi_spec',
    inlineCall.json?.result?.isError !== true && inlinePayload?.ok === true,
    JSON.stringify(inlinePayload),
  );
  log(
    'inline ingest persists an app row',
    Boolean(
      db.prepare('SELECT 1 FROM apps WHERE slug = ?').get('inline-fixture'),
    ),
  );

  // ===================================================================
  // 7. ingest_app — Cloud-mode unauth is blocked
  // ===================================================================
  // Seed a Cloud-mode env and re-import a fresh router copy so isCloudMode()
  // flips to true for this assertion. We restore afterwards.
  const previousCloud = process.env.FLOOM_CLOUD_MODE;
  const previousSecret = process.env.BETTER_AUTH_SECRET;
  process.env.FLOOM_CLOUD_MODE = 'true';
  process.env.BETTER_AUTH_SECRET =
    previousSecret ||
    '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  // Better Auth is not configured in this test harness, so resolveUserContext
  // will fall through to the synthetic local (is_authenticated=false) context.
  // That is exactly the unauth case the gate must reject.
  const cloudModule = await import(
    `../../apps/server/dist/routes/mcp.js?cloud=${Date.now()}`
  );
  const unauth = await cloudModule.mcpRouter.fetch(
    new Request('http://localhost/', {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: {
          name: 'ingest_app',
          arguments: { openapi_url: specUrl, slug: 'cloud-block' },
        },
      }),
    }),
  );
  const unauthText = await unauth.text();
  let unauthJson = null;
  try {
    unauthJson = JSON.parse(unauthText);
  } catch {
    // leave null
  }
  const unauthPayload = (() => {
    const raw = unauthJson?.result?.content?.[0]?.text;
    if (typeof raw !== 'string') return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  })();
  log(
    'cloud-mode unauth ingest returns isError',
    unauthJson?.result?.isError === true,
  );
  log(
    'cloud-mode unauth ingest error code is auth_required',
    unauthPayload?.code === 'auth_required',
    JSON.stringify(unauthPayload),
  );
  log(
    'cloud-mode unauth ingest did not persist the app',
    !db.prepare('SELECT 1 FROM apps WHERE slug = ?').get('cloud-block'),
  );
  if (previousCloud === undefined) delete process.env.FLOOM_CLOUD_MODE;
  else process.env.FLOOM_CLOUD_MODE = previousCloud;
  if (previousSecret === undefined) delete process.env.BETTER_AUTH_SECRET;
  else process.env.BETTER_AUTH_SECRET = previousSecret;

  // ===================================================================
  // 8. list_apps — returns at least the two rows we ingested
  // ===================================================================
  const listApps = await callAdmin({
    jsonrpc: '2.0',
    id: 8,
    method: 'tools/call',
    params: { name: 'list_apps', arguments: {} },
  });
  const listPayload = parseToolText(listApps);
  log('list_apps returns a payload', Boolean(listPayload?.apps));
  log(
    'list_apps payload is an array',
    Array.isArray(listPayload?.apps),
  );
  const slugs = (listPayload?.apps || []).map((a) => a.slug);
  log(
    'list_apps includes the URL-ingested app',
    slugs.includes('fixture-petstore'),
  );
  log(
    'list_apps includes the inline-ingested app',
    slugs.includes('inline-fixture'),
  );
  log(
    'list_apps entries expose actions array',
    Array.isArray((listPayload?.apps?.[0] || {}).actions),
  );
  log(
    'list_apps entries expose permalink + mcp_url',
    typeof (listPayload?.apps?.[0] || {}).permalink === 'string' &&
      typeof (listPayload?.apps?.[0] || {}).mcp_url === 'string',
  );

  // category filter
  const listByCat = await callAdmin({
    jsonrpc: '2.0',
    id: 9,
    method: 'tools/call',
    params: { name: 'list_apps', arguments: { category: 'qa' } },
  });
  const byCatPayload = parseToolText(listByCat);
  const catSlugs = (byCatPayload?.apps || []).map((a) => a.slug);
  log(
    'list_apps category filter narrows the result',
    catSlugs.includes('fixture-petstore') && !catSlugs.includes('inline-fixture'),
  );

  // keyword filter
  const listByKeyword = await callAdmin({
    jsonrpc: '2.0',
    id: 10,
    method: 'tools/call',
    params: { name: 'list_apps', arguments: { keyword: 'inline' } },
  });
  const byKwPayload = parseToolText(listByKeyword);
  const kwSlugs = (byKwPayload?.apps || []).map((a) => a.slug);
  log(
    'list_apps keyword filter is case-insensitive substring match',
    kwSlugs.includes('inline-fixture'),
  );

  // limit enforcement
  const listByLimit = await callAdmin({
    jsonrpc: '2.0',
    id: 11,
    method: 'tools/call',
    params: { name: 'list_apps', arguments: { limit: 1 } },
  });
  const byLimitPayload = parseToolText(listByLimit);
  log(
    'list_apps limit caps the returned count',
    (byLimitPayload?.apps || []).length <= 1,
  );

  // ===================================================================
  // 9. search_apps — returns a list of matches with confidence
  // ===================================================================
  const search = await callAdmin({
    jsonrpc: '2.0',
    id: 12,
    method: 'tools/call',
    params: { name: 'search_apps', arguments: { query: 'pets', limit: 5 } },
  });
  const searchPayload = parseToolText(search);
  log(
    'search_apps returns an array',
    Array.isArray(searchPayload),
  );
  log(
    'search_apps results carry slug + confidence',
    Array.isArray(searchPayload) &&
      searchPayload.every(
        (r) => typeof r.slug === 'string' && typeof r.confidence === 'number',
      ),
  );
  log(
    'search_apps results include mcp_url + permalink',
    Array.isArray(searchPayload) &&
      searchPayload.every(
        (r) =>
          typeof r.mcp_url === 'string' && typeof r.permalink === 'string',
      ),
  );

  // ===================================================================
  // 10. get_app — full manifest lookup
  // ===================================================================
  const getCall = await callAdmin({
    jsonrpc: '2.0',
    id: 13,
    method: 'tools/call',
    params: { name: 'get_app', arguments: { slug: 'fixture-petstore' } },
  });
  const getPayload = parseToolText(getCall);
  log('get_app returns the slug', getPayload?.slug === 'fixture-petstore');
  log(
    'get_app returns the manifest object',
    getPayload?.manifest && typeof getPayload.manifest === 'object',
  );
  log(
    'get_app manifest exposes actions',
    getPayload?.manifest?.actions && typeof getPayload.manifest.actions === 'object',
  );
  log(
    'get_app manifest carries two actions (listPets, createPet)',
    Object.keys(getPayload?.manifest?.actions || {}).length === 2,
  );
  log(
    'get_app manifest action carries inputs array',
    Array.isArray(
      getPayload?.manifest?.actions?.listPets?.inputs ||
        getPayload?.manifest?.actions?.[
          Object.keys(getPayload?.manifest?.actions || {})[0]
        ]?.inputs,
    ),
  );
  log(
    'get_app returns permalink + mcp_url',
    typeof getPayload?.permalink === 'string' &&
      typeof getPayload?.mcp_url === 'string',
  );

  // missing slug
  const getMissing = await callAdmin({
    jsonrpc: '2.0',
    id: 14,
    method: 'tools/call',
    params: { name: 'get_app', arguments: { slug: 'does-not-exist' } },
  });
  const getMissingPayload = parseToolText(getMissing);
  log(
    'get_app returns isError for unknown slug',
    getMissing.json?.result?.isError === true,
  );
  log(
    'get_app unknown-slug error code is not_found',
    getMissingPayload?.error === 'not_found',
  );

  // invalid slug shape
  const getInvalid = await callAdmin({
    jsonrpc: '2.0',
    id: 15,
    method: 'tools/call',
    params: { name: 'get_app', arguments: { slug: 'INVALID SLUG' } },
  });
  log(
    'get_app rejects invalid slug shape via schema validation',
    getInvalid.json?.result?.isError === true ||
      Boolean(getInvalid.json?.error),
  );

  // ===================================================================
  // 11. Route precedence — /mcp/app/:slug still works after /mcp root
  // ===================================================================
  const perApp = await mcpRouter.fetch(
    new Request('http://localhost/app/fixture-petstore', {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 16,
        method: 'tools/list',
        params: {},
      }),
    }),
  );
  const perAppText = await perApp.text();
  let perAppJson = null;
  try {
    perAppJson = JSON.parse(perAppText);
  } catch {
    // leave null
  }
  const perAppTools = perAppJson?.result?.tools || [];
  log(
    '/mcp/app/:slug returns HTTP 200 after admin router install',
    perApp.status === 200,
  );
  log(
    '/mcp/app/:slug tools/list returns at least one tool',
    perAppTools.length >= 1,
  );
  log(
    '/mcp/app/:slug exposes the per-operation tools, not admin ones',
    !perAppTools.some((t) =>
      ['ingest_app', 'list_apps', 'get_app'].includes(t.name),
    ),
  );

  // ===================================================================
  // 12. tools/call with unknown admin tool name
  // ===================================================================
  const unknown = await callAdmin({
    jsonrpc: '2.0',
    id: 17,
    method: 'tools/call',
    params: { name: 'not_a_real_tool', arguments: {} },
  });
  log(
    'unknown admin tool returns a JSON-RPC error',
    Boolean(unknown.json?.error) || unknown.json?.result?.isError === true,
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

#!/usr/bin/env node
// B8 regression tests: the admin /mcp surface must derive permalink +
// mcp_url from the request origin, not from a hardcoded `https://floom.dev`.
//
// Two scenarios:
//   1. No env override — response URLs use the request's origin (so
//      preview.floom.dev ingestion returns preview.floom.dev permalinks).
//   2. FLOOM_PUBLIC_ORIGIN env set — response URLs use that override
//      regardless of the request host (so prod can pin responses to the
//      canonical origin even if the request came in on a shadow host).
//
// Run: node test/stress/test-mcp-base-url.mjs

import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'floom-mcp-base-url-'));
process.env.DATA_DIR = tmp;
process.env.FLOOM_DISABLE_JOB_WORKER = 'true';
// Intentionally unset: we're testing the helper's request-derived path.
delete process.env.FLOOM_PUBLIC_ORIGIN;
// The helper never reads PUBLIC_URL, but the test fixture's inline spec
// ingest path (ingestAppFromSpec) may. Leaving it unset is fine.

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

async function callIngestAt(url, body) {
  const res = await mcpRouter.fetch(
    new Request(url, {
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
  const raw = json?.result?.content?.[0]?.text;
  let payload = null;
  if (typeof raw === 'string') {
    try {
      payload = JSON.parse(raw);
    } catch {
      // leave null
    }
  }
  return { status: res.status, json, payload };
}

// Tiny upstream serving an OpenAPI spec so ingestAppFromUrl has something
// to fetch. We only care about the RESPONSE URLs, not the app itself, so
// the spec is minimal.
const upstream = http.createServer((req, res) => {
  if (req.url === '/openapi.json') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        openapi: '3.0.0',
        info: { title: 'Base URL Fixture', version: '1.0.0' },
        servers: [{ url: `http://127.0.0.1:${upstream.address()?.port || 0}` }],
        paths: {
          '/ping': {
            get: {
              operationId: 'ping',
              summary: 'Ping',
              responses: { 200: { description: 'ok' } },
            },
          },
        },
      }),
    );
    return;
  }
  res.writeHead(404);
  res.end('not found');
});

console.log('MCP base URL derivation (B8)');

try {
  const upPort = await listen(upstream);
  const specUrl = `http://127.0.0.1:${upPort}/openapi.json`;
  ({ db } = await import('../../apps/server/dist/db.js'));
  ({ mcpRouter } = await import('../../apps/server/dist/routes/mcp.js'));

  // -------------------------------------------------------------------
  // Scenario 1: ingest_app on preview.floom.dev should return preview
  // origin in permalink + mcp_url (no env override set).
  // -------------------------------------------------------------------
  const previewRes = await callIngestAt('https://preview.floom.dev/', {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'ingest_app',
      arguments: {
        openapi_url: specUrl,
        slug: 'base-url-preview',
        name: 'Base URL Preview',
      },
    },
  });
  log(
    'preview ingest: response is not an error',
    previewRes.json?.result?.isError !== true,
    JSON.stringify(previewRes.payload),
  );
  log(
    'preview ingest: permalink uses request origin (preview.floom.dev)',
    typeof previewRes.payload?.permalink === 'string' &&
      previewRes.payload.permalink.startsWith('https://preview.floom.dev/'),
    previewRes.payload?.permalink,
  );
  log(
    'preview ingest: permalink is /p/<slug>',
    previewRes.payload?.permalink ===
      'https://preview.floom.dev/p/base-url-preview',
    previewRes.payload?.permalink,
  );
  log(
    'preview ingest: mcp_url uses request origin',
    typeof previewRes.payload?.mcp_url === 'string' &&
      previewRes.payload.mcp_url ===
        'https://preview.floom.dev/mcp/app/base-url-preview',
    previewRes.payload?.mcp_url,
  );
  log(
    'preview ingest: response does NOT contain hardcoded floom.dev prod host',
    typeof previewRes.payload?.permalink === 'string' &&
      !previewRes.payload.permalink.startsWith('https://floom.dev/') &&
      !previewRes.payload.mcp_url.startsWith('https://floom.dev/'),
  );

  // -------------------------------------------------------------------
  // Scenario 2: with FLOOM_PUBLIC_ORIGIN set, responses use that origin
  // REGARDLESS of the request's Host header. This is the prod pin-to-
  // canonical mode.
  //
  // Need to re-import the router so the admin handler picks up the env
  // change at the time the request fires — the helper reads the env on
  // each call, so in theory the same module would suffice, but re-import
  // keeps this test independent from any internal caching future code
  // might add.
  // -------------------------------------------------------------------
  process.env.FLOOM_PUBLIC_ORIGIN = 'https://floom.dev';
  const pinnedModule = await import(
    `../../apps/server/dist/routes/mcp.js?pinned=${Date.now()}`
  );
  const pinnedRes = await pinnedModule.mcpRouter.fetch(
    new Request('https://some-random-host.example.com/', {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'ingest_app',
          arguments: {
            openapi_url: specUrl,
            slug: 'base-url-pinned',
            name: 'Base URL Pinned',
          },
        },
      }),
    }),
  );
  const pinnedText = await pinnedRes.text();
  let pinnedJson = null;
  try {
    pinnedJson = JSON.parse(pinnedText);
  } catch {
    // leave null
  }
  const pinnedPayload = (() => {
    const raw = pinnedJson?.result?.content?.[0]?.text;
    if (typeof raw !== 'string') return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  })();
  log(
    'pinned ingest: response is not an error',
    pinnedJson?.result?.isError !== true,
    JSON.stringify(pinnedPayload),
  );
  log(
    'pinned ingest: permalink uses FLOOM_PUBLIC_ORIGIN override',
    pinnedPayload?.permalink === 'https://floom.dev/p/base-url-pinned',
    pinnedPayload?.permalink,
  );
  log(
    'pinned ingest: mcp_url uses FLOOM_PUBLIC_ORIGIN override',
    pinnedPayload?.mcp_url === 'https://floom.dev/mcp/app/base-url-pinned',
    pinnedPayload?.mcp_url,
  );
  log(
    'pinned ingest: request host did NOT leak into the response URL',
    typeof pinnedPayload?.permalink === 'string' &&
      !pinnedPayload.permalink.includes('some-random-host.example.com') &&
      !pinnedPayload.mcp_url.includes('some-random-host.example.com'),
  );

  // Also verify trailing-slash override is normalised (the helper strips
  // trailing `/` so the template doesn't emit double slashes).
  process.env.FLOOM_PUBLIC_ORIGIN = 'https://floom.dev/';
  const slashModule = await import(
    `../../apps/server/dist/routes/mcp.js?slash=${Date.now()}`
  );
  const slashRes = await slashModule.mcpRouter.fetch(
    new Request('https://whatever.example.com/', {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'ingest_app',
          arguments: {
            openapi_url: specUrl,
            slug: 'base-url-trailing',
            name: 'Base URL Trailing',
          },
        },
      }),
    }),
  );
  const slashText = await slashRes.text();
  const slashJson = (() => {
    try {
      return JSON.parse(slashText);
    } catch {
      return null;
    }
  })();
  const slashPayload = (() => {
    const raw = slashJson?.result?.content?.[0]?.text;
    if (typeof raw !== 'string') return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  })();
  log(
    'trailing-slash override is normalised (no // in permalink)',
    typeof slashPayload?.permalink === 'string' &&
      !slashPayload.permalink.includes('//p/') &&
      slashPayload.permalink === 'https://floom.dev/p/base-url-trailing',
    slashPayload?.permalink,
  );
} finally {
  delete process.env.FLOOM_PUBLIC_ORIGIN;
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

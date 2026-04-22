#!/usr/bin/env node
// Regression for loopback OpenAPI URLs after the SSRF hardening:
//
// 1. Public/user-controlled detectAppFromUrl must still reject localhost.
// 2. Trusted operator-controlled apps.yaml ingest must accept the same
//    localhost spec so local sidecars/examples can register on boot.

import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'floom-openapi-loopback-'));
process.env.DATA_DIR = tmp;
process.env.FLOOM_DISABLE_JOB_WORKER = 'true';
process.env.FLOOM_FAST_APPS = 'false';

const {
  detectAppFromUrl,
  ingestOpenApiApps,
} = await import('../../apps/server/dist/services/openapi-ingest.js');
const { db } = await import('../../apps/server/dist/db.js');

let passed = 0;
let failed = 0;

function log(label, ok, detail) {
  if (ok) {
    passed++;
    console.log(`  ok    ${label}`);
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

const upstream = createServer((req, res) => {
  if (req.url === '/openapi.json') {
    const port = upstream.address()?.port || 0;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        openapi: '3.0.0',
        info: { title: 'Loopback Fixture', version: '1.0.0' },
        servers: [{ url: `http://localhost:${port}` }],
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

console.log('OpenAPI loopback trust boundary');

try {
  const port = await listen(upstream);
  const specUrl = `http://localhost:${port}/openapi.json`;

  let detectErr = null;
  try {
    await detectAppFromUrl(specUrl, 'loopback-detect', 'Loopback Detect');
  } catch (err) {
    detectErr = err;
  }
  log(
    'detectAppFromUrl rejects localhost spec URLs',
    detectErr instanceof Error &&
      detectErr.message.includes('Invalid or disallowed OpenAPI URL'),
    detectErr instanceof Error ? detectErr.message : String(detectErr),
  );

  const fixturePath = join(tmp, 'apps.yaml');
  writeFileSync(
    fixturePath,
    `apps:
  - slug: loopback-fixture
    type: proxied
    openapi_spec_url: "http://localhost:${port}/openapi.json"
    display_name: "Loopback Fixture"
    description: "Trusted localhost ingest fixture"
`,
  );

  const ingest = await ingestOpenApiApps(fixturePath);
  log(
    'ingestOpenApiApps allows localhost specs from trusted apps.yaml',
    ingest.apps_ingested === 1 && ingest.apps_failed === 0,
    JSON.stringify(ingest),
  );

  const row = db
    .prepare(
      'SELECT slug, base_url, openapi_spec_url, openapi_spec_cached FROM apps WHERE slug = ?',
    )
    .get('loopback-fixture');
  log('trusted ingest inserts the app row', row?.slug === 'loopback-fixture');
  log(
    'trusted ingest preserves openapi_spec_url',
    row?.openapi_spec_url === specUrl,
    row?.openapi_spec_url,
  );
  log(
    'trusted ingest resolves localhost base_url from spec.servers[]',
    row?.base_url === `http://localhost:${port}`,
    row?.base_url,
  );
  log(
    'trusted ingest caches the fetched spec',
    typeof row?.openapi_spec_cached === 'string' &&
      row.openapi_spec_cached.includes('"Loopback Fixture"'),
    row?.openapi_spec_cached?.slice(0, 80),
  );
} finally {
  await new Promise((resolve) => upstream.close(resolve));
  db.close();
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

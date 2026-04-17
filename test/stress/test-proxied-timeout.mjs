#!/usr/bin/env node
// Verifies proxied runs use the app-configured timeout_ms instead of a fixed 30s.
//
// Run: node test/stress/test-proxied-timeout.mjs

import { createServer } from 'node:http';
import { runProxied } from '../../apps/server/dist/services/proxied-runner.js';

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

function makeSpec(port) {
  return {
    openapi: '3.0.0',
    info: { title: 'Timeout Probe', version: '0.1.0' },
    servers: [{ url: `http://127.0.0.1:${port}` }],
    paths: {
      '/probe': {
        post: {
          operationId: 'probe',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { message: { type: 'string' } },
                },
              },
            },
          },
          responses: {
            200: {
              description: 'ok',
              content: { 'application/json': { schema: { type: 'object' } } },
            },
          },
        },
      },
    },
  };
}

function makeManifest() {
  return {
    name: 'Timeout Probe',
    description: 'test manifest',
    actions: {
      probe: {
        description: 'probe',
        inputSchema: {
          type: 'object',
          properties: { message: { type: 'string' } },
        },
      },
    },
  };
}

const server = createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/probe') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
const port = typeof address === 'object' && address ? address.port : 0;

const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
const captured = [];
AbortSignal.timeout = (ms) => {
  captured.push(ms);
  return originalTimeout(5_000);
};

try {
  const manifest = makeManifest();
  const spec = JSON.stringify(makeSpec(port));

  const resultLong = await runProxied({
    app: {
      slug: 'timeout-probe',
      base_url: `http://127.0.0.1:${port}`,
      auth_type: null,
      auth_config: null,
      openapi_spec_cached: spec,
      timeout_ms: 65_000,
    },
    manifest,
    action: 'probe',
    inputs: { message: 'hello' },
    secrets: {},
  });
  log(
    'configured timeout_ms propagates into fetch timeout',
    captured[0] === 65_000 && resultLong.status === 'success',
    `captured=${captured[0]} result=${JSON.stringify(resultLong)}`,
  );

  const resultDefault = await runProxied({
    app: {
      slug: 'timeout-probe-default',
      base_url: `http://127.0.0.1:${port}`,
      auth_type: null,
      auth_config: null,
      openapi_spec_cached: spec,
      timeout_ms: null,
    },
    manifest,
    action: 'probe',
    inputs: { message: 'hello' },
    secrets: {},
  });
  log(
    'default proxied timeout remains 30 seconds when timeout_ms is absent',
    captured[1] === 30_000 && resultDefault.status === 'success',
    `captured=${captured[1]} result=${JSON.stringify(resultDefault)}`,
  );

  const resultFloor = await runProxied({
    app: {
      slug: 'timeout-probe-floor',
      base_url: `http://127.0.0.1:${port}`,
      auth_type: null,
      auth_config: null,
      openapi_spec_cached: spec,
      timeout_ms: 10_000,
    },
    manifest,
    action: 'probe',
    inputs: { message: 'hello' },
    secrets: {},
  });
  log(
    'shorter timeout_ms values clamp to the 30 second floor',
    captured[2] === 30_000 && resultFloor.status === 'success',
    `captured=${captured[2]} result=${JSON.stringify(resultFloor)}`,
  );
} finally {
  AbortSignal.timeout = originalTimeout;
  server.close();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

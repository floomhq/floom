#!/usr/bin/env node
// W2.3 integration tests. Exercises the end-to-end connection flow with
// both the service layer and a simulated Composio HTTP server. These
// tests stand up a local http server that mimics the three Composio
// REST endpoints Floom cares about, plug it into the SDK via a direct
// fake (faster than forcing the real `@composio/core` client through
// a local URL), and validate the full flow works.
//
// Scenarios:
//   1. Full ramp: initiate → user visits auth_url → finish → listed → execute.
//   2. Circuit-breaker: repeated upstream 503 returns bubble up cleanly
//      as ComposioClientError, not crashes.
//   3. Token expiry: Composio flips to EXPIRED, our finishConnection
//      surfaces it, the stored status is `expired`, and execute fails
//      with ConnectionNotFoundError (no active connection).
//
// Run: node test/stress/test-w23-integration.mjs

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';

const tmp = mkdtempSync(join(tmpdir(), 'floom-w23-int-'));
process.env.DATA_DIR = tmp;
process.env.FLOOM_DISABLE_JOB_WORKER = 'true';
process.env.FLOOM_MASTER_KEY =
  '0'.repeat(16) + '1'.repeat(16) + '2'.repeat(16) + '3'.repeat(16);
process.env.COMPOSIO_AUTH_CONFIG_GMAIL = 'ac_gmail_int';
process.env.COMPOSIO_AUTH_CONFIG_SLACK = 'ac_slack_int';

const { db, DEFAULT_WORKSPACE_ID, DEFAULT_USER_ID } = await import(
  '../../apps/server/dist/db.js'
);
const composio = await import('../../apps/server/dist/services/composio.js');

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

console.log('W2.3 integration tests');

// ---- stand up a local http server that talks like Composio ----
// This isn't actually wired into the real @composio/core SDK; the tests
// still pass through a fake client wrapper for deterministic behavior.
// But we DO send every request through the real Node http layer so
// timing + JSON serialization + error shape is realistic.
const httpState = {
  hits: [],
  nextStatus: 200,
  nextBody: null,
  accounts: new Map(),
  nextId: 1000,
};

const server = createServer((req, res) => {
  httpState.hits.push({ method: req.method, url: req.url });
  let body = '';
  req.on('data', (c) => {
    body += c;
  });
  req.on('end', () => {
    // Caller can force the next response to be a specific status/body.
    if (httpState.nextStatus !== 200) {
      res.writeHead(httpState.nextStatus, { 'content-type': 'application/json' });
      res.end(JSON.stringify(httpState.nextBody || { error: 'forced' }));
      httpState.nextStatus = 200;
      httpState.nextBody = null;
      return;
    }

    const url = new URL(req.url, 'http://localhost');
    // POST /api/v3/connected_accounts → initiate
    if (req.method === 'POST' && url.pathname.endsWith('/connected_accounts')) {
      const id = `conn_int_${httpState.nextId++}`;
      const parsed = body ? JSON.parse(body) : {};
      httpState.accounts.set(id, {
        id,
        status: 'INITIATED',
        user_id: parsed.user_id,
        toolkit_slug: parsed.auth_config_id?.replace('ac_', '').replace('_int', ''),
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id,
          status: 'INITIATED',
          redirect_url: `https://composio.dev/oauth/${id}`,
        }),
      );
      return;
    }
    // GET /api/v3/connected_accounts/:id → retrieve
    if (req.method === 'GET' && /\/connected_accounts\/conn_int_/.test(url.pathname)) {
      const id = url.pathname.split('/').pop();
      const acc = httpState.accounts.get(id);
      if (!acc) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
        return;
      }
      // Progress INITIATED → ACTIVE on first poll
      if (acc.status === 'INITIATED') acc.status = 'ACTIVE';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: acc.id,
          status: acc.status,
          toolkit: { slug: acc.toolkit_slug },
          data: { email: `${acc.user_id.replace(/[^a-z0-9]/gi, '')}@integration.test` },
        }),
      );
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not handled' }));
  });
});

await new Promise((resolve) => server.listen(0, resolve));
const address = server.address();
const baseUrl = `http://127.0.0.1:${address.port}`;

// ---- adapter: translate our ComposioClient interface to HTTP calls ----
const httpClient = {
  connectedAccounts: {
    async initiate(userId, authConfigId, options) {
      const res = await fetch(`${baseUrl}/api/v3/connected_accounts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          user_id: userId,
          auth_config_id: authConfigId,
          callback_url: options?.callbackUrl,
        }),
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      }
      const body = await res.json();
      return {
        id: body.id,
        status: body.status,
        redirectUrl: body.redirect_url,
      };
    },
    async get(id) {
      const res = await fetch(`${baseUrl}/api/v3/connected_accounts/${id}`);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      }
      const body = await res.json();
      return {
        id: body.id,
        status: body.status,
        toolkit: body.toolkit,
        data: body.data,
      };
    },
    async delete(id) {
      // Delete endpoint isn't needed for these integration tests beyond
      // simulating a delete call; we just return success.
      return { success: true, id };
    },
  },
  tools: {
    async execute(slug, body) {
      return {
        data: { echoed: body.arguments, as: body.userId },
        successful: true,
      };
    },
  },
};
composio.setComposioClient(httpClient);

// ========================================
// Scenario 1: Full ramp
// ========================================
const ctx = {
  workspace_id: DEFAULT_WORKSPACE_ID,
  user_id: DEFAULT_USER_ID,
  device_id: 'dev-int-1',
  is_authenticated: false,
};

const init = await composio.initiateConnection(
  ctx,
  'gmail',
  'https://floom.dev/callback',
);
log('integration: initiate returns auth_url', !!init.auth_url);
log('integration: initiate went through HTTP', httpState.hits.length >= 1);
log(
  'integration: HTTP POST hit /connected_accounts',
  httpState.hits.some(
    (h) => h.method === 'POST' && h.url.includes('/connected_accounts'),
  ),
);

const finished = await composio.finishConnection(ctx, init.connection_id);
log('integration: finish → active', finished.status === 'active');
log(
  'integration: finish went through HTTP (GET)',
  httpState.hits.some(
    (h) => h.method === 'GET' && h.url.includes('/connected_accounts/'),
  ),
);
log(
  'integration: metadata has account_email from HTTP body',
  finished.metadata_json && /integration\.test/.test(finished.metadata_json),
);

const list = await composio.listConnections(ctx);
log('integration: list shows 1 active', list.length === 1 && list[0].status === 'active');

const exec = await composio.executeAction(ctx, 'gmail', 'GMAIL_SEND_EMAIL', {
  to: 'x@y.z',
});
log('integration: execute successful', exec.successful === true);
log(
  'integration: execute forwarded userId from composio_account_id',
  exec.data?.as === 'device:dev-int-1',
);

// ========================================
// Scenario 2: circuit-breaker / upstream 503
// ========================================
httpState.nextStatus = 503;
httpState.nextBody = { error: 'upstream temporarily unavailable' };

const ctx2 = { ...ctx, device_id: 'dev-int-2' };
let circuitErr = null;
try {
  await composio.initiateConnection(ctx2, 'slack');
} catch (err) {
  circuitErr = err;
}
log('integration: 503 bubbles up as ComposioClientError', circuitErr?.name === 'ComposioClientError');
log(
  'integration: 503 error preserves upstream message',
  circuitErr && /503|upstream/.test(circuitErr.message),
);
// Verify we did NOT persist a row when the upstream failed
const ctx2Row = db
  .prepare(
    `SELECT * FROM connections WHERE owner_id = ? AND provider = ?`,
  )
  .get('dev-int-2', 'slack');
log('integration: no DB row created when upstream fails', !ctx2Row);

// ========================================
// Scenario 3: token expiry
// ========================================
const ctx3 = { ...ctx, device_id: 'dev-int-3' };
const init3 = await composio.initiateConnection(ctx3, 'gmail');
// Force the account to EXPIRED server-side
const acc = httpState.accounts.get(init3.connection_id);
acc.status = 'EXPIRED';
const finished3 = await composio.finishConnection(ctx3, init3.connection_id);
log('integration: EXPIRED upstream → local status=expired', finished3.status === 'expired');

// executeAction requires active → should fail with ConnectionNotFoundError
let expiredErr = null;
try {
  await composio.executeAction(ctx3, 'gmail', 'GMAIL_SEND_EMAIL', {});
} catch (err) {
  expiredErr = err;
}
log(
  'integration: execute on expired conn → ConnectionNotFoundError',
  expiredErr?.name === 'ConnectionNotFoundError',
);

// ---- cleanup ----
await new Promise((resolve) => server.close(resolve));
db.close();
rmSync(tmp, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

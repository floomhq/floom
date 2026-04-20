#!/usr/bin/env node
// Regression for docs/product-audit/deep/pd-05-three-surface-parity.md:
// the MCP sync tool handler must forward the caller's SessionContext to
// dispatchRun so per-user vault secrets reach the runner, matching the
// HTTP /api/run + /api/:slug/run behaviour. Before this fix the sync
// branch omitted the ctx argument and every authenticated MCP call
// silently fell back to defaultContext() inside runner.ts.
//
// Run: node --experimental-test-module-mocks \
//        test/stress/test-mcp-session-context.mjs

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'floom-mcp-session-ctx-'));
process.env.DATA_DIR = tmp;
process.env.FLOOM_DISABLE_JOB_WORKER = 'true';
process.env.PUBLIC_URL = 'http://localhost';

const realRunner = await import('../../apps/server/dist/services/runner.js');

// Record every dispatchRun call and synthesise a success row on the runs
// table so mcp.ts's waitForRun loop resolves promptly. We defer to the
// real getRun for everything the test didn't stub.
const dispatchCalls = [];
let stubbedRunId = null;
let stubbedStatus = 'success';

mock.module('../../apps/server/dist/services/runner.js', {
  namedExports: {
    ...realRunner,
    dispatchRun: (app, manifest, runId, action, inputs, perCallSecrets, ctx) => {
      dispatchCalls.push({ app, manifest, runId, action, inputs, perCallSecrets, ctx });
      stubbedRunId = runId;
    },
    getRun: (id) => {
      if (id === stubbedRunId) {
        return {
          id,
          app_id: 'app_mcp_session_ctx',
          action: 'run',
          inputs: '{}',
          outputs: JSON.stringify({ ok: true }),
          logs: '',
          status: stubbedStatus,
          error: null,
          error_type: null,
          duration_ms: 1,
          started_at: new Date().toISOString(),
          finished_at: new Date().toISOString(),
        };
      }
      return realRunner.getRun(id);
    },
  },
});

const { db, DEFAULT_USER_ID, DEFAULT_WORKSPACE_ID } = await import(
  '../../apps/server/dist/db.js'
);
const { mcpRouter } = await import('../../apps/server/dist/routes/mcp.js');

const manifest = {
  schema_version: '1',
  name: 'MCP Session Context Fixture',
  description: 'Fixture for session-context wiring test',
  secrets_needed: [],
  actions: {
    run: {
      label: 'Run',
      description: 'Smoke action',
      inputs: [],
      secrets_needed: [],
    },
  },
};

db.prepare(
  `INSERT INTO apps
     (id, slug, name, description, manifest, status, docker_image,
      code_path, category, author, icon, app_type, base_url,
      auth_type, visibility)
   VALUES (?, ?, ?, ?, ?, 'active', NULL, '', 'qa', 'local', 'tool',
      'proxied', 'http://127.0.0.1:1', 'none', 'public')`,
).run(
  'app_mcp_session_ctx',
  'mcp-session-ctx',
  'MCP Session Context Fixture',
  'Fixture for session-context wiring test',
  JSON.stringify(manifest),
);

async function callTool(extraHeaders = {}) {
  dispatchCalls.length = 0;
  stubbedRunId = null;
  const res = await mcpRouter.fetch(
    new Request('http://localhost/app/mcp-session-ctx', {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        ...extraHeaders,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'mcp_session_ctx', arguments: {} },
      }),
    }),
  );
  return { status: res.status, text: await res.text() };
}

test('MCP sync tool dispatches dispatchRun with a SessionContext', async () => {
  const { status } = await callTool({ cookie: 'floom_device=device-abc-123' });
  assert.equal(status, 200);
  assert.equal(dispatchCalls.length, 1, 'dispatchRun invoked exactly once');
  const { ctx } = dispatchCalls[0];
  assert.ok(ctx, 'dispatchRun received a SessionContext');
  assert.equal(
    typeof ctx.workspace_id,
    'string',
    'ctx carries a workspace_id',
  );
  assert.equal(typeof ctx.user_id, 'string', 'ctx carries a user_id');
  // OSS / anonymous: resolveUserContext returns the synthetic local
  // workspace + user, but critically threads the real device cookie
  // through so the runner can scope per-device state. Before the fix
  // ctx was undefined and the runner fell back to defaultContext().
  assert.equal(ctx.workspace_id, DEFAULT_WORKSPACE_ID);
  assert.equal(ctx.user_id, DEFAULT_USER_ID);
  assert.equal(
    ctx.device_id,
    'device-abc-123',
    'cookie device_id threaded into ctx',
  );
  assert.equal(ctx.is_authenticated, false);
});

test('MCP sync tool with no auth still passes an anon SessionContext', async () => {
  const { status } = await callTool();
  assert.equal(status, 200);
  assert.equal(dispatchCalls.length, 1);
  const { ctx } = dispatchCalls[0];
  assert.ok(ctx, 'dispatchRun still receives a (default/anon) ctx');
  assert.equal(ctx.workspace_id, DEFAULT_WORKSPACE_ID);
  assert.equal(ctx.user_id, DEFAULT_USER_ID);
  assert.equal(ctx.is_authenticated, false);
  // No cookie on the request → resolveUserContext mints a fresh one
  // and threads it back on the response. The ctx should carry that
  // new id, not the DEFAULT_USER_ID sentinel that defaultContext()
  // would surface.
  assert.ok(
    typeof ctx.device_id === 'string' && ctx.device_id.length > 0,
    'ctx.device_id is a non-empty minted id',
  );
  assert.notEqual(
    ctx.device_id,
    DEFAULT_USER_ID,
    'minted device_id is distinct from the DEFAULT_USER_ID fallback',
  );
});

test.after(() => {
  try {
    db?.close();
  } catch {
    // ignore
  }
  rmSync(tmp, { recursive: true, force: true });
});

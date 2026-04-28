#!/usr/bin/env node
// Layer 5 Round 1: agent token list/revoke are workspace-scoped.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'floom-agent-tokens-workspace-'));
process.env.DATA_DIR = tmp;
process.env.FLOOM_DISABLE_JOB_WORKER = 'true';
delete process.env.FLOOM_CLOUD_MODE;
delete process.env.FLOOM_AUTH_TOKEN;

const { db, DEFAULT_USER_ID, DEFAULT_WORKSPACE_ID } = await import('../../apps/server/dist/db.js');
const { agentKeysRouter } = await import('../../apps/server/dist/routes/agent_keys.js');
const { workspacesRouter } = await import('../../apps/server/dist/routes/workspaces.js');
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

async function fetchRoute(router, method, path, body) {
  const headers = new Headers();
  let requestBody;
  if (body !== undefined) {
    headers.set('content-type', 'application/json');
    requestBody = JSON.stringify(body);
  }
  const res = await router.fetch(
    new Request(`http://localhost${path}`, { method, headers, body: requestBody }),
  );
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}
  return { status: res.status, json, text };
}

console.log('Layer 5 agent token workspace tests');

db.prepare(
  `INSERT INTO workspaces (id, slug, name, plan) VALUES ('ws_layer5_tokens', 'layer5-tokens', 'Layer 5 Tokens', 'oss')`,
).run();
db.prepare(
  `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ('ws_layer5_tokens', ?, 'admin')`,
).run(DEFAULT_USER_ID);
db.prepare(
  `INSERT INTO users (id, workspace_id, auth_provider) VALUES ('other_issuer', ?, 'test')`,
).run(DEFAULT_WORKSPACE_ID);

const otherIssuerRaw = agentTokens.generateAgentToken();
db.prepare(
  `INSERT INTO agent_tokens
     (id, prefix, hash, label, scope, workspace_id, user_id, created_at,
      last_used_at, revoked_at, rate_limit_per_minute)
   VALUES ('agtok_other_issuer', ?, ?, 'other issuer', 'read', ?, 'other_issuer',
      ?, NULL, NULL, 60)`,
).run(
  agentTokens.extractAgentTokenPrefix(otherIssuerRaw),
  agentTokens.hashAgentToken(otherIssuerRaw),
  DEFAULT_WORKSPACE_ID,
  new Date().toISOString(),
);

let res = await fetchRoute(agentKeysRouter, 'POST', '/', {
  label: 'local token',
  scope: 'read-write',
});
const localTokenId = res.json?.id;
log('active workspace mint returns 201', res.status === 201, res.text);
log('active workspace mint targets local workspace', res.json?.workspace_id === DEFAULT_WORKSPACE_ID);

res = await fetchRoute(workspacesRouter, 'POST', '/ws_layer5_tokens/agent-tokens', {
  label: 'other workspace token',
  scope: 'read',
});
const otherWorkspaceTokenId = res.json?.id;
log('path-explicit workspace mint returns 201', res.status === 201, res.text);
log('path-explicit mint targets requested workspace', res.json?.workspace_id === 'ws_layer5_tokens');
log('mint response uses issued_by_user_id metadata', res.json?.issued_by_user_id === DEFAULT_USER_ID);

res = await fetchRoute(agentKeysRouter, 'GET', '/');
const activeIds = new Set((res.json || []).map((token) => token.id));
log('active list returns 200', res.status === 200, res.text);
log('active list includes same-workspace token from current issuer', activeIds.has(localTokenId));
log('active list includes same-workspace token from different issuer', activeIds.has('agtok_other_issuer'));
log('active list excludes other workspace token', !activeIds.has(otherWorkspaceTokenId));

res = await fetchRoute(workspacesRouter, 'GET', '/ws_layer5_tokens/agent-tokens');
const explicitIds = new Set((res.json || []).map((token) => token.id));
log('path-explicit list returns 200', res.status === 200, res.text);
log('path-explicit list includes only requested workspace token', explicitIds.has(otherWorkspaceTokenId) && !explicitIds.has(localTokenId));

res = await fetchRoute(agentKeysRouter, 'POST', `/${otherWorkspaceTokenId}/revoke`);
const afterWrongRevoke = db
  .prepare('SELECT revoked_at FROM agent_tokens WHERE id = ?')
  .get(otherWorkspaceTokenId);
log('active-workspace revoke does not revoke other workspace token', afterWrongRevoke?.revoked_at === null);

res = await fetchRoute(
  workspacesRouter,
  'POST',
  `/ws_layer5_tokens/agent-tokens/${otherWorkspaceTokenId}/revoke`,
);
const afterExplicitRevoke = db
  .prepare('SELECT revoked_at FROM agent_tokens WHERE id = ?')
  .get(otherWorkspaceTokenId);
log('path-explicit revoke returns 204', res.status === 204, res.text);
log('path-explicit revoke sets revoked_at', typeof afterExplicitRevoke?.revoked_at === 'string');

db.close();
rmSync(tmp, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

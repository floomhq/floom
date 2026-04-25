#!/usr/bin/env node
// Agents-native phase 2A backend:
// token hashing/prefix/scope helpers, mint/list/revoke API, bearer auth
// context, revocation, and per-token rate limits.
//
// Run after server build: node test/stress/test-agent-tokens.mjs

import { spawn } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const tmp = mkdtempSync(join(tmpdir(), 'floom-agent-tokens-'));
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
const session = await import('../../apps/server/dist/services/session.js');

let passed = 0;
let failed = 0;
function log(label, ok, detail) {
  if (ok) {
    passed++;
    console.log(`  ok  ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${detail ? ` :: ${detail}` : ''}`);
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
      server.close((err) => {
        if (err) reject(err);
        else resolve(address.port);
      });
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
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`timed out waiting for ${url}: ${lastErr?.message || 'no response'}`);
}

async function bootServer() {
  const port = await getFreePort();
  const env = {
    ...process.env,
    PORT: String(port),
    PUBLIC_URL: `http://localhost:${port}`,
    DATA_DIR: dataDir,
    FLOOM_DISABLE_JOB_WORKER: 'true',
    FLOOM_DISABLE_TRIGGERS_WORKER: 'true',
    FLOOM_DISABLE_ZOMBIE_SWEEPER: 'true',
    FLOOM_SEED_APPS: 'false',
    FLOOM_SEED_LAUNCH_DEMOS: 'false',
    FLOOM_FAST_APPS: 'false',
    FLOOM_RATE_LIMIT_USER_PER_HOUR: '1000',
    FLOOM_RATE_LIMIT_IP_PER_HOUR: '1000',
  };
  delete env.FLOOM_CLOUD_MODE;
  delete env.FLOOM_AUTH_TOKEN;
  delete env.FLOOM_RATE_LIMIT_DISABLED;
  const proc = spawn('node', [join(REPO_ROOT, 'apps/server/dist/index.js')], {
    env,
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
    try {
      proc.kill('SIGTERM');
    } catch {}
    throw new Error(`${err.message}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }
  return { port, proc };
}

async function stopServer(server) {
  try {
    server.proc.kill('SIGTERM');
  } catch {}
  await new Promise((resolve) => setTimeout(resolve, 150));
}

async function jsonFetch(port, path, { method = 'GET', token, body, cookie } = {}) {
  const headers = new Headers();
  if (body !== undefined) headers.set('content-type', 'application/json');
  if (token) headers.set('authorization', `Bearer ${token}`);
  if (cookie) headers.set('cookie', cookie);
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

console.log('Agent token helpers');

const generated = agentTokens.generateAgentToken();
log(
  'generated token uses floom_agent_<32 base62 chars>',
  /^floom_agent_[0-9A-Za-z]{32}$/.test(generated),
  generated,
);
log(
  'hashAgentToken returns sha256 hex',
  /^[0-9a-f]{64}$/.test(agentTokens.hashAgentToken(generated)),
);
log(
  'hashAgentToken is deterministic',
  agentTokens.hashAgentToken(generated) === agentTokens.hashAgentToken(generated),
);
log(
  'extractAgentTokenPrefix returns prefix plus first 8 random chars',
  agentTokens.extractAgentTokenPrefix('floom_agent_AbCd1234ZZZZZZZZZZZZZZZZZZZZZZZZ') ===
    'floom_agent_AbCd1234',
);
log('scope read is valid', agentTokens.isValidAgentTokenScope('read') === true);
log('scope read-write is valid', agentTokens.isValidAgentTokenScope('read-write') === true);
log('scope publish-only is valid', agentTokens.isValidAgentTokenScope('publish-only') === true);
log('fine-grained scope is rejected', agentTokens.isValidAgentTokenScope('admin') === false);

console.log('\nAgent token API and middleware');

const server = await bootServer();
try {
  const minted = await jsonFetch(server.port, '/api/me/agent-keys', {
    method: 'POST',
    body: { label: 'local-dev', scope: 'read-write' },
  });
  log('mint returns 201', minted.res.status === 201, minted.text);
  const rawToken = minted.json?.raw_token;
  const tokenId = minted.json?.id;
  log('mint response includes agtok id', /^agtok_/.test(tokenId || ''), tokenId);
  log('mint response includes display prefix', minted.json?.prefix === agentTokens.extractAgentTokenPrefix(rawToken));
  log('mint response includes requested label', minted.json?.label === 'local-dev');
  log('mint response includes requested scope', minted.json?.scope === 'read-write');
  log('mint response defaults workspace to local', minted.json?.workspace_id === 'local');
  log('raw_token is only in create response shape', /^floom_agent_[0-9A-Za-z]{32}$/.test(rawToken || ''));

  const row = db.prepare('SELECT * FROM agent_tokens WHERE id = ?').get(tokenId);
  log('database persisted row for minted token', !!row);
  log('database stores hash matching raw token', row?.hash === agentTokens.hashAgentToken(rawToken));
  log('database does not store raw token', !JSON.stringify(row).includes(rawToken));
  log('database stores prefix only', row?.prefix === minted.json?.prefix);

  const listed = await jsonFetch(server.port, '/api/me/agent-keys');
  log('list returns 200', listed.res.status === 200, listed.text);
  const listedToken = Array.isArray(listed.json)
    ? listed.json.find((t) => t.id === tokenId)
    : null;
  log('list includes minted token', !!listedToken);
  log('list masks raw token', listedToken && !('raw_token' in listedToken));
  log('list never returns hash', listedToken && !('hash' in listedToken));
  log('list omits rate-limit internals', listedToken && !('rate_limit_per_minute' in listedToken));
  log('list marks token active', listedToken?.revoked === false);

  const authed = await jsonFetch(server.port, '/api/session/me', { token: rawToken });
  log('bearer token authenticates a request', authed.res.status === 200, authed.text);
  const usedRow = db.prepare('SELECT last_used_at FROM agent_tokens WHERE id = ?').get(tokenId);
  log('bearer use updates last_used_at', typeof usedRow?.last_used_at === 'string');

  const publishMint = await jsonFetch(server.port, '/api/me/agent-keys', {
    method: 'POST',
    body: { label: 'publish-only-test', scope: 'publish-only', rate_limit_per_minute: 1000 },
  });
  const publishToken = publishMint.json?.raw_token;
  const probeHeaders = new Headers({ authorization: `Bearer ${publishToken}` });
  const probeCtx = {
    req: {
      header: (name) => probeHeaders.get(name.toLowerCase()) || probeHeaders.get(name) || null,
      raw: { headers: probeHeaders },
    },
    header: () => undefined,
    json: (body, status) =>
      new Response(JSON.stringify(body), {
        status: status || 200,
        headers: { 'content-type': 'application/json' },
      }),
  };
  await agentTokens.agentTokenAuthMiddleware(probeCtx, async () => undefined);
  const probeJson = await session.resolveUserContext(probeCtx);
  log('agent context is authenticated', probeJson.is_authenticated === true);
  log('agent context carries publish-only scope', probeJson.agent_token_scope === 'publish-only');
  log('agent context carries token id', probeJson.agent_token_id === publishMint.json?.id);
  log('agent context carries workspace id', probeJson.workspace_id === 'local');

  let rateLimited = null;
  for (let i = 0; i < 61; i++) {
    rateLimited = await jsonFetch(server.port, '/api/run', {
      method: 'POST',
      token: rawToken,
      body: { app_slug: 'missing-agent-token-rate-limit' },
    });
  }
  log('61st token request returns 429', rateLimited?.res.status === 429, rateLimited?.text);
  log('429 has Retry-After', Number(rateLimited?.res.headers.get('retry-after')) > 0);
  log(
    '429 rate-limit scope is agent_token',
    rateLimited?.res.headers.get('x-ratelimit-scope') === 'agent_token' &&
      rateLimited?.json?.scope === 'agent_token',
    rateLimited?.text,
  );

  const cookieSession = await jsonFetch(server.port, '/api/session/me', {
    cookie: 'floom_device=agent-token-regression-device',
  });
  log('existing device-cookie session path still returns 200', cookieSession.res.status === 200);
  log(
    'existing device-cookie session path remains local user',
    cookieSession.json?.user?.id === 'local',
    cookieSession.text,
  );

  const revoked = await jsonFetch(server.port, `/api/me/agent-keys/${tokenId}/revoke`, {
    method: 'POST',
  });
  log('revoke returns 204', revoked.res.status === 204, revoked.text);
  const revokedRow = db.prepare('SELECT revoked_at FROM agent_tokens WHERE id = ?').get(tokenId);
  log('revoke sets revoked_at', typeof revokedRow?.revoked_at === 'string');
  const afterRevoke = await jsonFetch(server.port, '/api/session/me', { token: rawToken });
  log('revoked token returns 401', afterRevoke.res.status === 401, afterRevoke.text);
  log('revoked token error is invalid_agent_token', afterRevoke.json?.error === 'invalid_agent_token');

  const invalid = await jsonFetch(server.port, '/api/session/me', {
    token: 'floom_agent_00000000000000000000000000000000',
  });
  log('unknown token returns 401', invalid.res.status === 401, invalid.text);
  log('unknown token error is invalid_agent_token', invalid.json?.error === 'invalid_agent_token');
} finally {
  await stopServer(server);
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

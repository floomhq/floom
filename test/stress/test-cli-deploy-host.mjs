#!/usr/bin/env node
// CLI deploy regression: host-aware auth + publish output.
//
// Verifies that `floom auth login --api-url <origin>` and `floom deploy`
// publish through that origin and print URLs for that same origin, not the
// hardcoded floom.dev fallback.

import http from 'node:http';
import { spawn } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const tmp = mkdtempSync(join(tmpdir(), 'floom-cli-deploy-host-'));
const dataDir = join(tmp, 'data');
const homeDir = join(tmp, 'home');
const projectDir = join(tmp, 'project');
mkdirSync(dataDir, { recursive: true });
mkdirSync(homeDir, { recursive: true });
mkdirSync(projectDir, { recursive: true });

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

async function listen(server) {
  return await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
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

async function runCmd(cmd, args, opts = {}) {
  return await new Promise((resolve) => {
    const proc = spawn(cmd, args, {
      cwd: opts.cwd || REPO_ROOT,
      env: opts.env || process.env,
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
    proc.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function createToken() {
  const raw = agentTokens.generateAgentToken();
  db.prepare(
    `INSERT INTO agent_tokens
       (id, prefix, hash, label, scope, workspace_id, user_id, created_at,
        last_used_at, revoked_at, rate_limit_per_minute)
     VALUES ('agtok_cli_deploy_host', ?, ?, 'cli-deploy-host', 'read-write',
        'local', 'local', ?, NULL, NULL, 1000)`,
  ).run(
    agentTokens.extractAgentTokenPrefix(raw),
    agentTokens.hashAgentToken(raw),
    new Date().toISOString(),
  );
  db.pragma('wal_checkpoint(TRUNCATE)');
  return raw;
}

const upstream = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  if (url.pathname === '/openapi.json') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        openapi: '3.0.0',
        info: { title: 'CLI Host Publish', version: '1.0.0' },
        servers: [{ url: `http://127.0.0.1:${upstream.address().port}` }],
        paths: {
          '/echo': {
            get: {
              operationId: 'echo',
              parameters: [{ name: 'message', in: 'query', schema: { type: 'string' } }],
              responses: { 200: { description: 'ok' } },
            },
          },
        },
      }),
    );
    return;
  }
  if (url.pathname === '/echo') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, message: url.searchParams.get('message') }));
    return;
  }
  res.writeHead(404);
  res.end('not found');
});

console.log('CLI deploy host regression');

const upstreamPort = await listen(upstream);
const token = createToken();
const server = await bootServer();
const apiUrl = `http://localhost:${server.port}`;

try {
  writeFileSync(
    join(projectDir, 'floom.yaml'),
    [
      'name: CLI Host Publish',
      'slug: cli-host-publish',
      'description: Publish through a non-prod CLI host',
      'type: proxied',
      `openapi_spec_url: http://127.0.0.1:${upstreamPort}/openapi.json`,
      'visibility: private',
      'manifest_version: "2.0"',
      '',
    ].join('\n'),
  );

  const env = {
    ...process.env,
    HOME: homeDir,
    PATH: `${join(REPO_ROOT, 'cli/floom/bin')}:${process.env.PATH}`,
  };
  const auth = await runCmd('bash', [join(REPO_ROOT, 'cli/floom/bin/floom'), 'auth', 'login', `--token=${token}`, `--api-url=${apiUrl}`], { env });
  log('floom auth login accepts local api-url token', auth.code === 0 && auth.stdout.includes(`at ${apiUrl}`), `${auth.stdout}\n${auth.stderr}`);

  const logout = await runCmd('bash', [join(REPO_ROOT, 'cli/floom/bin/floom'), 'auth', 'logout'], { env });
  log('floom auth logout clears config', logout.code === 0, `${logout.stdout}\n${logout.stderr}`);

  const legacyAuth = await runCmd('bash', [join(REPO_ROOT, 'cli/floom/bin/floom'), 'auth', token, apiUrl], { env });
  log('floom auth <token> <api-url> validates token too', legacyAuth.code === 0 && legacyAuth.stdout.includes(`at ${apiUrl}`), `${legacyAuth.stdout}\n${legacyAuth.stderr}`);

  const deploy = await runCmd('bash', [join(REPO_ROOT, 'cli/floom/bin/floom'), 'deploy'], {
    cwd: projectDir,
    env,
  });
  log('floom deploy exits 0', deploy.code === 0, `${deploy.stdout}\n${deploy.stderr}`);
  log('floom deploy prints local app page URL', deploy.stdout.includes(`${apiUrl}/p/cli-host-publish`), deploy.stdout);
  log('floom deploy prints local MCP URL', deploy.stdout.includes(`${apiUrl}/mcp/app/cli-host-publish`), deploy.stdout);
  log('floom deploy output does not print hardcoded prod URL', !deploy.stdout.includes('https://floom.dev/p/cli-host-publish'), deploy.stdout);

  const row = db.prepare('SELECT * FROM apps WHERE slug = ?').get('cli-host-publish');
  log('floom deploy persisted app in token workspace', Boolean(row) && row.workspace_id === 'local' && row.author === 'local', JSON.stringify(row));
} finally {
  await stopServer(server);
  upstream.close();
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

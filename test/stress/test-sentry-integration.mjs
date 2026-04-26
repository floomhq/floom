#!/usr/bin/env node
// End-to-end Sentry integration contract:
//   1. Empty DSNs: server builds/starts, web builds, and startup consoles do
//      not contain errors.
//   2. Fake server DSN: init runs and prints the ready line.
//   3. PII scrubber: authorization/cookie/x-api-key headers are dropped.

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const SERVER_DIST = join(REPO_ROOT, 'apps/server/dist');
const WEB_DIST = join(REPO_ROOT, 'apps/web/dist');
const SERVER_SENTRY_SRC = join(REPO_ROOT, 'apps/server/src/lib/sentry.ts');

let passed = 0;
let failed = 0;

function log(label, ok, detail = '') {
  if (ok) {
    passed++;
    console.log(`  ok  ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${detail ? ' :: ' + detail : ''}`);
  }
}

function run(command, args, envOverrides = {}, timeout = 120_000) {
  const env = { ...process.env, ...envOverrides };
  delete env.SENTRY_AUTH_TOKEN;
  delete env.SENTRY_SERVER_DSN;
  delete env.VITE_SENTRY_WEB_DSN;
  if (Object.hasOwn(envOverrides, 'SENTRY_SERVER_DSN')) {
    env.SENTRY_SERVER_DSN = envOverrides.SENTRY_SERVER_DSN;
  }
  if (Object.hasOwn(envOverrides, 'VITE_SENTRY_WEB_DSN')) {
    env.VITE_SENTRY_WEB_DSN = envOverrides.VITE_SENTRY_WEB_DSN;
  }
  const result = spawnSync(command, args, {
    cwd: REPO_ROOT,
    env,
    encoding: 'utf8',
    timeout,
  });
  return result;
}

function hasConsoleError(output) {
  return /(^|\n)(?!.*\[sentry\] DSN not set)(?!.*\[sentry\] disabled).*error/i.test(output);
}

const emptyEnv = {
  SENTRY_SERVER_DSN: '',
  VITE_SENTRY_WEB_DSN: '',
  FLOOM_DISABLE_JOB_WORKER: 'true',
  FLOOM_FAST_APPS: 'false',
  FLOOM_SEED_LAUNCH_DEMOS: 'false',
  DISCORD_ALERTS_WEBHOOK_URL: '',
};

const serverBuild = run('pnpm', ['--filter', '@floom/server', 'build'], emptyEnv);
log('server build succeeds with empty SENTRY_SERVER_DSN', serverBuild.status === 0, serverBuild.stderr);

const webBuild = run('pnpm', ['--filter', '@floom/web', 'build'], emptyEnv, 180_000);
log('web bundle builds with empty VITE_SENTRY_WEB_DSN', webBuild.status === 0, webBuild.stderr);
log(
  'empty-DSN web build console has no errors',
  !hasConsoleError(webBuild.stderr),
  webBuild.stderr,
);

const tmpData = mkdtempSync(join(tmpdir(), 'floom-sentry-integration-'));
const port = String(38600 + Math.floor(Math.random() * 500));
const serverEnv = {
  ...process.env,
  ...emptyEnv,
  DATA_DIR: tmpData,
  PORT: port,
  PUBLIC_URL: `http://127.0.0.1:${port}`,
  NODE_ENV: 'test',
};
const server = spawn(process.execPath, ['index.js'], {
  cwd: SERVER_DIST,
  env: serverEnv,
  stdio: ['ignore', 'pipe', 'pipe'],
});

let serverStdout = '';
let serverStderr = '';
server.stdout.on('data', (chunk) => {
  serverStdout += chunk.toString();
});
server.stderr.on('data', (chunk) => {
  serverStderr += chunk.toString();
});

async function waitForHealth() {
  const url = `http://127.0.0.1:${port}/api/health`;
  for (let i = 0; i < 40; i++) {
    try {
      const response = await fetch(url);
      if (response.ok) return true;
    } catch {
      // keep polling until the server binds
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

const healthy = await waitForHealth();
server.kill('SIGTERM');
await new Promise((resolve) => server.once('exit', resolve));
rmSync(tmpData, { recursive: true, force: true });

log('server starts cleanly with empty SENTRY_SERVER_DSN', healthy, `${serverStdout}\n${serverStderr}`);
log(
  'empty-DSN server startup console has no errors',
  !hasConsoleError(`${serverStdout}\n${serverStderr}`),
  `${serverStdout}\n${serverStderr}`,
);
log(
  'server logs disabled Sentry once when DSN is empty',
  (serverStdout.match(/\[sentry\] DSN not set, error tracking disabled/g) || []).length === 1,
  serverStdout,
);

const fakeDsnEnv = {
  SENTRY_SERVER_DSN: 'https://public@example.com/1',
  SENTRY_ENVIRONMENT: 'preview',
  COMMIT_SHA: 'testsha',
};
const fakeDsn = run(
  process.execPath,
  [
    '--import',
    'tsx',
    '--eval',
    `import { initSentry } from ${JSON.stringify(SERVER_SENTRY_SRC)}; initSentry();`,
  ],
  fakeDsnEnv,
);
log('fake SENTRY_SERVER_DSN init exits cleanly', fakeDsn.status === 0, fakeDsn.stderr);
log(
  'fake SENTRY_SERVER_DSN emits ready log line',
  fakeDsn.stdout.includes('[sentry] ready service=floom-server env=preview commit=testsha'),
  fakeDsn.stdout,
);

const fakeWebBuild = run(
  'pnpm',
  ['--filter', '@floom/web', 'build'],
  { VITE_SENTRY_WEB_DSN: 'https://public@example.com/2' },
  180_000,
);
log('web bundle builds with fake VITE_SENTRY_WEB_DSN', fakeWebBuild.status === 0, fakeWebBuild.stderr);
const builtJs = readdirSync(join(WEB_DIST, 'assets'))
  .filter((file) => file.endsWith('.js'))
  .map((file) => readFileSync(join(WEB_DIST, 'assets', file), 'utf8'))
  .join('\n');
log(
  'fake VITE_SENTRY_WEB_DSN bundle contains web ready log',
  builtJs.includes('[sentry] ready service=') && builtJs.includes('floom-web'),
);

const { scrubSentryEvent } = await import(join(SERVER_DIST, 'lib/sentry.js'));
const event = scrubSentryEvent({
  request: {
    url: 'https://floom.dev/api/run?token=abc&safe=1',
    headers: {
      authorization: 'Bearer secret',
      Cookie: 'sid=secret',
      'x-api-key': 'key',
      accept: 'application/json',
    },
    data: { prompt: 'user input' },
    body: 'raw user body',
  },
});
const headers = event.request.headers;
log('scrubber drops authorization header', !Object.hasOwn(headers, 'authorization'));
log('scrubber drops cookie header', !Object.hasOwn(headers, 'Cookie'));
log('scrubber drops x-api-key header', !Object.hasOwn(headers, 'x-api-key'));
log('scrubber keeps safe headers', headers.accept === 'application/json');
log('scrubber drops request data body', !Object.hasOwn(event.request, 'data') && !Object.hasOwn(event.request, 'body'));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

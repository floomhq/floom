#!/usr/bin/env node
// ADR-015 GitHub push webhook tests.

import { createHmac } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'floom-gh-deploy-webhook-'));
const reposRoot = join(tmp, 'repos');
mkdirSync(reposRoot, { recursive: true });

process.env.DATA_DIR = join(tmp, 'data');
process.env.FLOOM_DISABLE_JOB_WORKER = 'true';
process.env.FLOOM_DISABLE_TRIGGERS_WORKER = 'true';
process.env.FLOOM_DISABLE_GITHUB_BUILD_WORKER = 'true';
process.env.FLOOM_GITHUB_DEPLOY_SKIP_DOCKER = 'true';
process.env.FLOOM_GITHUB_CLONE_URL_TEMPLATE = `${reposRoot}/{owner}/{repo}`;
process.env.FLOOM_GITHUB_WEBHOOK_SECRET = 'github-webhook-secret';
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

function git(args, cwd) {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function initRepo(owner, repo) {
  const dir = join(reposRoot, owner, repo);
  mkdirSync(dir, { recursive: true });
  git(['init', '-b', 'main'], dir);
  git(['config', 'user.email', 'test@floom.local'], dir);
  git(['config', 'user.name', 'Floom Test'], dir);
  const files = {
    'floom.yaml': `name: Webhook App
slug: webhook-app
description: Webhook test app
actions:
  run:
    label: Run
    inputs: []
    outputs:
      - name: result
        label: Result
        type: text
runtime: python
python_dependencies: []
node_dependencies: {}
secrets_needed: []
manifest_version: "2.0"
`,
    'app.py': 'def run():\n    return {"result": "ok"}\n',
  };
  for (const [rel, body] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
  git(['add', '.'], dir);
  git(['commit', '-m', 'initial'], dir);
  return dir;
}

initRepo('octo', 'webhook-app');

const api = createServer((req, res) => {
  if (!req.url.startsWith('/repos/octo/webhook-app')) {
    res.writeHead(404).end();
    return;
  }
  if (req.method === 'HEAD') {
    res.writeHead(200).end();
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ full_name: 'octo/webhook-app', default_branch: 'main' }));
});
await new Promise((resolve) => api.listen(0, '127.0.0.1', resolve));
process.env.FLOOM_GITHUB_API_BASE_URL = `http://127.0.0.1:${api.address().port}`;

const honoModule = await import('../../apps/server/node_modules/hono/dist/hono.js');
const Hono = honoModule.Hono || honoModule.default;
const { db } = await import('../../apps/server/dist/db.js');
const { studioBuildRouter } = await import('../../apps/server/dist/routes/studio-build.js');

const app = new Hono();
app.route('/api/studio/build', studioBuildRouter);

async function request(method, path, body, headers = {}) {
  const raw = typeof body === 'string' ? body : body ? JSON.stringify(body) : undefined;
  const res = await app.fetch(
    new Request(`http://localhost${path}`, {
      method,
      headers: raw
        ? { 'content-type': 'application/json', ...headers }
        : headers,
      body: raw,
    }),
  );
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text };
}

async function waitBuild(buildId) {
  for (let i = 0; i < 80; i++) {
    const res = await request('GET', `/api/studio/build/${buildId}`);
    if (res.json?.status === 'published' || res.json?.status === 'error') return res;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for build ${buildId}`);
}

function sign(body) {
  return 'sha256=' + createHmac('sha256', process.env.FLOOM_GITHUB_WEBHOOK_SECRET)
    .update(body)
    .digest('hex');
}

function pushBody(branch) {
  return JSON.stringify({
    ref: `refs/heads/${branch}`,
    repository: {
      html_url: 'https://github.com/octo/webhook-app',
      full_name: 'octo/webhook-app',
      name: 'webhook-app',
      owner: { login: 'octo' },
    },
  });
}

console.log('GitHub deploy webhook tests');

const initial = await request('POST', '/api/studio/build/from-github', {
  github_url: 'https://github.com/octo/webhook-app',
});
const initialDone = await waitBuild(initial.json.build_id);
log('initial build publishes', initialDone.json.status === 'published', JSON.stringify(initialDone.json));

const mainBody = pushBody('main');
const signed = await request('POST', '/api/studio/build/github-webhook', mainBody, {
  'x-github-event': 'push',
  'x-hub-signature-256': sign(mainBody),
});
log('signed push webhook returns 202', signed.status === 202, signed.text);
const rebuildDone = await waitBuild(signed.json.build_id);
log('signed push webhook triggers rebuild', rebuildDone.json.status === 'published', JSON.stringify(rebuildDone.json));
log('rebuild keeps published app slug', rebuildDone.json.slug === initialDone.json.slug, JSON.stringify(rebuildDone.json));

const badSig = await request('POST', '/api/studio/build/github-webhook', mainBody, {
  'x-github-event': 'push',
  'x-hub-signature-256': 'sha256=deadbeef',
});
log('wrong signature returns 401', badSig.status === 401, badSig.text);

const branchBody = pushBody('feature-branch');
const ignored = await request('POST', '/api/studio/build/github-webhook', branchBody, {
  'x-github-event': 'push',
  'x-hub-signature-256': sign(branchBody),
});
log('different branch push is ignored', ignored.status === 200 && ignored.json?.ignored === true, ignored.text);
const buildsAfterIgnored = db.prepare('SELECT COUNT(*) as n FROM builds').get().n;
log('different branch push does not enqueue build', buildsAfterIgnored === 2, `builds=${buildsAfterIgnored}`);

api.close();
db.close();
rmSync(tmp, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

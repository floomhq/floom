#!/usr/bin/env node
// ADR-015 public GitHub deploy tests.
//
// Uses local git repositories plus a mocked GitHub API server. Docker builds
// are skipped via FLOOM_GITHUB_DEPLOY_SKIP_DOCKER so the test verifies server
// routing, validation, queueing, manifest handling, slug disambiguation, and
// private publication without requiring a Docker daemon.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'floom-gh-deploy-public-'));
const reposRoot = join(tmp, 'repos');
mkdirSync(reposRoot, { recursive: true });

process.env.DATA_DIR = join(tmp, 'data');
process.env.FLOOM_DISABLE_JOB_WORKER = 'true';
process.env.FLOOM_DISABLE_TRIGGERS_WORKER = 'true';
process.env.FLOOM_DISABLE_GITHUB_BUILD_WORKER = 'true';
process.env.FLOOM_GITHUB_DEPLOY_SKIP_DOCKER = 'true';
process.env.FLOOM_GITHUB_CLONE_URL_TEMPLATE = `${reposRoot}/{owner}/{repo}`;
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

function initRepo(owner, repo, files, branch = 'main') {
  const ownerDir = join(reposRoot, owner);
  const dir = join(ownerDir, repo);
  mkdirSync(dir, { recursive: true });
  git(['init', '-b', branch], dir);
  git(['config', 'user.email', 'test@floom.local'], dir);
  git(['config', 'user.name', 'Floom Test'], dir);
  for (const [rel, body] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
  git(['add', '.'], dir);
  git(['commit', '-m', 'initial'], dir);
  return dir;
}

const manifest = (name, slug = name.toLowerCase().replaceAll(' ', '-')) => `name: ${name}
slug: ${slug}
description: ${name} test app
actions:
  run:
    label: Run
    inputs:
      - name: message
        label: Message
        type: text
        required: false
    outputs:
      - name: result
        label: Result
        type: text
runtime: python
python_dependencies: []
node_dependencies: {}
secrets_needed: []
manifest_version: "2.0"
`;

initRepo('octo', 'public-app', {
  'floom.yaml': manifest('Public App', 'public-app'),
  'app.py': 'def run(message=""):\n    return {"result": message or "ok"}\n',
});
initRepo('octo', 'multi-yaml', {
  'examples/one/floom.yaml': manifest('One App', 'one-app'),
  'examples/one/app.py': 'def run(message=""):\n    return {"result": "one"}\n',
  'examples/two/floom.yaml': manifest('Two App', 'two-app'),
  'examples/two/app.py': 'def run(message=""):\n    return {"result": "two"}\n',
});
initRepo('octo', 'invalid-yaml', {
  'floom.yaml': 'name: Broken\nmanifest_version: "2.0"\nactions: {}\n',
  'app.py': 'def run():\n    return {"result": "bad"}\n',
});
initRepo('octo', 'conflict-app', {
  'floom.yaml': manifest('Conflict App', 'conflict'),
  'app.py': 'def run(message=""):\n    return {"result": "conflict"}\n',
});

const api = createServer((req, res) => {
  const match = req.url.match(/^\/repos\/([^/]+)\/([^/?#]+)/);
  if (!match) {
    res.writeHead(404).end();
    return;
  }
  const [, owner, repo] = match;
  if (repo === 'private-app') {
    res.writeHead(403).end();
    return;
  }
  if (!['public-app', 'multi-yaml', 'invalid-yaml', 'conflict-app'].includes(repo)) {
    res.writeHead(404).end();
    return;
  }
  if (req.method === 'HEAD') {
    res.writeHead(200).end();
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ full_name: `${owner}/${repo}`, default_branch: 'main' }));
});
await new Promise((resolve) => api.listen(0, '127.0.0.1', resolve));
process.env.FLOOM_GITHUB_API_BASE_URL = `http://127.0.0.1:${api.address().port}`;

const honoModule = await import('../../apps/server/node_modules/hono/dist/hono.js');
const Hono = honoModule.Hono || honoModule.default;
const { db } = await import('../../apps/server/dist/db.js');
const { studioBuildRouter } = await import('../../apps/server/dist/routes/studio-build.js');

const app = new Hono();
app.route('/api/studio/build', studioBuildRouter);

async function request(method, path, body) {
  const res = await app.fetch(
    new Request(`http://localhost${path}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
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

console.log('GitHub public deploy tests');

const valid = await request('POST', '/api/studio/build/from-github', {
  github_url: 'https://github.com/octo/public-app',
});
log('valid public repo: POST returns 202', valid.status === 202, valid.text);
const validDone = await waitBuild(valid.json.build_id);
log('valid public repo: build publishes', validDone.json.status === 'published', JSON.stringify(validDone.json));
const validRow = db.prepare('SELECT visibility, publish_status FROM apps WHERE slug = ?').get(validDone.json.slug);
log('valid public repo: app is private', validRow?.visibility === 'private');
log('valid public repo: app publish_status is published', validRow?.publish_status === 'published');

const priv = await request('POST', '/api/studio/build/from-github', {
  github_url: 'https://github.com/octo/private-app',
});
log('private repo: returns 403', priv.status === 403, priv.text);
log(
  'private repo: message mentions GitHub App',
  String(priv.json?.error || '').includes('install Floom GitHub App'),
  priv.text,
);

const malformed = await request('POST', '/api/studio/build/from-github', {
  github_url: 'https://evil.example/octo/public-app',
});
log('malformed URL: returns 400', malformed.status === 400, malformed.text);

const multi = await request('POST', '/api/studio/build/from-github', {
  github_url: 'https://github.com/octo/multi-yaml',
});
log('multi-yaml repo: returns picker conflict', multi.status === 409, multi.text);
log(
  'multi-yaml repo: returns manifest_paths',
  Array.isArray(multi.json?.manifest_paths) && multi.json.manifest_paths.length === 2,
  multi.text,
);
const picked = await request('POST', '/api/studio/build/from-github', {
  github_url: 'https://github.com/octo/multi-yaml',
  manifest_path: 'examples/two/floom.yaml',
});
const pickedDone = await waitBuild(picked.json.build_id);
log('multi-yaml repo: selected manifest publishes', pickedDone.json.slug === 'two-app', JSON.stringify(pickedDone.json));

const invalid = await request('POST', '/api/studio/build/from-github', {
  github_url: 'https://github.com/octo/invalid-yaml',
});
log('invalid yaml: returns 422', invalid.status === 422, invalid.text);
log('invalid yaml: validation error is clear', invalid.json?.code === 'manifest_invalid', invalid.text);

db.prepare(
  `INSERT INTO apps (id, slug, name, description, manifest, status, docker_image, code_path, app_type, visibility, workspace_id, author)
   VALUES ('app_existing_conflict', 'conflict', 'Conflict', 'Existing', ?, 'active', 'image:old', 'github:old', 'docker', 'private', 'local', 'local')`,
).run(JSON.stringify({
  name: 'Conflict',
  description: 'Existing',
  actions: { run: { label: 'Run', inputs: [], outputs: [] } },
  runtime: 'python',
  python_dependencies: [],
  node_dependencies: {},
  secrets_needed: [],
  manifest_version: '2.0',
}));
const conflict = await request('POST', '/api/studio/build/from-github', {
  github_url: 'https://github.com/octo/conflict-app',
});
const conflictDone = await waitBuild(conflict.json.build_id);
log('slug conflict: auto-disambiguates with -2', conflictDone.json.slug === 'conflict-2', JSON.stringify(conflictDone.json));

api.close();
db.close();
rmSync(tmp, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

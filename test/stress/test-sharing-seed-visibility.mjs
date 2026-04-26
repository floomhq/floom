#!/usr/bin/env node
// Sharing P1: published bundled seed apps stay public on a fresh database.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const tmp = mkdtempSync(join(tmpdir(), 'floom-seed-visibility-'));
const dataDir = join(tmp, 'data');

process.env.DATA_DIR = dataDir;
process.env.FLOOM_SEED_APPS = 'true';
process.env.FLOOM_DISABLE_JOB_WORKER = 'true';
process.env.FLOOM_DISABLE_TRIGGERS_WORKER = 'true';
process.env.FLOOM_DISABLE_ZOMBIE_SWEEPER = 'true';

let passed = 0;
let failed = 0;
const log = (label, ok, detail = '') => {
  if (ok) {
    passed++;
    console.log(`  ok  ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${detail ? ' :: ' + detail : ''}`);
  }
};

function cleanup() {
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {}
}
process.on('exit', cleanup);

const seedDir = join(tmp, 'src', 'db');
mkdirSync(seedDir, { recursive: true });
writeFileSync(
  join(seedDir, 'seed.json'),
  JSON.stringify(
    {
      generated_at: '2026-04-26T00:00:00.000Z',
      source: 'stress-test',
      apps: [
        {
          slug: 'seed-public-app',
          name: 'Seed Public App',
          description: 'Seed app for visibility regression coverage',
          category: 'test',
          icon: null,
          author: 'local',
          docker_image: '',
          marketplace_app_id: 'seed_public_app',
          manifest: {
            name: 'Seed Public App',
            description: 'Seed app for visibility regression coverage',
            runtime: 'node',
            python_dependencies: [],
            node_dependencies: {},
            manifest_version: '2.0',
            actions: {
              run: {
                label: 'Run',
                description: 'run',
                inputs: [],
                outputs: [{ name: 'result', label: 'Result', type: 'json' }],
              },
            },
            secrets_needed: [],
          },
        },
      ],
      global_secrets: {},
      per_app_secrets: {},
    },
    null,
    2,
  ),
);
process.chdir(tmp);

const { db } = await import(pathToFileURL(join(REPO_ROOT, 'apps/server/dist/db.js')).href);
const { seedFromFile } = await import(
  pathToFileURL(join(REPO_ROOT, 'apps/server/dist/services/seed.js')).href
);
const { hubRouter } = await import(
  pathToFileURL(join(REPO_ROOT, 'apps/server/dist/routes/hub.js')).href
);

console.log('Sharing P1 · seed visibility');

const seeded = await seedFromFile();
log('seed flow inserts one app', seeded.apps_added === 1, JSON.stringify(seeded));

const hubRes = await hubRouter.fetch(new Request('http://localhost/'));
const hubText = await hubRes.text();
let hubJson = [];
try {
  hubJson = JSON.parse(hubText);
} catch {}
log('GET /api/hub returns 200', hubRes.status === 200, `got ${hubRes.status}`);
log('GET /api/hub returns seeded apps', Array.isArray(hubJson) && hubJson.length >= 1, hubText);
log(
  'GET /api/hub includes the seeded slug',
  Array.isArray(hubJson) && hubJson.some((app) => app.slug === 'seed-public-app'),
  hubText,
);

const rows = db
  .prepare(`SELECT slug, visibility, publish_status FROM apps WHERE publish_status = 'published'`)
  .all();
log('published seed rows exist', rows.length >= 1, JSON.stringify(rows));
log(
  'all published seed rows are public_live',
  rows.every((row) => row.visibility === 'public_live'),
  JSON.stringify(rows),
);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

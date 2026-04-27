#!/usr/bin/env node
// Regression guard for the launch-demo adapter migration.
//
// Verifies seedLaunchDemos keeps forcing first-party showcase rows to the
// Docker/public/null-base-url shape on fresh insert and refresh, healing stale
// proxied rows left by the 2026-04-25 preseed incident.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'floom-launch-demos-healing-'));
process.env.DATA_DIR = join(tmp, 'data');
process.env.FLOOM_DISABLE_JOB_WORKER = 'true';
process.env.FLOOM_MASTER_KEY =
  '0'.repeat(16) + '1'.repeat(16) + '2'.repeat(16) + '3'.repeat(16);

const { db } = await import('../../apps/server/src/db.ts');
const { DEMOS, imageTagForDemo, seedLaunchDemos } = await import(
  '../../apps/server/src/services/launch-demos.ts'
);

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

function createLogger() {
  return {
    log() {},
    warn() {},
    error() {},
  };
}

function createDockerMock(imageChecks) {
  const sequences = new Map(
    Object.entries(imageChecks).map(([tag, values]) => [tag, [...values]]),
  );
  const stream = {};

  return {
    async ping() {
      return undefined;
    },
    async buildImage() {
      return stream;
    },
    getImage(tag) {
      return {
        inspect: async () => {
          const seq = sequences.get(tag) ?? [false];
          const exists = seq.length > 1 ? seq.shift() : seq[0];
          sequences.set(tag, seq);
          if (!exists) throw new Error(`missing image: ${tag}`);
          return { Id: tag };
        },
      };
    },
    modem: {
      followProgress(_stream, onFinished) {
        onFinished(null, []);
      },
    },
  };
}

const repoRoot = join(tmp, 'repo');
for (const demo of DEMOS) {
  const contextPath = join(repoRoot, demo.contextDir);
  mkdirSync(contextPath, { recursive: true });
  writeFileSync(join(contextPath, 'Dockerfile'), 'FROM python:3.12-slim\n');
  writeFileSync(join(contextPath, 'main.py'), `print("${demo.slug}")\n`);
}

const imageChecks = {};
for (const demo of DEMOS) {
  const tag = imageTagForDemo(demo, join(repoRoot, demo.contextDir));
  imageChecks[tag] = [false, true];
}
const docker = createDockerMock(imageChecks);
const logger = createLogger();

console.log('launch-demos healing through adapters.storage');

const inserted = await seedLaunchDemos({ docker, logger, repoRoot });
log('fresh seed: added all demos', inserted.apps_added === DEMOS.length);
log('fresh seed: no existing demos', inserted.apps_existing === 0);
log('fresh seed: no failed demos', inserted.apps_failed === 0);

for (const demo of DEMOS) {
  const row = db.prepare('SELECT * FROM apps WHERE slug = ?').get(demo.slug);
  log(`${demo.slug}: inserted`, row?.slug === demo.slug);
  log(`${demo.slug}: app_type=docker`, row?.app_type === 'docker');
  log(`${demo.slug}: visibility=public`, row?.visibility === 'public');
  log(`${demo.slug}: base_url=NULL`, row?.base_url === null);
  log(`${demo.slug}: hero=1`, row?.hero === 1);
  log(`${demo.slug}: publish_status=published`, row?.publish_status === 'published');
}

const staleSlug = DEMOS[0].slug;
db.prepare(
  `UPDATE apps
     SET app_type = 'proxied',
         visibility = 'private',
         base_url = 'http://172.17.0.1:4310',
         stars = 42,
         featured = 1
   WHERE slug = ?`,
).run(staleSlug);

const healed = await seedLaunchDemos({ docker, logger, repoRoot });
log('refresh seed: no added demos', healed.apps_added === 0);
log('refresh seed: refreshed all demos', healed.apps_existing === DEMOS.length);
log('refresh seed: no failed demos', healed.apps_failed === 0);

const healedRow = db.prepare('SELECT * FROM apps WHERE slug = ?').get(staleSlug);
log('stale row healed: app_type=docker', healedRow?.app_type === 'docker');
log('stale row healed: visibility=public', healedRow?.visibility === 'public');
log('stale row healed: base_url=NULL', healedRow?.base_url === null);
log('stale row preserved: stars', healedRow?.stars === 42);
log('stale row preserved: featured', healedRow?.featured === 1);

rmSync(tmp, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

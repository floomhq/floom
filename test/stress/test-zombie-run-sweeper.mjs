#!/usr/bin/env node
// Regression test for the zombie-run sweeper (#349).
//
// Every run is dispatched fire-and-forget (`void runActionWorker(...)`) from
// dispatchRun. If the server process dies, is OOM-killed, or is redeployed
// mid-run, the run row stays in `status='running'` forever — the /p/:slug
// client polls forever, MCP callers time out client-side, and the row
// never graduates.
//
// The sweeper flips any such row to `error` with error_type=floom_internal_error
// so the taxonomy can render a real card. This test:
//   1. Seeds an app + 3 running rows with different started_at times.
//   2. Calls sweepZombieRuns() and asserts all 3 got flipped (boot-time
//      recovery: any running row at process start is orphaned).
//   3. Seeds another running row with a recent started_at and a very old
//      one, runs startZombieRunSweeper with a short ceilingMs, and asserts
//      only the old one gets reaped.
//
// Prereq: pnpm --filter @floom/server build (so dist/services/runner.js exists).

import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const testDir = join(__dirname, '..', '..', '.test-zombie-sweeper');

// Clean slate + isolate from the real DB.
rmSync(testDir, { recursive: true, force: true });
mkdirSync(join(testDir, 'apps'), { recursive: true });
process.env.DATA_DIR = testDir;

// Import after setting DATA_DIR so db.ts uses the test location.
const dbModule = await import(
  pathToFileURL(
    join(__dirname, '..', '..', 'apps', 'server', 'dist', 'db.js'),
  ).href
);
const runnerModule = await import(
  pathToFileURL(
    join(__dirname, '..', '..', 'apps', 'server', 'dist', 'services', 'runner.js'),
  ).href
);
const { db } = dbModule;
const { sweepZombieRuns, startZombieRunSweeper } = runnerModule;

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  if (ok) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? ' -- ' + detail : ''}`);
  }
}

// Seed an app row so the FK on runs.app_id resolves.
db.prepare(
  `INSERT INTO apps (id, slug, name, description, manifest, code_path)
   VALUES (?, ?, ?, ?, ?, ?)`,
).run('test-app', 'test-app', 'Test', 'desc', '{}', '/tmp/doesnt-matter');

function insertRun(id, startedAtSqlite) {
  db.prepare(
    `INSERT INTO runs (id, app_id, action, status, started_at)
     VALUES (?, ?, ?, 'running', ?)`,
  ).run(id, 'test-app', 'run', startedAtSqlite);
}

function getRun(id) {
  return db.prepare('SELECT * FROM runs WHERE id = ?').get(id);
}

function sqliteTsFromDate(d) {
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

// --- Test 1: sweepZombieRuns() flips every running row at boot ---
console.log('sweepZombieRuns: boot-time recovery');

insertRun('r_boot_a', sqliteTsFromDate(new Date(Date.now() - 10_000)));
insertRun('r_boot_b', sqliteTsFromDate(new Date(Date.now() - 60_000)));
insertRun('r_boot_c', sqliteTsFromDate(new Date(Date.now() - 3600_000)));

const sweptBoot = sweepZombieRuns();
check('returns count of swept rows', sweptBoot === 3, `got ${sweptBoot}`);

for (const id of ['r_boot_a', 'r_boot_b', 'r_boot_c']) {
  const row = getRun(id);
  check(`${id} flipped to error`, row.status === 'error', `status=${row.status}`);
  check(
    `${id} has floom_internal_error type`,
    row.error_type === 'floom_internal_error',
    `error_type=${row.error_type}`,
  );
  check(
    `${id} has user-facing message`,
    typeof row.error === 'string' && row.error.includes('interrupted'),
    `error=${row.error}`,
  );
  check(
    `${id} has finished_at`,
    row.finished_at !== null,
    `finished_at=${row.finished_at}`,
  );
  check(
    `${id} has duration_ms`,
    typeof row.duration_ms === 'number' && row.duration_ms > 0,
    `duration_ms=${row.duration_ms}`,
  );
}

// Second call is a no-op (no running rows left).
const sweptAgain = sweepZombieRuns();
check('second call is a no-op', sweptAgain === 0, `got ${sweptAgain}`);

// --- Test 2: startZombieRunSweeper respects the age ceiling ---
console.log('\nstartZombieRunSweeper: periodic reap respects age ceiling');

// A run that just started — must NOT be reaped by the periodic sweeper.
insertRun('r_fresh', sqliteTsFromDate(new Date(Date.now() - 1_000)));
// An orphan from well before the ceiling — MUST be reaped.
insertRun('r_stale', sqliteTsFromDate(new Date(Date.now() - 30 * 60_000)));

// Tight window: 50ms interval, 60s ceiling. Run the sweeper for ~150ms so
// at least one tick fires, then stop it before the test process exits.
const handle = startZombieRunSweeper(50, 60_000);
await new Promise((r) => setTimeout(r, 200));
handle.stop();

const fresh = getRun('r_fresh');
const stale = getRun('r_stale');
check(
  'fresh run is left alone',
  fresh.status === 'running',
  `status=${fresh.status}`,
);
check(
  'stale run got reaped',
  stale.status === 'error',
  `status=${stale.status}`,
);
check(
  'stale run has reap message',
  typeof stale.error === 'string' && stale.error.includes('reaped'),
  `error=${stale.error}`,
);

// Cleanup.
db.close();
rmSync(testDir, { recursive: true, force: true });

console.log(`\nResult: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

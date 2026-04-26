#!/usr/bin/env node
// Admin role gate: non-admin users get 403, admin users get 200.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'floom-sharing-admin-'));
process.env.DATA_DIR = tmp;
process.env.FLOOM_DISABLE_JOB_WORKER = 'true';
process.env.FLOOM_DISABLE_TRIGGERS_WORKER = 'true';
process.env.FLOOM_DISABLE_ZOMBIE_SWEEPER = 'true';

const { db } = await import('../../apps/server/dist/db.js');
const { adminRouter } = await import('../../apps/server/dist/routes/admin.js');

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

async function getQueue() {
  const res = await adminRouter.fetch(new Request('http://localhost/review-queue'));
  return { status: res.status, text: await res.text() };
}

console.log('Sharing · admin role');
db.prepare(`UPDATE users SET is_admin = 0 WHERE id = 'local'`).run();
const denied = await getQueue();
log('non-admin gets 403', denied.status === 403, `got ${denied.status}`);

db.prepare(`UPDATE users SET is_admin = 1 WHERE id = 'local'`).run();
const allowed = await getQueue();
log('admin gets 200', allowed.status === 200, `got ${allowed.status}`);

rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

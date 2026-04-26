#!/usr/bin/env node
// Admin review queue: admin-only list/detail, approve, reject with comment,
// idempotent decisions.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const tmp = mkdtempSync(join(tmpdir(), 'floom-sharing-review-'));
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

async function call(method, path, body) {
  const res = await adminRouter.fetch(
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

function insertApp(slug) {
  const id = `app_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  db.prepare(
    `INSERT INTO apps
       (id, slug, name, description, manifest, status, code_path, author, workspace_id, app_type,
        visibility, review_submitted_at, publish_status)
     VALUES (?, ?, ?, 'test app', ?, 'active', 'proxied:test', 'local', 'local', 'proxied',
        'pending_review', datetime('now'), 'pending_review')`,
  ).run(id, slug, slug, JSON.stringify({ name: slug, actions: {}, secrets_needed: [] }));
  return id;
}

console.log('Sharing · review queue');
db.prepare(`UPDATE users SET is_admin = 1 WHERE id = 'local'`).run();
insertApp('approve-me');
insertApp('reject-me');

const queue = await call('GET', '/review-queue');
const slugs = queue.json?.apps?.map((app) => app.slug) || [];
log('review queue lists pending apps', queue.status === 200 && slugs.includes('approve-me') && slugs.includes('reject-me'));

const detail = await call('GET', '/review-queue/approve-me');
log('review detail returns manifest data', detail.status === 200 && detail.json?.app?.slug === 'approve-me');

const approved = await call('POST', '/review-queue/approve-me/approve');
log('approve moves to public_live', approved.status === 200 && approved.json?.app?.visibility === 'public_live', approved.text);
const approvedAgain = await call('POST', '/review-queue/approve-me/approve');
log('approve is idempotent', approvedAgain.status === 200 && approvedAgain.json?.idempotent === true, approvedAgain.text);

const rejected = await call('POST', '/review-queue/reject-me/reject', { comment: 'Needs a clearer description.' });
log('reject moves to changes_requested', rejected.status === 200 && rejected.json?.app?.visibility === 'changes_requested', rejected.text);
const row = db.prepare(`SELECT review_comment FROM apps WHERE slug = 'reject-me'`).get();
log('reject stores comment', row.review_comment === 'Needs a clearer description.');
const rejectedAgain = await call('POST', '/review-queue/reject-me/reject', { comment: 'Needs a clearer description.' });
log('reject is idempotent', rejectedAgain.status === 200 && rejectedAgain.json?.idempotent === true, rejectedAgain.text);

rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

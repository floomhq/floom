#!/usr/bin/env node
// Link sharing: cryptographic token creation, rotation, and read-path 404s.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const tmp = mkdtempSync(join(tmpdir(), 'floom-sharing-link-'));
process.env.DATA_DIR = tmp;
process.env.FLOOM_DISABLE_JOB_WORKER = 'true';
process.env.FLOOM_DISABLE_TRIGGERS_WORKER = 'true';
process.env.FLOOM_DISABLE_ZOMBIE_SWEEPER = 'true';

const { db } = await import('../../apps/server/dist/db.js');
const { hubRouter } = await import('../../apps/server/dist/routes/hub.js');
const { transitionVisibility } = await import('../../apps/server/dist/services/sharing.js');

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

async function fetchHub(path) {
  const res = await hubRouter.fetch(new Request(`http://localhost${path}`));
  return { status: res.status, text: await res.text() };
}

function insertApp() {
  const id = `app_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  db.prepare(
    `INSERT INTO apps
       (id, slug, name, description, manifest, status, code_path, author, workspace_id, app_type, visibility, publish_status)
     VALUES (?, 'link-app', 'Link App', 'test app', ?, 'active', 'proxied:test', 'owner', 'local', 'proxied', 'private', 'pending_review')`,
  ).run(id, JSON.stringify({ name: 'Link App', actions: {}, secrets_needed: [] }));
  return id;
}

console.log('Sharing · link tokens');
db.prepare(
  `INSERT INTO users (id, workspace_id, email, name, auth_provider)
   VALUES ('owner', 'local', 'owner@example.com', 'Owner', 'local')`,
).run();

const id = insertApp();
const first = transitionVisibility(db.prepare(`SELECT * FROM apps WHERE id = ?`).get(id), 'link', {
  actorUserId: 'owner',
  reason: 'owner_enable_link',
});
log('token is 24 base62 chars', /^[0-9A-Za-z]{24}$/.test(first.link_share_token), first.link_share_token);

const noToken = await fetchHub('/link-app');
log('missing token returns 404', noToken.status === 404, `got ${noToken.status}`);

const badToken = await fetchHub('/link-app?key=wrong');
log('invalid token returns 404', badToken.status === 404, `got ${badToken.status}`);

const goodToken = await fetchHub(`/link-app?key=${first.link_share_token}`);
log('valid token returns 200', goodToken.status === 200, `got ${goodToken.status}`);

const privateAgain = transitionVisibility(first, 'private', {
  actorUserId: 'owner',
  reason: 'owner_set_private',
});
const rotated = transitionVisibility(privateAgain, 'link', {
  actorUserId: 'owner',
  reason: 'owner_enable_link',
  rotateLinkToken: true,
});
log('rotated token changes', rotated.link_share_token !== first.link_share_token);
log('old token rejected after rotation', (await fetchHub(`/link-app?key=${first.link_share_token}`)).status === 404);
log('new token accepted after rotation', (await fetchHub(`/link-app?key=${rotated.link_share_token}`)).status === 200);

rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

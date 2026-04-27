#!/usr/bin/env node
// Invite system: username/email invites, accept, decline, revoke, double accept.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const tmp = mkdtempSync(join(tmpdir(), 'floom-sharing-invites-'));
process.env.DATA_DIR = tmp;
process.env.FLOOM_DISABLE_JOB_WORKER = 'true';
process.env.FLOOM_DISABLE_TRIGGERS_WORKER = 'true';
process.env.FLOOM_DISABLE_ZOMBIE_SWEEPER = 'true';

const { db } = await import('../../apps/server/dist/db.js');
const { meAppsRouter } = await import('../../apps/server/dist/routes/me_apps.js');
const {
  acceptInvite,
  declineInvite,
  linkPendingEmailInvites,
  upsertInvite,
  userHasAcceptedInvite,
} = await import('../../apps/server/dist/services/sharing.js');

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

async function call(router, method, path, body) {
  const res = await router.fetch(
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

function seed() {
  db.prepare(`UPDATE users SET email = 'owner@example.com', name = 'owner' WHERE id = 'local'`).run();
  db.prepare(
    `INSERT INTO users (id, workspace_id, email, name, auth_provider)
     VALUES ('user_bob', 'local', 'bob@example.com', 'bob', 'local')`,
  ).run();
  db.prepare(
    `INSERT INTO users (id, workspace_id, email, name, auth_provider)
     VALUES ('user_carol', 'local', 'carol@example.com', 'carol', 'local')`,
  ).run();
  const appId = `app_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  db.prepare(
    `INSERT INTO apps
       (id, slug, name, description, manifest, status, code_path, author, workspace_id, app_type, visibility)
     VALUES (?, 'invite-app', 'Invite App', 'test app', ?, 'active', 'proxied:test', 'local', 'local', 'proxied', 'private')`,
  ).run(appId, JSON.stringify({ name: 'Invite App', actions: {}, secrets_needed: [] }));
  return appId;
}

console.log('Sharing · invites');
const appId = seed();

const byUsername = await call(meAppsRouter, 'POST', '/invite-app/sharing/invite', { username: 'bob' });
log('invite by username returns 201', byUsername.status === 201, `got ${byUsername.status}`);
log('username invite is pending_accept', byUsername.json?.invite?.state === 'pending_accept', byUsername.text);

const revoked = await call(
  meAppsRouter,
  'POST',
  `/invite-app/sharing/invite/${byUsername.json.invite.id}/revoke`,
);
log('owner can revoke invite', revoked.status === 200 && revoked.json?.invite?.state === 'revoked', revoked.text);

const byExistingEmail = await call(meAppsRouter, 'POST', '/invite-app/sharing/invite', {
  email: 'carol@example.com',
});
log('existing email invite is pending_accept', byExistingEmail.json?.invite?.state === 'pending_accept');

const accepted = await acceptInvite(byExistingEmail.json.invite.id, 'user_carol');
log('invitee can accept', accepted.changed && accepted.invite?.state === 'accepted');
log('accepted invite grants access', await userHasAcceptedInvite(appId, 'user_carol'));

const acceptedAgain = await acceptInvite(byExistingEmail.json.invite.id, 'user_carol');
log('double accept is idempotent', !acceptedAgain.changed && acceptedAgain.invite?.state === 'accepted');

const decline = await upsertInvite({
  appId,
  invitedByUserId: 'local',
  invitedUserId: 'user_bob',
  invitedEmail: 'bob@example.com',
  state: 'pending_accept',
});
const declined = await declineInvite(decline.id, 'user_bob');
log('invitee can decline', declined?.state === 'declined');

const newEmail = await call(meAppsRouter, 'POST', '/invite-app/sharing/invite', {
  email: 'newperson@example.com',
});
log('new email invite is pending_email', newEmail.json?.invite?.state === 'pending_email');
db.prepare(
  `INSERT INTO users (id, workspace_id, email, name, auth_provider)
   VALUES ('user_new', 'local', 'newperson@example.com', 'New Person', 'local')`,
).run();
const linked = await linkPendingEmailInvites('user_new', 'newperson@example.com');
const linkedInvite = db.prepare(`SELECT * FROM app_invites WHERE id = ?`).get(newEmail.json.invite.id);
log('signup links pending_email invite', linked === 1 && linkedInvite.state === 'pending_accept');

rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

#!/usr/bin/env node
// Sharing visibility state machine: legal transitions succeed and illegal
// transitions are rejected server-side.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const tmp = mkdtempSync(join(tmpdir(), 'floom-sharing-sm-'));
process.env.DATA_DIR = tmp;
process.env.FLOOM_DISABLE_JOB_WORKER = 'true';
process.env.FLOOM_DISABLE_TRIGGERS_WORKER = 'true';
process.env.FLOOM_DISABLE_ZOMBIE_SWEEPER = 'true';

const { db } = await import('../../apps/server/dist/db.js');
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

function insertApp(slug, visibility = 'private') {
  const id = `app_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  db.prepare(
    `INSERT INTO apps
       (id, slug, name, description, manifest, status, code_path, author, workspace_id, app_type, visibility)
     VALUES (?, ?, ?, 'test app', ?, 'active', 'proxied:test', 'local', 'local', 'proxied', ?)`,
  ).run(id, slug, slug, JSON.stringify({ name: slug, actions: {}, secrets_needed: [] }), visibility);
  return id;
}

function load(id) {
  return db.prepare(`SELECT * FROM apps WHERE id = ?`).get(id);
}

function move(id, to, reason) {
  return transitionVisibility(load(id), to, { actorUserId: 'local', reason });
}

function reset(id, visibility) {
  db.prepare(`UPDATE apps SET visibility = ?, link_share_token = NULL WHERE id = ?`).run(visibility, id);
}

console.log('Sharing · state machine');

const id = insertApp('state-machine');
const legal = [
  ['private', 'link', 'owner_enable_link'],
  ['link', 'private', 'owner_set_private'],
  ['private', 'invited', 'owner_set_invited'],
  ['invited', 'private', 'owner_set_private'],
  ['private', 'pending_review', 'owner_submit_review'],
  ['pending_review', 'public_live', 'admin_approve'],
  ['public_live', 'private', 'owner_unlist'],
  ['private', 'pending_review', 'owner_submit_review'],
  ['pending_review', 'changes_requested', 'admin_reject'],
  ['changes_requested', 'pending_review', 'owner_resubmit_review'],
];

for (const [from, to, reason] of legal) {
  reset(id, from);
  const next = move(id, to, reason);
  log(`${from} -> ${to}`, next.visibility === to, `got ${next.visibility}`);
}

const illegal = [
  ['private', 'public_live', 'admin_approve'],
  ['link', 'invited', 'owner_set_invited'],
  ['pending_review', 'link', 'owner_enable_link'],
  ['public_live', 'invited', 'owner_set_invited'],
  ['changes_requested', 'public_live', 'admin_approve'],
];

for (const [from, to, reason] of illegal) {
  reset(id, from);
  let threw = false;
  try {
    move(id, to, reason);
  } catch {
    threw = true;
  }
  log(`${from} -> ${to} rejected`, threw);
}

rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

#!/usr/bin/env node
// Layer 5 Round 1: workspace_secrets service contract.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'floom-workspace-secrets-'));
process.env.DATA_DIR = tmp;
process.env.FLOOM_DISABLE_JOB_WORKER = 'true';
process.env.FLOOM_MASTER_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const { db, DEFAULT_USER_ID, DEFAULT_WORKSPACE_ID } = await import('../../apps/server/dist/db.js');
const userSecrets = await import('../../apps/server/dist/services/user_secrets.js');

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

console.log('Layer 5 workspace_secrets tests');

const ctx = {
  workspace_id: DEFAULT_WORKSPACE_ID,
  user_id: DEFAULT_USER_ID,
  device_id: 'layer5-secrets-device',
  is_authenticated: false,
};

userSecrets.setWorkspaceSecret(DEFAULT_WORKSPACE_ID, 'OPENAI_API_KEY', 'workspace-secret-1');
const row = db
  .prepare('SELECT * FROM workspace_secrets WHERE workspace_id = ? AND key = ?')
  .get(DEFAULT_WORKSPACE_ID, 'OPENAI_API_KEY');
log('setWorkspaceSecret writes workspace_secrets row', !!row);
log('workspace ciphertext does not contain plaintext', row && !row.ciphertext.includes('workspace-secret'));
log(
  'getWorkspaceSecret decrypts workspace row',
  userSecrets.getWorkspaceSecret(DEFAULT_WORKSPACE_ID, 'OPENAI_API_KEY') === 'workspace-secret-1',
);

const listed = userSecrets.listWorkspaceMasked(ctx);
log(
  'listWorkspaceMasked includes workspace key',
  listed.some((entry) => entry.key === 'OPENAI_API_KEY' && entry.source === 'workspace'),
  JSON.stringify(listed),
);
log(
  'listWorkspaceMasked omits plaintext and ciphertext',
  listed.every((entry) => !('value' in entry) && !('ciphertext' in entry)),
  JSON.stringify(listed),
);

userSecrets.set(ctx, 'LEGACY_ONLY', 'legacy-secret');
log(
  'legacy user_secrets fallback loads when workspace row is absent',
  userSecrets.loadForRun(ctx, ['LEGACY_ONLY']).LEGACY_ONLY === 'legacy-secret',
);
log(
  'legacy fallback appears in masked list',
  userSecrets
    .listWorkspaceMasked(ctx)
    .some((entry) => entry.key === 'LEGACY_ONLY' && entry.source === 'legacy_user'),
);

userSecrets.set(ctx, 'DUAL_KEY', 'legacy-value');
userSecrets.setWorkspaceSecret(DEFAULT_WORKSPACE_ID, 'DUAL_KEY', 'workspace-value');
log(
  'workspace secret wins over legacy user_secrets fallback',
  userSecrets.loadForRun(ctx, ['DUAL_KEY']).DUAL_KEY === 'workspace-value',
);

const removed = userSecrets.delWorkspaceSecret(DEFAULT_WORKSPACE_ID, 'DUAL_KEY');
log('delWorkspaceSecret removes workspace row', removed === true);
log(
  'legacy fallback remains after workspace delete',
  userSecrets.loadForRun(ctx, ['DUAL_KEY']).DUAL_KEY === 'legacy-value',
);

const removedOpenai = userSecrets.delWorkspaceSecret(DEFAULT_WORKSPACE_ID, 'OPENAI_API_KEY');
log('delete returns true for existing workspace secret', removedOpenai === true);
log(
  'deleted workspace secret reads as null',
  userSecrets.getWorkspaceSecret(DEFAULT_WORKSPACE_ID, 'OPENAI_API_KEY') === null,
);

db.close();
rmSync(tmp, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

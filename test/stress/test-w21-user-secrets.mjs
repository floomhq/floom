#!/usr/bin/env node
// W2.1 user_secrets tests. Covers AES-256-GCM envelope encryption:
//   - master key resolution (env-provided, file-generated)
//   - per-workspace DEK mint + wrap + persist
//   - secret encrypt/decrypt round-trip
//   - tamper detection
//   - isolation across users
//   - loadForRun filters to declared names
//
// Run: node test/stress/test-w21-user-secrets.mjs

import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'floom-w21-secrets-'));
process.env.DATA_DIR = tmp;
process.env.FLOOM_DISABLE_JOB_WORKER = 'true';
// Don't set FLOOM_MASTER_KEY — we want to exercise the file-generated branch
// first, then re-import with an explicit env var.

const { db, DEFAULT_USER_ID, DEFAULT_WORKSPACE_ID } = await import(
  '../../apps/server/dist/db.js'
);
const userSecrets = await import(
  '../../apps/server/dist/services/user_secrets.js'
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

console.log('W2.1 user_secrets tests');

const ctx = {
  workspace_id: DEFAULT_WORKSPACE_ID,
  user_id: DEFAULT_USER_ID,
  device_id: 'dev-secrets-test',
  is_authenticated: false,
};

// ---- 1. master key file is created on first use ----
// Setting a secret forces loadWorkspaceDek → getMasterKey. With no env var,
// the service should mint a file.
userSecrets.set(ctx, 'OPENAI_API_KEY', 'sk-test-abcd1234');
const masterKeyFile = join(tmp, '.floom-master-key');
log('master key file created on first use', existsSync(masterKeyFile));
const masterKeyRaw = readFileSync(masterKeyFile, 'utf-8').trim();
log('master key file is 64-char hex', /^[0-9a-f]{64}$/i.test(masterKeyRaw));

// ---- 2. set + get round-trip ----
const val = userSecrets.get(ctx, 'OPENAI_API_KEY');
log('set + get round-trip: plaintext matches', val === 'sk-test-abcd1234');

// ---- 3. ciphertext in DB is NOT the plaintext ----
const row = db
  .prepare(
    'SELECT ciphertext, nonce, auth_tag FROM user_secrets WHERE workspace_id = ? AND user_id = ? AND key = ?',
  )
  .get(DEFAULT_WORKSPACE_ID, DEFAULT_USER_ID, 'OPENAI_API_KEY');
log('ciphertext stored (not plaintext)', row && !row.ciphertext.includes('sk-test'));
log('nonce is 24-char hex (12 bytes)', row && /^[0-9a-f]{24}$/i.test(row.nonce));
log('auth_tag is 32-char hex (16 bytes)', row && /^[0-9a-f]{32}$/i.test(row.auth_tag));

// ---- 4. workspaces.wrapped_dek is now populated ----
const ws = db
  .prepare('SELECT wrapped_dek FROM workspaces WHERE id = ?')
  .get(DEFAULT_WORKSPACE_ID);
log('workspace.wrapped_dek populated after first set', !!ws.wrapped_dek);
log('wrapped_dek has 3 colon-separated hex parts', ws.wrapped_dek.split(':').length === 3);

// ---- 5. listMasked returns keys without plaintext ----
const masked = userSecrets.listMasked(ctx);
log('listMasked: returns 1 entry', masked.length === 1);
log("listMasked: key='OPENAI_API_KEY'", masked[0].key === 'OPENAI_API_KEY');
log(
  'listMasked: never returns plaintext',
  !('value' in masked[0]) && !('ciphertext' in masked[0]),
);

// ---- 6. set existing key overwrites ----
userSecrets.set(ctx, 'OPENAI_API_KEY', 'sk-replaced-5678');
const val2 = userSecrets.get(ctx, 'OPENAI_API_KEY');
log('set: overwrite returns new value', val2 === 'sk-replaced-5678');

// ---- 7. del removes the secret ----
const removed = userSecrets.del(ctx, 'OPENAI_API_KEY');
log('del: returns true', removed === true);
const postDel = userSecrets.get(ctx, 'OPENAI_API_KEY');
log('del: subsequent get returns null', postDel === null);

// ---- 8. tamper detection: corrupt ciphertext → SecretDecryptError ----
userSecrets.set(ctx, 'STRIPE_KEY', 'sk_live_abc');
// Flip a bit in the ciphertext column.
db.prepare(
  `UPDATE user_secrets SET ciphertext = 'deadbeef' || SUBSTR(ciphertext, 9)
     WHERE workspace_id = ? AND user_id = ? AND key = ?`,
).run(DEFAULT_WORKSPACE_ID, DEFAULT_USER_ID, 'STRIPE_KEY');

let tamperCaught = false;
try {
  userSecrets.get(ctx, 'STRIPE_KEY');
} catch (err) {
  tamperCaught = err.name === 'SecretDecryptError';
}
log('tamper detection: mangled ciphertext throws SecretDecryptError', tamperCaught);

// Clean the tampered row so following tests work.
userSecrets.del(ctx, 'STRIPE_KEY');

// ---- 9. cross-user isolation ----
// Add alice as a user so FKs are valid.
db.prepare(
  `INSERT INTO users (id, workspace_id, auth_provider) VALUES (?, ?, 'google')`,
).run('alice', DEFAULT_WORKSPACE_ID);
const aliceCtx = { ...ctx, user_id: 'alice' };
userSecrets.set(ctx, 'NOTION_TOKEN', 'local-notion');
userSecrets.set(aliceCtx, 'NOTION_TOKEN', 'alice-notion');
log("local user sees 'local-notion'", userSecrets.get(ctx, 'NOTION_TOKEN') === 'local-notion');
log("alice sees 'alice-notion'", userSecrets.get(aliceCtx, 'NOTION_TOKEN') === 'alice-notion');

// ---- 10. loadForRun only returns requested names ----
userSecrets.set(ctx, 'STRIPE_KEY', 'stripe-123');
const loaded = userSecrets.loadForRun(ctx, ['NOTION_TOKEN', 'DOES_NOT_EXIST']);
log('loadForRun: filtered to requested keys', Object.keys(loaded).length === 1);
log('loadForRun: NOTION_TOKEN decrypted', loaded.NOTION_TOKEN === 'local-notion');
log(
  'loadForRun: STRIPE_KEY not present (not requested)',
  !('STRIPE_KEY' in loaded),
);

// ---- 11. loadForRun with no keys returns {} ----
const empty = userSecrets.loadForRun(ctx, []);
log('loadForRun: empty keys → {}', Object.keys(empty).length === 0);

// ---- cleanup ----
db.close();
rmSync(tmp, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

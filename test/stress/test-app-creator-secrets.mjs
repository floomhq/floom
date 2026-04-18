#!/usr/bin/env node
// secrets-policy tests. Covers:
//   - setPolicy / getPolicy round-trip (+ default 'user_vault')
//   - setCreatorSecret → loadCreatorSecretsForRun round-trip (envelope)
//   - loadCreatorSecretsForRun ignores keys whose policy is user_vault
//   - runner-side resolution: creator keys come from the creator bag,
//     user_vault keys come from each running user's vault, and the
//     two users are isolated from each other.
//
// Run: node test/stress/test-app-creator-secrets.mjs

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'floom-secrets-policy-'));
process.env.DATA_DIR = tmp;
process.env.FLOOM_DISABLE_JOB_WORKER = 'true';

const { db, DEFAULT_USER_ID, DEFAULT_WORKSPACE_ID } = await import(
  '../../apps/server/dist/db.js'
);
const userSecrets = await import(
  '../../apps/server/dist/services/user_secrets.js'
);
const creatorSecrets = await import(
  '../../apps/server/dist/services/app_creator_secrets.js'
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

console.log('secrets-policy tests');

// ---- fixture: one app in the local workspace ----
const APP_ID = 'app-test-1';
db.prepare(
  `INSERT INTO apps (id, slug, name, description, manifest, code_path, workspace_id, author)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
).run(
  APP_ID,
  'ig-nano-scout-test',
  'IG Nano Scout (test)',
  'Test app',
  JSON.stringify({
    name: 'ig-nano-scout-test',
    description: 'test',
    actions: { run: { label: 'Run', inputs: [], outputs: [] } },
    runtime: 'python',
    python_dependencies: [],
    node_dependencies: {},
    secrets_needed: ['EVOMI_PROXY_URL', 'IG_COOKIE'],
    manifest_version: '1.0',
  }),
  '/tmp/fake',
  DEFAULT_WORKSPACE_ID,
  DEFAULT_USER_ID,
);

// ---- 1. default policy is user_vault ----
log(
  'getPolicy default is user_vault',
  creatorSecrets.getPolicy(APP_ID, 'EVOMI_PROXY_URL') === 'user_vault',
);

// ---- 2. setPolicy round-trip ----
creatorSecrets.setPolicy(APP_ID, 'EVOMI_PROXY_URL', 'creator_override');
log(
  'setPolicy / getPolicy round-trip (creator_override)',
  creatorSecrets.getPolicy(APP_ID, 'EVOMI_PROXY_URL') === 'creator_override',
);

// ---- 3. setCreatorSecret + load round-trip ----
creatorSecrets.setCreatorSecret(
  APP_ID,
  DEFAULT_WORKSPACE_ID,
  'EVOMI_PROXY_URL',
  'http://proxy.example:3128',
);
const loaded = creatorSecrets.loadCreatorSecretsForRun(
  APP_ID,
  DEFAULT_WORKSPACE_ID,
  ['EVOMI_PROXY_URL', 'IG_COOKIE'],
);
log(
  'loadCreatorSecretsForRun returns the stored override',
  loaded.EVOMI_PROXY_URL === 'http://proxy.example:3128',
);
log(
  'loadCreatorSecretsForRun ignores user_vault keys (IG_COOKIE absent)',
  !('IG_COOKIE' in loaded),
);

// ---- 4. ciphertext is actually encrypted in DB ----
const row = db
  .prepare(
    'SELECT ciphertext, nonce, auth_tag FROM app_creator_secrets WHERE app_id = ? AND key = ?',
  )
  .get(APP_ID, 'EVOMI_PROXY_URL');
log(
  'ciphertext does not contain plaintext',
  row && !row.ciphertext.includes('proxy.example'),
);
log(
  'nonce is 24-char hex (12 bytes)',
  row && /^[0-9a-f]{24}$/i.test(row.nonce),
);

// ---- 5. listPolicies exposes creator_has_value without plaintext ----
const policies = creatorSecrets.listPolicies(APP_ID);
const proxyPolicy = policies.find((p) => p.key === 'EVOMI_PROXY_URL');
log(
  'listPolicies: creator_override entry marked creator_has_value=true',
  proxyPolicy &&
    proxyPolicy.policy === 'creator_override' &&
    proxyPolicy.creator_has_value === true,
);
log(
  'listPolicies: never leaks value field',
  !('value' in (proxyPolicy ?? {})) && !('ciphertext' in (proxyPolicy ?? {})),
);

// ---- 6. deleteCreatorSecret removes, leaves policy ----
const removed = creatorSecrets.deleteCreatorSecret(APP_ID, 'EVOMI_PROXY_URL');
log('deleteCreatorSecret returns true', removed === true);
const loadedAfterDel = creatorSecrets.loadCreatorSecretsForRun(
  APP_ID,
  DEFAULT_WORKSPACE_ID,
  ['EVOMI_PROXY_URL'],
);
log(
  'after delete, loadCreatorSecretsForRun returns nothing',
  !('EVOMI_PROXY_URL' in loadedAfterDel),
);
log(
  'after delete, policy row is preserved (still creator_override)',
  creatorSecrets.getPolicy(APP_ID, 'EVOMI_PROXY_URL') === 'creator_override',
);

// ---- 7. two users: user_vault key is user-scoped, creator_override is shared ----
// Re-populate the creator value so the runner test has something to find.
creatorSecrets.setCreatorSecret(
  APP_ID,
  DEFAULT_WORKSPACE_ID,
  'EVOMI_PROXY_URL',
  'http://proxy.example:3128',
);

// Second user in the same workspace.
db.prepare(
  `INSERT INTO users (id, workspace_id, auth_provider) VALUES (?, ?, 'google')`,
).run('alice-policy', DEFAULT_WORKSPACE_ID);

const localCtx = {
  workspace_id: DEFAULT_WORKSPACE_ID,
  user_id: DEFAULT_USER_ID,
  device_id: 'dev-local',
  is_authenticated: false,
};
const aliceCtx = {
  workspace_id: DEFAULT_WORKSPACE_ID,
  user_id: 'alice-policy',
  device_id: 'dev-alice',
  is_authenticated: true,
};

userSecrets.set(localCtx, 'IG_COOKIE', 'local-cookie');
userSecrets.set(aliceCtx, 'IG_COOKIE', 'alice-cookie');

// Simulate runner resolution for user_vault keys (each user's vault).
const localUserLevel = userSecrets.loadForRun(localCtx, ['IG_COOKIE']);
const aliceUserLevel = userSecrets.loadForRun(aliceCtx, ['IG_COOKIE']);
log(
  'local user sees their own IG_COOKIE',
  localUserLevel.IG_COOKIE === 'local-cookie',
);
log(
  'alice sees her own IG_COOKIE',
  aliceUserLevel.IG_COOKIE === 'alice-cookie',
);

// Simulate runner resolution for creator_override keys.
const creatorLevelLocal = creatorSecrets.loadCreatorSecretsForRun(
  APP_ID,
  DEFAULT_WORKSPACE_ID,
  ['EVOMI_PROXY_URL', 'IG_COOKIE'],
);
const creatorLevelAlice = creatorSecrets.loadCreatorSecretsForRun(
  APP_ID,
  DEFAULT_WORKSPACE_ID,
  ['EVOMI_PROXY_URL', 'IG_COOKIE'],
);
log(
  'local user gets creator EVOMI_PROXY_URL',
  creatorLevelLocal.EVOMI_PROXY_URL === 'http://proxy.example:3128',
);
log(
  'alice gets the same creator EVOMI_PROXY_URL',
  creatorLevelAlice.EVOMI_PROXY_URL === 'http://proxy.example:3128',
);
log(
  'creator bag does not leak IG_COOKIE (it is user_vault)',
  !('IG_COOKIE' in creatorLevelLocal) && !('IG_COOKIE' in creatorLevelAlice),
);

// ---- 8. flipping policy back to user_vault preserves stored value ----
creatorSecrets.setPolicy(APP_ID, 'EVOMI_PROXY_URL', 'user_vault');
const afterFlip = creatorSecrets.loadCreatorSecretsForRun(
  APP_ID,
  DEFAULT_WORKSPACE_ID,
  ['EVOMI_PROXY_URL'],
);
log(
  'user_vault policy skips creator value even if row exists',
  !('EVOMI_PROXY_URL' in afterFlip),
);
const storedRow = db
  .prepare(
    'SELECT 1 AS n FROM app_creator_secrets WHERE app_id = ? AND key = ?',
  )
  .get(APP_ID, 'EVOMI_PROXY_URL');
log('stored creator value is still there after flip', !!storedRow);

// Flip back and the value returns.
creatorSecrets.setPolicy(APP_ID, 'EVOMI_PROXY_URL', 'creator_override');
const afterFlipBack = creatorSecrets.loadCreatorSecretsForRun(
  APP_ID,
  DEFAULT_WORKSPACE_ID,
  ['EVOMI_PROXY_URL'],
);
log(
  'flipping back restores the override without re-entering',
  afterFlipBack.EVOMI_PROXY_URL === 'http://proxy.example:3128',
);

// ---- cleanup ----
db.close();
rmSync(tmp, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

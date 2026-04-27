#!/usr/bin/env node
// Adapter factory tests. Covers:
//   1. Default keys map to the reference impls (docker / sqlite / better-auth /
//      local / console) under an empty env.
//   2. Unknown values throw at boot with the supported-values list — typos
//      surface before any request is served.
//   3. The returned bundle exposes the expected method surface for each of
//      the five concerns so route code can rely on `adapters.x.y(...)`.
//
// Uses a throwaway DATA_DIR so importing db.ts (transitive dep of the
// factory) never pollutes the real server DB.
//
// Run: tsx test/stress/test-adapters-factory.mjs

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'floom-adapters-factory-'));
const originalCwd = process.cwd();
process.chdir(tmp);
process.env.DATA_DIR = tmp;
process.env.FLOOM_DISABLE_JOB_WORKER = 'true';
process.env.FLOOM_MASTER_KEY =
  '0'.repeat(16) + '1'.repeat(16) + '2'.repeat(16) + '3'.repeat(16);

// Strip any env vars that would steer the factory away from defaults.
for (const k of [
  'FLOOM_RUNTIME',
  'FLOOM_STORAGE',
  'FLOOM_AUTH',
  'FLOOM_SECRETS',
  'FLOOM_OBSERVABILITY',
]) {
  delete process.env[k];
}

const [{ createAdapters, __testing }, { FLOOM_PROTOCOL_VERSION }] = await Promise.all([
  import('../../apps/server/src/adapters/factory.ts'),
  import('../../apps/server/src/adapters/version.ts'),
]);

function storageModuleSource({
  kind = 'storage',
  protocolVersion = '^0.2',
  missingMethods = [],
} = {}) {
  return `
const adapter = {
  async getApp() { return undefined; },
  async getAppById() { return undefined; },
  async listApps() { return []; },
  async createApp(input) { return { ...input, created_at: 'now', updated_at: 'now' }; },
  async updateApp() { return undefined; },
  async deleteApp() { return false; },
  async createRun(input) { return { ...input, status: 'queued', created_at: 'now' }; },
  async getRun() { return undefined; },
  async listRuns() { return []; },
  async updateRun() {},
  async listStudioAppSummaries() { return []; },
  async createAppReview(input) { return input; },
  async getAppReview() { return undefined; },
  async listAppReviews() { return []; },
  async updateAppReview() { return undefined; },
  async deleteAppReview() { return false; },
  async createRunThread(input) { return { id: input.id, title: input.title || null, created_at: 'now', updated_at: 'now' }; },
  async getRunThread() { return undefined; },
  async listRunTurns() { return []; },
  async appendRunTurn(input) { return { ...input, turn_index: 0, created_at: 'now' }; },
  async updateRunThread() { return undefined; },
  async createAgentToken(input) { return input; },
  async listAgentTokensForUser() { return []; },
  async getAgentTokenForUser() { return undefined; },
  async revokeAgentTokenForUser() { return undefined; },
  async createJob(input) { return { ...input, attempts: 0, status: input.status || 'queued', created_at: 'now', started_at: null, finished_at: null }; },
  async getJob() { return undefined; },
  async claimNextJob() { return undefined; },
  async updateJob() {},
  async getWorkspace() { return undefined; },
  async getWorkspaceBySlug() { return undefined; },
  async createWorkspace(input) { return { ...input, wrapped_dek: null, created_at: 'now' }; },
  async updateWorkspace() { return undefined; },
  async deleteWorkspace() { return false; },
  async listWorkspacesForUser() { return []; },
  async addUserToWorkspace(workspace_id, user_id, role) { return { workspace_id, user_id, role, joined_at: 'now' }; },
  async updateWorkspaceMemberRole() { return undefined; },
  async removeUserFromWorkspace() { return false; },
  async getWorkspaceMemberRole() { return null; },
  async countWorkspaceAdmins() { return 0; },
  async listWorkspaceMembers() { return []; },
  async getActiveWorkspaceId() { return null; },
  async setActiveWorkspace() {},
  async clearActiveWorkspaceForWorkspace() {},
  async createWorkspaceInvite(input) { return { ...input, created_at: 'now', accepted_at: null }; },
  async getPendingWorkspaceInviteByToken() { return undefined; },
  async listWorkspaceInvites() { return []; },
  async deletePendingWorkspaceInvites() { return 0; },
  async markWorkspaceInviteStatus() {},
  async acceptWorkspaceInvite() {},
  async revokeWorkspaceInvite() { return false; },
  async getUser() { return undefined; },
  async getUserByEmail() { return undefined; },
  async findUserByUsername() { return undefined; },
  async searchUsers() { return []; },
  async createUser(input) { return { ...input, created_at: 'now' }; },
  async upsertUser(input) { return { ...input, created_at: 'now' }; },
  async getAppMemory() { return undefined; },
  async upsertAppMemory(input) { return { ...input, updated_at: 'now' }; },
  async deleteAppMemory() { return false; },
  async listAppMemory() { return []; },
  async listConnections() { return []; },
  async getConnection() { return undefined; },
  async getConnectionByOwnerProvider() { return undefined; },
  async getConnectionByOwnerComposioId() { return undefined; },
  async upsertConnection(input) { return { ...input, created_at: 'now', updated_at: 'now' }; },
  async updateConnection() { return undefined; },
  async deleteConnection() { return false; },
  async getLinkShareByAppSlug() { return undefined; },
  async updateAppSharing() { return undefined; },
  async createVisibilityAudit(input) { return { ...input, created_at: 'now' }; },
  async listVisibilityAudit() { return []; },
  async listAppInvites() { return []; },
  async upsertAppInvite(input) { return { ...input, created_at: 'now', accepted_at: null, revoked_at: null }; },
  async revokeAppInvite() { return undefined; },
  async acceptAppInvite() { return { invite: undefined, changed: false }; },
  async declineAppInvite() { return undefined; },
  async linkPendingEmailAppInvites() { return 0; },
  async listPendingAppInvitesForUser() { return []; },
  async userHasAcceptedAppInvite() { return false; },
  async createTrigger(input) { return input; },
  async getTrigger() { return undefined; },
  async getTriggerByWebhookPath() { return undefined; },
  async listTriggersForUser() { return []; },
  async listTriggersForApp() { return []; },
  async listDueTriggers() { return []; },
  async updateTrigger() { return undefined; },
  async deleteTrigger() { return false; },
  async markTriggerFired() {},
  async advanceTriggerSchedule() { return false; },
  async recordTriggerWebhookDelivery() { return false; },
  async listAdminSecrets() { return []; },
  async upsertAdminSecret() {},
  async deleteAdminSecret() { return false; },
  async getEncryptedSecret() { return undefined; },
  async setEncryptedSecret() {},
  async listEncryptedSecrets() { return []; },
  async deleteEncryptedSecret() { return false; },
};

for (const method of ${JSON.stringify(missingMethods)}) {
  delete adapter[method];
}

export default {
  kind: ${JSON.stringify(kind)},
  name: 'tmp-storage',
  protocolVersion: ${JSON.stringify(protocolVersion)},
  adapter,
};
`;
}

writeFileSync(join(tmp, 'tmp-mock-storage.mjs'), storageModuleSource());
writeFileSync(
  join(tmp, 'tmp-mock-bad-kind.mjs'),
  storageModuleSource({ kind: 'runtime' }),
);
writeFileSync(
  join(tmp, 'tmp-mock-bad-version.mjs'),
  storageModuleSource({ protocolVersion: '^0.3' }),
);
writeFileSync(
  join(tmp, 'tmp-mock-missing-append-turn.mjs'),
  storageModuleSource({ missingMethods: ['appendRunTurn'] }),
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

console.log('adapter factory tests');

// ---- 1. default keys map correctly ----
log('RUNTIME_IMPLS.docker registered', typeof __testing.RUNTIME_IMPLS.docker === 'object' && __testing.RUNTIME_IMPLS.docker !== null);
log('STORAGE_IMPLS.sqlite registered', typeof __testing.STORAGE_IMPLS.sqlite === 'object' && __testing.STORAGE_IMPLS.sqlite !== null);
log('AUTH_IMPLS["better-auth"] registered', typeof __testing.AUTH_IMPLS['better-auth'] === 'object' && __testing.AUTH_IMPLS['better-auth'] !== null);
log('SECRETS_IMPLS.local registered', typeof __testing.SECRETS_IMPLS.local === 'object' && __testing.SECRETS_IMPLS.local !== null);
log('OBSERVABILITY_IMPLS.console registered', typeof __testing.OBSERVABILITY_IMPLS.console === 'object' && __testing.OBSERVABILITY_IMPLS.console !== null);

// ---- 2. unknown value throws with supported values list ----
process.env.FLOOM_RUNTIME = 'bogus';
let thrown;
try {
  await createAdapters();
} catch (e) {
  thrown = e;
}
delete process.env.FLOOM_RUNTIME;
log('unknown FLOOM_RUNTIME throws', thrown instanceof Error);
log(
  'error lists supported values (docker + proxy)',
  thrown && /docker/.test(thrown.message) && /proxy/.test(thrown.message),
  thrown && thrown.message,
);

// ---- 3. method-surface completeness under defaults ----
const bundle = await createAdapters();
log('bundle.runtime.execute is fn', typeof bundle.runtime.execute === 'function');
const storageGetAppResult = bundle.storage.getApp('__factory_missing__');
log('bundle.storage.getApp returns Promise', storageGetAppResult instanceof Promise);
await storageGetAppResult;
log('default sqlite storage passes completeness validation', typeof bundle.storage.createAgentToken === 'function');
log('bundle.storage.getEncryptedSecret is fn', typeof bundle.storage.getEncryptedSecret === 'function');
log('bundle.storage.setEncryptedSecret is fn', typeof bundle.storage.setEncryptedSecret === 'function');
log('bundle.storage.listEncryptedSecrets is fn', typeof bundle.storage.listEncryptedSecrets === 'function');
log('bundle.storage.deleteEncryptedSecret is fn', typeof bundle.storage.deleteEncryptedSecret === 'function');
log('bundle.auth.getSession is fn', typeof bundle.auth.getSession === 'function');
log('bundle.secrets.get is fn', typeof bundle.secrets.get === 'function');
log('bundle.observability.increment is fn', typeof bundle.observability.increment === 'function');

__testing.STORAGE_IMPLS['static-missing-one'] = { ...__testing.STORAGE_IMPLS.sqlite };
delete __testing.STORAGE_IMPLS['static-missing-one'].appendRunTurn;
process.env.FLOOM_STORAGE = 'static-missing-one';
let staticMissingOneError;
try {
  await createAdapters();
} catch (e) {
  staticMissingOneError = e;
}
delete process.env.FLOOM_STORAGE;
delete __testing.STORAGE_IMPLS['static-missing-one'];
log(
  'static storage adapter missing one method throws with method name',
  staticMissingOneError instanceof Error &&
    /missing required methods: appendRunTurn/.test(staticMissingOneError.message) &&
    /Required:/.test(staticMissingOneError.message),
  staticMissingOneError instanceof Error ? staticMissingOneError.message : String(staticMissingOneError),
);

__testing.STORAGE_IMPLS['static-missing-many'] = { ...__testing.STORAGE_IMPLS.sqlite };
delete __testing.STORAGE_IMPLS['static-missing-many'].appendRunTurn;
delete __testing.STORAGE_IMPLS['static-missing-many'].createAgentToken;
process.env.FLOOM_STORAGE = 'static-missing-many';
let staticMissingManyError;
try {
  await createAdapters();
} catch (e) {
  staticMissingManyError = e;
}
delete process.env.FLOOM_STORAGE;
delete __testing.STORAGE_IMPLS['static-missing-many'];
log(
  'static storage adapter missing multiple methods names all',
  staticMissingManyError instanceof Error &&
    /appendRunTurn/.test(staticMissingManyError.message) &&
    /createAgentToken/.test(staticMissingManyError.message),
  staticMissingManyError instanceof Error ? staticMissingManyError.message : String(staticMissingManyError),
);

// ---- 4. protocol version compatibility ----
__testing.RUNTIME_MODULE_EXPORTS.docker = {
  name: 'docker',
  protocolVersion: '^0.2',
};
let compatibleRangeError;
try {
  await createAdapters();
} catch (e) {
  compatibleRangeError = e;
}
log('compatible protocol range (^0.2) loads', compatibleRangeError === undefined);

__testing.RUNTIME_MODULE_EXPORTS.docker = {
  name: 'docker',
  protocolVersion: '^0.3',
};
let incompatibleRangeError;
try {
  await createAdapters();
} catch (e) {
  incompatibleRangeError = e;
}
log(
  'incompatible protocol range throws with both versions',
  incompatibleRangeError instanceof Error &&
    incompatibleRangeError.message.includes('"^0.3"') &&
    incompatibleRangeError.message.includes(`"${FLOOM_PROTOCOL_VERSION}"`),
  incompatibleRangeError instanceof Error ? incompatibleRangeError.message : String(incompatibleRangeError),
);

__testing.RUNTIME_MODULE_EXPORTS.docker = undefined;
let missingFieldError;
try {
  await createAdapters();
} catch (e) {
  missingFieldError = e;
}
log('missing protocolVersion is back-compatible', missingFieldError === undefined);

// ---- 5. dynamic import() module loading ----
process.env.FLOOM_RUNTIME = 'docker';
process.env.FLOOM_STORAGE = 'sqlite';
process.env.FLOOM_AUTH = 'better-auth';
process.env.FLOOM_SECRETS = 'local';
process.env.FLOOM_OBSERVABILITY = 'console';
let inTreeError;
try {
  await createAdapters();
} catch (e) {
  inTreeError = e;
}
for (const k of [
  'FLOOM_RUNTIME',
  'FLOOM_STORAGE',
  'FLOOM_AUTH',
  'FLOOM_SECRETS',
  'FLOOM_OBSERVABILITY',
]) {
  delete process.env[k];
}
log('all explicit in-tree adapter keys still load', inTreeError === undefined);

process.env.FLOOM_STORAGE = './tmp-mock-storage.mjs';
let dynamicBundle;
let dynamicLoadError;
try {
  dynamicBundle = await createAdapters();
} catch (e) {
  dynamicLoadError = e;
}
log(
  'FLOOM_STORAGE=./tmp-mock-storage.mjs loads via import()',
  dynamicLoadError === undefined &&
    dynamicBundle &&
    typeof dynamicBundle.storage.getApp === 'function',
  dynamicLoadError instanceof Error ? dynamicLoadError.message : String(dynamicLoadError),
);

process.env.FLOOM_STORAGE = './tmp-mock-missing-append-turn.mjs';
let dynamicMissingMethodError;
try {
  await createAdapters();
} catch (e) {
  dynamicMissingMethodError = e;
}
log(
  'dynamic storage adapter missing method is caught',
  dynamicMissingMethodError instanceof Error &&
    /tmp-storage/.test(dynamicMissingMethodError.message) &&
    /missing required methods: appendRunTurn/.test(dynamicMissingMethodError.message),
  dynamicMissingMethodError instanceof Error ? dynamicMissingMethodError.message : String(dynamicMissingMethodError),
);

process.env.FLOOM_STORAGE = './tmp-mock-bad-kind.mjs';
let badKindError;
try {
  await createAdapters();
} catch (e) {
  badKindError = e;
}
log(
  'dynamic storage adapter kind mismatch throws',
  badKindError instanceof Error && /kind mismatch/.test(badKindError.message),
  badKindError instanceof Error ? badKindError.message : String(badKindError),
);

process.env.FLOOM_STORAGE = './tmp-mock-bad-version.mjs';
let badVersionError;
try {
  await createAdapters();
} catch (e) {
  badVersionError = e;
}
log(
  'dynamic storage adapter version mismatch throws with both versions',
  badVersionError instanceof Error &&
    badVersionError.message.includes('"^0.3"') &&
    badVersionError.message.includes(`"${FLOOM_PROTOCOL_VERSION}"`),
  badVersionError instanceof Error ? badVersionError.message : String(badVersionError),
);

process.env.FLOOM_STORAGE = './does-not-exist.mjs';
let importFailureError;
try {
  await createAdapters();
} catch (e) {
  importFailureError = e;
}
log(
  'dynamic storage adapter import failure is descriptive',
  importFailureError instanceof Error &&
    /failed to import storage adapter/.test(importFailureError.message) &&
    /does-not-exist/.test(importFailureError.message),
  importFailureError instanceof Error ? importFailureError.message : String(importFailureError),
);
delete process.env.FLOOM_STORAGE;

// ---- cleanup ----
process.chdir(originalCwd);
rmSync(tmp, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

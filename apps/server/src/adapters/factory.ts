// Adapter factory: env-var driven module selection.
//
// First step toward the "replaceable modules / real protocol" initiative
// (protocol-v0.2 branch). The factory reads five env vars at boot and
// returns a bundle of adapter instances; `src/index.ts` wires it as a
// module-level singleton.
//
// Goals:
//   1. Zero behavior change under default configuration. Every env var
//      defaults to the value the reference server has been using all
//      along (docker + sqlite + better-auth + local secrets + console
//      observability).
//   2. Typed swap surface. Alternate implementations (Postgres storage,
//      Kubernetes runtime, Vault secrets, OpenTelemetry observability,
//      etc.) only need to conform to the interface in `adapters/types.ts`
//      and register a case below.
//   3. Fail fast on misconfiguration. An unknown env-var value throws at
//      boot with the list of supported values so a typo is caught
//      before any request is served.
//
// Values without module markers use the static in-tree registry below.
// Values starting with "@" or containing "/" are loaded dynamically via
// import() at boot and validated before the server starts.
//
// Follow-on work: migrate the 50+ existing direct-import call sites in
// `routes/*` and `services/*` to read from the module-level `adapters`
// singleton. That is the first PR Pallavi (or any external contributor)
// will land on this branch.

import type {
  AuthAdapter,
  ObservabilityAdapter,
  RuntimeAdapter,
  SecretsAdapter,
  StorageAdapter,
} from './types.js';
import semver from 'semver';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { dockerRuntimeAdapter } from './runtime-docker.js';
import { proxyRuntimeAdapter } from './runtime-proxy.js';
import { sqliteStorageAdapter } from './storage-sqlite.js';
import { betterAuthAdapter } from './auth-better-auth.js';
import { localSecretsAdapter } from './secrets-local.js';
import { consoleObservabilityAdapter } from './observability-console.js';
import { FLOOM_PROTOCOL_VERSION } from './version.js';

export interface AdapterBundle {
  runtime: RuntimeAdapter;
  storage: StorageAdapter;
  auth: AuthAdapter;
  secrets: SecretsAdapter;
  observability: ObservabilityAdapter;
}

type AdapterKind = keyof AdapterBundle;

interface AdapterModuleExport<T = unknown> {
  kind?: unknown;
  name?: unknown;
  protocolVersion?: unknown;
  adapter?: T;
  create?: unknown;
}

type AdapterCreateOptions = Record<string, unknown> & {
  storage?: StorageAdapter;
};

const REQUIRED_METHODS: Record<AdapterKind, readonly string[]> = {
  runtime: ['execute'],
  storage: [
    'getApp',
    'getAppById',
    'listApps',
    'createApp',
    'updateApp',
    'deleteApp',
    'createRun',
    'getRun',
    'listRuns',
    'updateRun',
    'listStudioAppSummaries',
    'createAppReview',
    'getAppReview',
    'listAppReviews',
    'updateAppReview',
    'deleteAppReview',
    'createRunThread',
    'getRunThread',
    'listRunTurns',
    'appendRunTurn',
    'updateRunThread',
    'createAgentToken',
    'listAgentTokensForUser',
    'getAgentTokenForUser',
    'revokeAgentTokenForUser',
    'createJob',
    'getJob',
    'listJobs',
    'claimJob',
    'claimNextJob',
    'updateJob',
    'markJobComplete',
    'markJobFailed',
    'cancelJob',
    'getWorkspace',
    'getWorkspaceBySlug',
    'createWorkspace',
    'updateWorkspace',
    'deleteWorkspace',
    'listWorkspacesForUser',
    'addUserToWorkspace',
    'updateWorkspaceMemberRole',
    'removeUserFromWorkspace',
    'getWorkspaceMemberRole',
    'countWorkspaceAdmins',
    'listWorkspaceMembers',
    'getActiveWorkspaceId',
    'setActiveWorkspace',
    'clearActiveWorkspaceForWorkspace',
    'createWorkspaceInvite',
    'getPendingWorkspaceInviteByToken',
    'listWorkspaceInvites',
    'deletePendingWorkspaceInvites',
    'markWorkspaceInviteStatus',
    'acceptWorkspaceInvite',
    'revokeWorkspaceInvite',
    'getUser',
    'getUserByEmail',
    'findUserByUsername',
    'searchUsers',
    'createUser',
    'upsertUser',
    'getAppMemory',
    'upsertAppMemory',
    'deleteAppMemory',
    'listAppMemory',
    'listConnections',
    'getConnection',
    'getConnectionByOwnerProvider',
    'getConnectionByOwnerComposioId',
    'upsertConnection',
    'updateConnection',
    'deleteConnection',
    'getLinkShareByAppSlug',
    'updateAppSharing',
    'createVisibilityAudit',
    'listVisibilityAudit',
    'listAppInvites',
    'upsertAppInvite',
    'revokeAppInvite',
    'acceptAppInvite',
    'declineAppInvite',
    'linkPendingEmailAppInvites',
    'listPendingAppInvitesForUser',
    'userHasAcceptedAppInvite',
    'createTrigger',
    'getTrigger',
    'getTriggerByWebhookPath',
    'listTriggersForUser',
    'listTriggersForApp',
    'listDueTriggers',
    'updateTrigger',
    'deleteTrigger',
    'markTriggerFired',
    'advanceTriggerSchedule',
    'recordTriggerWebhookDelivery',
    'listAdminSecrets',
    'upsertAdminSecret',
    'deleteAdminSecret',
    'getEncryptedSecret',
    'setEncryptedSecret',
    'listEncryptedSecrets',
    'deleteEncryptedSecret',
  ],
  auth: ['getSession', 'signIn', 'signUp', 'signOut', 'onUserDelete'],
  secrets: [
    'get',
    'set',
    'delete',
    'list',
    'setAdminSecret',
    'getAdminSecret',
    'listAdminSecrets',
    'deleteAdminSecret',
    'setCreatorPolicy',
    'getCreatorPolicy',
    'listCreatorPolicies',
    'deleteCreatorPolicy',
    'loadUserVaultForRun',
    'loadCreatorOverrideForRun',
    'setCreatorOverrideSecret',
    'getCreatorOverrideSecret',
    'listCreatorOverrideSecretsForRun',
    'deleteCreatorOverrideSecret',
  ],
  observability: ['captureError', 'increment', 'timing', 'gauge'],
};

const RUNTIME_IMPLS: Record<string, RuntimeAdapter> = {
  docker: dockerRuntimeAdapter,
  proxy: proxyRuntimeAdapter,
};
const RUNTIME_MODULE_EXPORTS: Record<string, AdapterModuleExport | undefined> = {
  docker: undefined,
  proxy: undefined,
};

const STORAGE_IMPLS: Record<string, StorageAdapter> = {
  sqlite: sqliteStorageAdapter,
};
const STORAGE_MODULE_EXPORTS: Record<string, AdapterModuleExport | undefined> = {
  sqlite: undefined,
};

const AUTH_IMPLS: Record<string, AuthAdapter> = {
  'better-auth': betterAuthAdapter,
};
const AUTH_MODULE_EXPORTS: Record<string, AdapterModuleExport | undefined> = {
  'better-auth': undefined,
};

const SECRETS_IMPLS: Record<string, SecretsAdapter> = {
  local: localSecretsAdapter,
};
const SECRETS_MODULE_EXPORTS: Record<string, AdapterModuleExport | undefined> = {
  local: undefined,
};

const OBSERVABILITY_IMPLS: Record<string, ObservabilityAdapter> = {
  console: consoleObservabilityAdapter,
};
const OBSERVABILITY_MODULE_EXPORTS: Record<
  string,
  AdapterModuleExport | undefined
> = {
  console: undefined,
};

function assertProtocolVersionCompatibility(
  kind: string,
  key: string,
  moduleExport: AdapterModuleExport | undefined,
): void {
  const declaredRange = moduleExport?.protocolVersion;
  if (typeof declaredRange !== 'string' || declaredRange.length === 0) return;
  let compatible = false;
  try {
    compatible = semver.satisfies(FLOOM_PROTOCOL_VERSION, declaredRange);
  } catch {
    compatible = false;
  }
  if (!compatible) {
    const adapterName =
      typeof moduleExport?.name === 'string' && moduleExport.name.length > 0
        ? moduleExport.name
        : key;
    throw new Error(
      `[adapters] adapter '${adapterName}' (kind=${kind}) declares protocolVersion=${JSON.stringify(
        declaredRange,
      )} which is incompatible with server FLOOM_PROTOCOL_VERSION=${JSON.stringify(
        FLOOM_PROTOCOL_VERSION,
      )}`,
    );
  }
}

function isDynamicSpecifier(value: string): boolean {
  return value.startsWith('@') || value.includes('/');
}

function importTargetFor(value: string): string {
  if (value.startsWith('file:')) return value;
  if (value.startsWith('./') || value.startsWith('../')) {
    return pathToFileURL(resolve(process.cwd(), value)).href;
  }
  if (isAbsolute(value)) return pathToFileURL(value).href;
  return value;
}

function adapterName(
  moduleExport: AdapterModuleExport | undefined,
  fallback: string,
): string {
  return typeof moduleExport?.name === 'string' && moduleExport.name.length > 0
    ? moduleExport.name
    : fallback;
}

function assertAdapterSurface(
  kind: AdapterKind,
  key: string,
  moduleExport: AdapterModuleExport | undefined,
  adapter: unknown,
): void {
  if (typeof adapter !== 'object' || adapter === null) {
    throw new Error(
      `[adapters] adapter '${adapterName(
        moduleExport,
        key,
      )}' (kind=${kind}) is missing an adapter object`,
    );
  }

  const required = REQUIRED_METHODS[kind];
  const missing = required.filter(
    (method) =>
      typeof (adapter as Record<string, unknown>)[method] !== 'function',
  );
  if (missing.length > 0) {
    throw new Error(
      `[adapters] adapter '${adapterName(
        moduleExport,
        key,
      )}' (kind=${kind}) is missing required methods: ${missing.join(', ')}. ` +
        `Required: ${required.join(', ')}`,
    );
  }
}

async function validateDynamicModule<T>(
  kind: AdapterKind,
  key: string,
  moduleExport: unknown,
  createOptions: AdapterCreateOptions = {},
): Promise<T> {
  if (typeof moduleExport !== 'object' || moduleExport === null) {
    throw new Error(
      `[adapters] ${kind} adapter module ${JSON.stringify(
        key,
      )} is missing a default export object`,
    );
  }

  const typed = moduleExport as AdapterModuleExport<T>;
  if (typed.kind !== kind) {
    throw new Error(
      `[adapters] kind mismatch for ${kind} adapter ${JSON.stringify(
        key,
      )}: expected ${JSON.stringify(kind)}, got ${JSON.stringify(typed.kind)}`,
    );
  }

  if (
    typeof typed.protocolVersion !== 'string' ||
    typed.protocolVersion.length === 0
  ) {
    throw new Error(
      `[adapters] adapter '${adapterName(
        typed,
        key,
      )}' (kind=${kind}) is missing protocolVersion`,
    );
  }

  assertProtocolVersionCompatibility(kind, key, typed);
  if (typed.adapter !== undefined) {
    assertAdapterSurface(kind, key, typed, typed.adapter);
    return typed.adapter as T;
  }
  if (typeof typed.create === 'function') {
    const adapter = await (typed.create as (opts: AdapterCreateOptions) => unknown)(
      createOptions,
    );
    assertAdapterSurface(kind, key, typed, adapter);
    return adapter as T;
  }
  throw new Error(
    `[adapters] adapter '${adapterName(
      typed,
      key,
    )}' (kind=${kind}) is missing an adapter object or create function`,
  );
}

async function importDynamicAdapter<T>(
  kind: AdapterKind,
  env: string,
  value: string,
  createOptions: AdapterCreateOptions = {},
): Promise<T> {
  try {
    const imported = (await import(importTargetFor(value))) as {
      default?: unknown;
    };
    if (!('default' in imported)) {
      throw new Error(
        `[adapters] ${kind} adapter module ${JSON.stringify(
          value,
        )} is missing a default export`,
      );
    }
    return await validateDynamicModule<T>(kind, value, imported.default, createOptions);
  } catch (e) {
    if (
      e instanceof Error &&
      (e.message.includes('kind mismatch') ||
        e.message.includes('protocolVersion') ||
        e.message.includes('missing required methods') ||
        e.message.includes('missing an adapter object') ||
        e.message.includes('missing an adapter object or create function') ||
        e.message.includes('missing a default export'))
    ) {
      throw e;
    }
    const message = e instanceof Error ? e.message : String(e);
    throw new Error(
      `[adapters] failed to import ${kind} adapter from ${env}=${JSON.stringify(
        value,
      )}: ${message}`,
      { cause: e },
    );
  }
}

async function pick<T>(
  kind: AdapterKind,
  env: string,
  value: string,
  defaultKey: string,
  registry: Record<string, T>,
  moduleExports: Record<string, AdapterModuleExport | undefined>,
  createOptions: AdapterCreateOptions = {},
): Promise<T> {
  const effective = value || defaultKey;
  if (isDynamicSpecifier(effective)) {
    return importDynamicAdapter<T>(kind, env, effective, createOptions);
  }

  const impl = registry[effective];
  if (!impl) {
    const supported = Object.keys(registry).sort().join(', ');
    throw new Error(
      `[adapters] unknown ${kind} adapter: ${env}=${JSON.stringify(value)}. ` +
        `Supported values: ${supported}. Default: ${defaultKey}.`,
    );
  }
  assertProtocolVersionCompatibility(kind, effective, moduleExports[effective]);
  assertAdapterSurface(kind, effective, moduleExports[effective], impl);
  return impl;
}

function magicLinkAuthFactoryOptions(storage: StorageAdapter): AdapterCreateOptions {
  const conformanceMagicLink =
    process.env.FLOOM_CONFORMANCE_CONCERN === 'auth' &&
    (process.env.FLOOM_AUTH_MODE === 'magic-link' ||
      (process.env.FLOOM_CONFORMANCE_ADAPTER || '').includes('auth-magic-link'));
  return {
    storage,
    resendApiKey:
      process.env.FLOOM_AUTH_RESEND_API_KEY ||
      process.env.RESEND_API_KEY ||
      (conformanceMagicLink ? 'test-resend-api-key' : ''),
    fromEmail:
      process.env.FLOOM_AUTH_FROM_EMAIL ||
      process.env.FLOOM_FROM_EMAIL ||
      'Floom <login@floom.dev>',
    jwtSecret:
      process.env.FLOOM_AUTH_JWT_SECRET ||
      process.env.BETTER_AUTH_SECRET ||
      process.env.FLOOM_MASTER_KEY ||
      (conformanceMagicLink ? 'test-magic-link-jwt-secret' : ''),
    jwtIssuer: process.env.FLOOM_AUTH_JWT_ISSUER || 'floom',
    baseUrl:
      process.env.FLOOM_APP_URL ||
      process.env.BETTER_AUTH_URL ||
      process.env.PUBLIC_URL ||
      'http://localhost:3051',
    sendEmail:
      process.env.FLOOM_AUTH_MAGIC_LINK_SEND === 'false'
        ? false
        : !conformanceMagicLink,
    exposeTokenForTests:
      process.env.FLOOM_AUTH_MAGIC_LINK_EXPOSE_TOKEN === 'true' ||
      conformanceMagicLink,
  };
}

async function readyAdapter(kind: AdapterKind, adapter: AdapterBundle[AdapterKind]): Promise<void> {
  if (typeof adapter.ready !== 'function') return;
  try {
    await adapter.ready();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`[adapters] ${kind} adapter ready() failed: ${message}`, {
      cause: err,
    });
  }
}

export async function createAdapters(): Promise<AdapterBundle> {
  const runtime = await pick(
    'runtime',
    'FLOOM_RUNTIME',
    process.env.FLOOM_RUNTIME || '',
    'docker',
    RUNTIME_IMPLS,
    RUNTIME_MODULE_EXPORTS,
  );
  const storage = await pick(
    'storage',
    'FLOOM_STORAGE',
    process.env.FLOOM_STORAGE || '',
    'sqlite',
    STORAGE_IMPLS,
    STORAGE_MODULE_EXPORTS,
  );
  const auth = await pick(
    'auth',
    'FLOOM_AUTH',
    process.env.FLOOM_AUTH || '',
    'better-auth',
    AUTH_IMPLS,
    AUTH_MODULE_EXPORTS,
    magicLinkAuthFactoryOptions(storage),
  );
  const secrets = await pick(
    'secrets',
    'FLOOM_SECRETS',
    process.env.FLOOM_SECRETS || '',
    'local',
    SECRETS_IMPLS,
    SECRETS_MODULE_EXPORTS,
    { storage },
  );
  const observability = await pick(
    'observability',
    'FLOOM_OBSERVABILITY',
    process.env.FLOOM_OBSERVABILITY || '',
    'console',
    OBSERVABILITY_IMPLS,
    OBSERVABILITY_MODULE_EXPORTS,
  );

  const bundle = { runtime, storage, auth, secrets, observability };
  for (const [kind, adapter] of Object.entries(bundle) as Array<
    [AdapterKind, AdapterBundle[AdapterKind]]
  >) {
    await readyAdapter(kind, adapter);
  }
  return bundle;
}

// --- test-only registry peek ------------------------------------------------
// Exposed so a unit test can assert "docker is the default when FLOOM_RUNTIME
// is unset". Keep this internal; route code should read the module-level
// `adapters` singleton exported from `src/index.ts`, not call the factory.
export const __testing = {
  RUNTIME_IMPLS,
  STORAGE_IMPLS,
  AUTH_IMPLS,
  SECRETS_IMPLS,
  OBSERVABILITY_IMPLS,
  RUNTIME_MODULE_EXPORTS,
  STORAGE_MODULE_EXPORTS,
  AUTH_MODULE_EXPORTS,
  SECRETS_MODULE_EXPORTS,
  OBSERVABILITY_MODULE_EXPORTS,
  REQUIRED_METHODS,
};

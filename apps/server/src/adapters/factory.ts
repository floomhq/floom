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
// Selection is compile-time-only in this PR. The five concrete
// implementations are already compiled into the binary; the env var
// only picks which one the factory returns. Dynamic plugin loading
// (import-from-disk, registry-based) is out of scope.
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

interface AdapterModuleExport {
  name?: string;
  protocolVersion?: string;
}

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
  if (!declaredRange) return;
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

function pick<T>(
  kind: string,
  env: string,
  value: string,
  defaultKey: string,
  registry: Record<string, T>,
  moduleExports: Record<string, AdapterModuleExport | undefined>,
): T {
  const effective = value || defaultKey;
  const impl = registry[effective];
  if (!impl) {
    const supported = Object.keys(registry).sort().join(', ');
    throw new Error(
      `[adapters] unknown ${kind} adapter: ${env}=${JSON.stringify(value)}. ` +
        `Supported values: ${supported}. Default: ${defaultKey}.`,
    );
  }
  assertProtocolVersionCompatibility(kind, effective, moduleExports[effective]);
  return impl;
}

export function createAdapters(): AdapterBundle {
  const runtime = pick(
    'runtime',
    'FLOOM_RUNTIME',
    process.env.FLOOM_RUNTIME || '',
    'docker',
    RUNTIME_IMPLS,
    RUNTIME_MODULE_EXPORTS,
  );
  const storage = pick(
    'storage',
    'FLOOM_STORAGE',
    process.env.FLOOM_STORAGE || '',
    'sqlite',
    STORAGE_IMPLS,
    STORAGE_MODULE_EXPORTS,
  );
  const auth = pick(
    'auth',
    'FLOOM_AUTH',
    process.env.FLOOM_AUTH || '',
    'better-auth',
    AUTH_IMPLS,
    AUTH_MODULE_EXPORTS,
  );
  const secrets = pick(
    'secrets',
    'FLOOM_SECRETS',
    process.env.FLOOM_SECRETS || '',
    'local',
    SECRETS_IMPLS,
    SECRETS_MODULE_EXPORTS,
  );
  const observability = pick(
    'observability',
    'FLOOM_OBSERVABILITY',
    process.env.FLOOM_OBSERVABILITY || '',
    'console',
    OBSERVABILITY_IMPLS,
    OBSERVABILITY_MODULE_EXPORTS,
  );

  return { runtime, storage, auth, secrets, observability };
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
};

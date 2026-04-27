# Adapter factory (protocol-v0.2)

Floom's server is built out of five pluggable concerns: **runtime**, **storage**, **auth**, **secrets**, **observability**. The interface contracts for each one live in [`@floom/adapter-types`](../packages/adapter-types/src/index.ts); [`apps/server/src/adapters/types.ts`](../apps/server/src/adapters/types.ts) remains as a compatibility re-export for in-repo imports. For the protocol-level rationale and per-method semantics, read [`spec/adapters.md`](../spec/adapters.md).

This doc is about the **factory** that wires them.

## What the factory does

At boot, `createAdapters()` in [`apps/server/src/adapters/factory.ts`](../apps/server/src/adapters/factory.ts) reads five env vars, resolves each one through the in-tree registry or dynamic `import()`, and returns an `AdapterBundle { runtime, storage, auth, secrets, observability }`. The bundle is exposed as a module-level singleton from [`apps/server/src/adapters/index.ts`](../apps/server/src/adapters/index.ts):

```ts
import { adapters } from '../adapters/index.js';

// Every route / service can read from the bundle without knowing which
// concrete implementation is active.
adapters.observability.increment('health.check');
const app = adapters.storage.getApp('lead-scorer');
```

Zero behavior change under the default configuration. Every env var defaults to the impl the reference server has been using all along. Unknown in-tree values throw at boot with a list of supported values; package/path import failures and adapter metadata mismatches also halt boot before any request is served.

## Supported values per env var

| Env var                  | Default        | Built-in keys | First-party package adapters |
|--------------------------|----------------|---------------|------------------------------|
| `FLOOM_RUNTIME`          | `docker`       | `docker`, `proxy` | none shipped in v0.2 |
| `FLOOM_STORAGE`          | `sqlite`       | `sqlite` | `@floomhq/storage-postgres` |
| `FLOOM_AUTH`             | `better-auth`  | `better-auth` | `@floomhq/auth-magic-link` |
| `FLOOM_SECRETS`          | `local`        | `local` | `@floomhq/secrets-gcp-kms` |
| `FLOOM_OBSERVABILITY`    | `console`      | `console` | `@floomhq/observability-otel` |

The first-party package adapters live under [`packages`](../packages). They are workspace packages in this repo; npm publication ships with the v0.5 release, and the structure is ready today. The OpenTelemetry adapter stays out of `@floom/server` dependencies; install or build it only on deployments that export to an OTLP collector.

Values starting with `@` or containing `/` are treated as third-party module specifiers and loaded with dynamic `import()` at boot:

```bash
FLOOM_STORAGE=@floom-community/storage-postgres
FLOOM_STORAGE=./local-adapters/storage-postgres.js
```

## Status today

Protocol v0.2 wires the adapter bundle through the factory and the exported `adapters` singleton. The shipped state is:

- `FLOOM_PROTOCOL_VERSION` is `0.2.0` in [`apps/server/src/adapters/version.ts`](../apps/server/src/adapters/version.ts), and the shared type surface is the `@floom/adapter-types` workspace package at [`packages/adapter-types`](../packages/adapter-types).
- Runtime is closed for P0 #1: run dispatch uses `adapters.runtime.execute`.
- Auth is closed for P0 #2: request session resolution uses `adapters.auth.getSession`.
- Storage is closed for P0 #4: `StorageAdapter` covers workspaces, users, OAuth connections, app sharing, triggers, app memory, run threads, run turns, jobs, admin secret pointers, and encrypted secret rows, and the jobs queue service uses the storage adapter rather than direct SQLite helpers.
- Secrets are closed for P0 #3: run secret resolution, user-facing secret routes, BYOK quota checks, and docker-image ingest use async `adapters.secrets` methods.
- Observability is closed: server health and metrics paths emit through `adapters.observability`.
- The P1 hardening set is nearly closed: `ctx?: SessionContext` tenant scoping, lifecycle hooks (`ready`, `health`, `close`), boot-time adapter surface validation, and SIGINT/SIGTERM close wiring are implemented.
- The conformance runner lives at [`packages/conformance-runner`](../packages/conformance-runner), and all five per-concern suites live at `test/stress/test-adapters-<concern>-contract.mjs`.
- First-party optional adapter packages are present for Postgres storage, magic-link auth, GCP KMS secrets, and OpenTelemetry observability.

## Known limitations / out-of-scope

- npm publication of first-party packages is deferred to the v0.5 release; the repo currently consumes them as workspace packages.
- Community adapter releases under `@floom-community/*` are not shipped by this repo, although dynamic import registration is implemented.
- Docker-dependent runtime conformance assertions skip when Docker is unavailable in the CI or local host environment.
- Product-specific paths such as waitlist marketing, ops health probes, and retention sweepers intentionally bypass adapters where they are not part of the public adapter protocol; those bypasses carry local explanatory comments.

## Adding a new adapter package (3 steps)

Say you want to add a new `StorageAdapter`:

1. **Write the package.** Create an ESM package that imports the concern interface from `@floom/adapter-types` and implements every required method.
2. **Export the registration object.** Default-export `{ kind, name, protocolVersion, adapter }`, or `{ kind, name, protocolVersion, create }` when the adapter needs factory-provided dependencies such as `storage`.
3. **Run conformance and wire the env var.** Run `pnpm test:conformance --concern storage --adapter <package-or-path>`, then set `FLOOM_STORAGE=<package-or-path>` for the server process.

Adding a new built-in short key such as `FLOOM_STORAGE=my-store` is a separate server change: add the implementation to the matching registry in [`apps/server/src/adapters/factory.ts`](../apps/server/src/adapters/factory.ts) and document the key here.

## Live call sites

- [`apps/server/src/routes/health.ts`](../apps/server/src/routes/health.ts) emits `health.check` through `adapters.observability.increment(...)`.
- [`apps/server/src/services/runner.ts`](../apps/server/src/services/runner.ts) invokes `adapters.runtime.execute` and resolves run secrets through `adapters.secrets`.
- [`apps/server/src/services/session.ts`](../apps/server/src/services/session.ts) resolves request sessions through `adapters.auth.getSession`.
- Route and service migrations for storage-backed areas use `adapters.storage` for the protocol surfaces covered by the v0.2 contract.

## Writing a third-party adapter

The protocol-level contract for out-of-tree adapters lives in [`spec/adapters.md` "Third-party adapters"](../spec/adapters.md#third-party-adapters). This section is the practical cookbook: what a developer actually does to build and ship one today.

**Third-party status.** Dynamic-import registration is shipped for package and path specifiers, and the adapter contracts are available from `@floom/adapter-types`. Publish your adapter as an ESM package or point the relevant `FLOOM_<CONCERN>` env var at a local `.js` file; the stock server imports it during boot and validates its default export. Out-of-tree registration via the `@floom-community/*` naming convention works through this path; no community adapter is shipped by this repo.

### 1. Package skeleton

Create a new npm package. Recommended structure:

```
@floom-community/storage-postgres/
├── package.json
├── tsconfig.json
├── src/
│   └── index.ts
├── test/
│   └── contract.mjs
└── README.md
```

Minimum `package.json` fields:

```json
{
  "name": "@floom-community/storage-postgres",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    }
  },
  "peerDependencies": {
    "@floom/adapter-types": "^0.2"
  }
}
```

`@floom/adapter-types` follows the adapter protocol version. For protocol `0.2.0`, use the `^0.2` peer dependency range and import interfaces directly from the package.

### 2. Implement the adapter

Implement every method on the interface for your concern. Read `spec/adapters.md` first: the invariants section for each adapter is the contract. Skipping an invariant is a conformance failure even if the types compile.

Export the adapter as the default export of your module, wrapped in the registration shape:

```ts
import type { StorageAdapter } from '@floom/adapter-types';

const postgresStorageAdapter: StorageAdapter = {
  // ... every method
};

export default {
  kind: 'storage' as const,
  name: 'postgres',
  protocolVersion: '^0.2',
  adapter: postgresStorageAdapter,
};
```

Adapters that need factory-provided dependencies can export `create` instead
of a ready `adapter` object. Secrets adapters receive the selected
`storage` adapter:

```ts
export default {
  kind: 'secrets' as const,
  name: 'gcp-kms',
  protocolVersion: '^0.2',
  create: ({ storage }) => createGcpKmsSecretsAdapter({ keyName, storage }),
};
```

### 3. Run the conformance tests locally

The per-adapter contract suites live at `test/stress/test-adapters-<concern>-contract.mjs`. Use the runner from a Floom checkout so it selects your adapter through the same env var path the server uses:

```
# clone the Floom repo
git clone https://github.com/floomhq/floom.git
cd floom

pnpm install
pnpm test:conformance --concern storage --adapter /absolute/path/to/@floom-community/storage-postgres/dist/index.js
```

Concern names are `runtime`, `storage`, `auth`, `secrets`, and `observability`. The adapter value can be an in-tree key (`sqlite`, `better-auth`, `local`, `console`, `proxy`), an npm module specifier, or a local ESM file path:

```bash
pnpm test:conformance --concern storage --adapter @floom-community/storage-postgres
pnpm test:conformance --concern runtime --adapter ./local-adapters/runtime-k8s.js
```

The runner prints the suite output and exits non-zero when any assertion fails.

## Known adapters

- `@floomhq/storage-postgres`: first-party Postgres `StorageAdapter` package for protocol 0.2.
- `@floomhq/auth-magic-link`: first-party Resend-backed magic-link `AuthAdapter` package for protocol 0.2. It stores users, one-time magic-link tokens, and JWT revocations through the configured `StorageAdapter`, so auth and storage remain separate concerns.
- `@floomhq/secrets-gcp-kms`: first-party GCP Cloud KMS `SecretsAdapter` package for protocol 0.2. It uses per-secret AES-256-GCM envelope encryption and KMS-wrapped DEKs stored through `StorageAdapter` encrypted-secret rows.
- `@floomhq/observability-otel`: first-party OpenTelemetry `ObservabilityAdapter` package for protocol 0.2.

### 4. Wire it into a local Floom server

Install or build the adapter where the server process can import it, set the relevant env var, and start the stock server:

```bash
pnpm add @floom-community/storage-postgres
export FLOOM_STORAGE=@floom-community/storage-postgres
pnpm --filter @floom/server start
```

For private/internal adapters that are not published to npm, point at the built ESM file:

```bash
export FLOOM_STORAGE=./local-adapters/storage-postgres.js
pnpm --filter @floom/server start
```

### 5. Publish and announce

When your adapter is ready:

1. **Publish to npm** under the `@floom-community/` scope if you're aligning with community conventions, or your own scope if you prefer. Pin the `protocolVersion` range in your default export before publishing.
2. **Add a PR against `floomhq/floom`** adding your package to the "Known adapters" list in `docs/adapters.md`.
3. **Announce in Discord**: the Floom server at https://discord.gg/8fXGXjxcRz has a channel for community adapter releases.
4. **Keep a CHANGELOG**: downstream operators pin exact versions for supply-chain reasons (see the security note in `spec/adapters.md`). A clear changelog is what lets them upgrade.

## Current migration targets

Protocol v0.2 migration target is closed: every concern has an executable contract suite under `test/stress/test-adapters-<concern>-contract.mjs`, and the runner command above is the green-bar gate for third-party implementations.

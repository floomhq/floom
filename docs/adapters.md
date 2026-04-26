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

| Env var                  | Default        | Supported values | Lives in                                   |
|--------------------------|----------------|------------------|--------------------------------------------|
| `FLOOM_RUNTIME`          | `docker`       | `docker`, `proxy` | `adapters/runtime-docker.ts`, `adapters/runtime-proxy.ts` |
| `FLOOM_STORAGE`          | `sqlite`       | `sqlite`          | `adapters/storage-sqlite.ts`               |
| `FLOOM_AUTH`             | `better-auth`  | `better-auth`     | `adapters/auth-better-auth.ts`             |
| `FLOOM_SECRETS`          | `local`        | `local`           | `adapters/secrets-local.ts`                |
| `FLOOM_OBSERVABILITY`    | `console`      | `console`         | `adapters/observability-console.ts`        |

Values starting with `@` or containing `/` are treated as third-party module specifiers and loaded with dynamic `import()` at boot:

```bash
FLOOM_STORAGE=@floom-community/storage-postgres
FLOOM_STORAGE=./local-adapters/storage-postgres.js
```

## Adding a new in-tree adapter (3 steps)

Say you want to add a Postgres `StorageAdapter`:

1. **Write the wrapper.** Create `apps/server/src/adapters/storage-postgres.ts` that exports a `postgresStorageAdapter: StorageAdapter` conforming to the interface in `adapters/types.ts`. Use `better-sqlite3`'s schema as a reference but translate to `pg` (or your preferred driver).
2. **Register it in the factory.** In `apps/server/src/adapters/factory.ts`, add one line to `STORAGE_IMPLS`:
   ```ts
   const STORAGE_IMPLS: Record<string, StorageAdapter> = {
     sqlite: sqliteStorageAdapter,
     postgres: postgresStorageAdapter,
   };
   ```
3. **Document the env var value.** Append to the supported-values table in this doc and to the `FLOOM_STORAGE` block in `docker/.env.example`. Set `FLOOM_STORAGE=postgres` on the deployment that should use it.

That's the whole pattern. The factory picks the impl, the adapter conforms to the typed contract, the rest of the server reads from the bundle.

## What is NOT in this PR

- **Call-site migration.** Routes and services in `routes/*` and `services/*` still import `db`, `runner`, `userSecrets` directly. The adapter bundle exists and is callable, but the 50+ existing call sites are not refactored yet. That is deliberately scoped to a follow-on PR so this one can land fast.
- **New concrete adapters.** The reference impls (`docker`, `proxy`, `sqlite`, `better-auth`, `local`, `console`) remain the only in-tree registry values. First-party package adapters such as Postgres storage and magic-link auth are loaded through the same dynamic import path used by third-party adapters.

## Proof-of-pattern call site

[`apps/server/src/routes/health.ts`](../apps/server/src/routes/health.ts) emits a `health.check` counter through `adapters.observability.increment(...)` on every request. It's the minimal demonstration that the bundle is reachable from a route. Swap `FLOOM_OBSERVABILITY` once we add a second impl and the same line starts writing to OpenTelemetry / Datadog / StatsD instead of stdout, without any change in `health.ts`.

## Writing a third-party adapter

The protocol-level contract for out-of-tree adapters lives in [`spec/adapters.md` "Third-party adapters"](../spec/adapters.md#third-party-adapters). This section is the practical cookbook: what a developer actually does to build and ship one today.

**Status today.** Dynamic-import registration is shipped for package and path specifiers, and the adapter contracts are available from `@floom/adapter-types`. Publish your adapter as an ESM package or point the relevant `FLOOM_<CONCERN>` env var at a local `.js` file; the stock server imports it during boot and validates its default export.

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

### Known adapters

The known-adapters list will live here once the first out-of-tree adapter ships. Empty today.

## Current migration targets

Migration target for adapter work: every concern has an executable contract suite under `test/stress/test-adapters-<concern>-contract.mjs`, and the runner command above is the green-bar gate for third-party implementations.

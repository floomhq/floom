# Adapter factory (protocol-v0.2)

Floom's server is built out of five pluggable concerns: **runtime**, **storage**, **auth**, **secrets**, **observability**. The interface contracts for each one live in [`apps/server/src/adapters/types.ts`](../apps/server/src/adapters/types.ts). For the protocol-level rationale and per-method semantics, read [`spec/adapters.md`](../spec/adapters.md).

This doc is about the **factory** that wires them.

## What the factory does

At boot, `createAdapters()` in [`apps/server/src/adapters/factory.ts`](../apps/server/src/adapters/factory.ts) reads five env vars, looks each one up in a small per-concern registry, and returns an `AdapterBundle { runtime, storage, auth, secrets, observability }`. The bundle is exposed as a module-level singleton from [`apps/server/src/adapters/index.ts`](../apps/server/src/adapters/index.ts):

```ts
import { adapters } from '../adapters/index.js';

// Every route / service can read from the bundle without knowing which
// concrete implementation is active.
adapters.observability.increment('health.check');
const app = adapters.storage.getApp('lead-scorer');
```

Zero behavior change under the default configuration. Every env var defaults to the impl the reference server has been using all along. Unknown values throw at boot with a list of supported values, so a typo surfaces before any request is served.

## Supported values per env var

| Env var                  | Default        | Supported values | Lives in                                   |
|--------------------------|----------------|------------------|--------------------------------------------|
| `FLOOM_RUNTIME`          | `docker`       | `docker`, `proxy` | `adapters/runtime-docker.ts`, `adapters/runtime-proxy.ts` |
| `FLOOM_STORAGE`          | `sqlite`       | `sqlite`          | `adapters/storage-sqlite.ts`               |
| `FLOOM_AUTH`             | `better-auth`  | `better-auth`     | `adapters/auth-better-auth.ts`             |
| `FLOOM_SECRETS`          | `local`        | `local`           | `adapters/secrets-local.ts`                |
| `FLOOM_OBSERVABILITY`    | `console`      | `console`         | `adapters/observability-console.ts`        |

## Adding a new adapter (3 steps)

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
- **New concrete adapters.** Only the reference impls (`docker`, `proxy`, `sqlite`, `better-auth`, `local`, `console`) are registered. A Postgres `StorageAdapter` is the natural next target.
- **Dynamic plugin loading.** Selection is compile-time-only. Every registered impl is compiled into the binary; the env var only picks which one the factory returns. Import-from-disk plugin registration is out of scope.

## Proof-of-pattern call site

[`apps/server/src/routes/health.ts`](../apps/server/src/routes/health.ts) emits a `health.check` counter through `adapters.observability.increment(...)` on every request. It's the minimal demonstration that the bundle is reachable from a route. Swap `FLOOM_OBSERVABILITY` once we add a second impl and the same line starts writing to OpenTelemetry / Datadog / StatsD instead of stdout, without any change in `health.ts`.

## Writing a third-party adapter

The protocol-level contract for out-of-tree adapters lives in [`spec/adapters.md` "Third-party adapters"](../spec/adapters.md#third-party-adapters). This section is the practical cookbook: what a developer actually does to build and ship one today.

**Status today.** The dynamic-import registration path described in the spec is the target pattern for v0.5; it is not shipped yet. Until it lands, a third-party adapter is a local/private fork pattern: clone the Floom repo, add your module to the in-tree registry, run your server from that fork. Every section below calls out whether it works today or is planned.

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

Note: `@floom/adapter-types` is **planned for v0.5** and does not exist on npm today. Until it's published, vendor the type declarations directly from `apps/server/src/adapters/types.ts` in the `floomhq/floom` repo, or import them via a git dependency:

```json
{
  "peerDependencies": {
    "floom": "github:floomhq/floom#protocol-v0.2"
  }
}
```

Then import as `import type { StorageAdapter } from 'floom/apps/server/src/adapters/types.js'` (path will shift once types are extracted into a dedicated package).

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

The per-adapter contract test suites (`test/stress/test-adapters-<name>-contract.mjs`) are **planned**; they do not ship today. The pattern they will follow:

```
# clone the Floom repo
git clone https://github.com/floomhq/floom.git
cd floom

# point the relevant env var at your local build
export FLOOM_STORAGE=/absolute/path/to/@floom-community/storage-postgres/dist/index.js

# run the contract suite for your concern
npx tsx test/stress/test-adapters-storage-contract.mjs
```

Until that suite lands, copy the assertion list from `spec/adapters.md` "Conformance tests" into a local harness in your own repo (`test/contract.mjs`) and run it against your adapter directly. The `test/stress/test-adapters-factory.mjs` file in `floomhq/floom` is the closest working reference for how to spin up an adapter instance and drive it.

### 4. Wire it into a local Floom server (today's path)

Until the dynamic-import factory lands, the working path is a local fork of `floomhq/floom`:

1. Clone `floomhq/floom`, add your adapter as a workspace dependency or vendor the source under `apps/server/src/adapters/storage-postgres.ts`.
2. In `apps/server/src/adapters/factory.ts`, import your adapter and add it to `STORAGE_IMPLS`:
   ```ts
   import { postgresStorageAdapter } from './storage-postgres.js';

   const STORAGE_IMPLS: Record<string, StorageAdapter> = {
     sqlite: sqliteStorageAdapter,
     postgres: postgresStorageAdapter,
   };
   ```
3. Set `FLOOM_STORAGE=postgres` and run the server.

Once the v0.5 dynamic-import path ships, the fork step goes away: you publish your adapter to npm, set `FLOOM_STORAGE=@floom-community/storage-postgres`, and the stock Floom server loads it at boot.

### 5. Publish and announce

When your adapter is ready:

1. **Publish to npm** under the `@floom-community/` scope if you're aligning with community conventions, or your own scope if you prefer. Pin the `protocolVersion` range in your default export before publishing.
2. **Add a PR against `floomhq/floom`** adding your package to the "Known adapters" list in `docs/adapters.md` (the list itself is planned for v0.5; until then, announce in Discord and the Floom team will surface it).
3. **Announce in Discord**: the Floom server at https://discord.gg/8fXGXjxcRz has a channel for community adapter releases.
4. **Keep a CHANGELOG**: downstream operators pin exact versions for supply-chain reasons (see the security note in `spec/adapters.md`). A clear changelog is what lets them upgrade.

### Known adapters

The known-adapters list will live here once the first out-of-tree adapter ships. Empty today.

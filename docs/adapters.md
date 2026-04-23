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

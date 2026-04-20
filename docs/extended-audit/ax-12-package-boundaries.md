# ax-12 — Package boundaries (`apps/server` ↔ `packages/*`)

**Scope:** Imports under `apps/server/src` that reference workspace packages (`@floom/*`) or monorepo-relative `packages/` paths. Map coupling to `@floom/runtime`, `@floom/detect`, `@floom/manifest`. Flag duplicated policy (especially Docker defaults) versus `packages/runtime`. **Method:** ripgrep on `apps/server/src` (2026-04-20).

**Related:** `docs/PRODUCT.md` (three surfaces, manifest model); `docs/extended-audit/INDEX.md` row 12.

---

## 1. Grep results

### `@floom/` imports

| File | Import |
|------|--------|
| `services/renderer-bundler.ts` | `import type { BundleResult, OutputShape } from '@floom/renderer/contract'` |
| `services/openapi-ingest.ts` | `import type { RendererManifest } from '@floom/renderer/contract'` |
| `routes/hub.ts` | `import type { OutputShape } from '@floom/renderer/contract'` |

No other `@floom/*` packages are imported from `apps/server/src`.

### `packages/` string imports

**None.** No `from '…/packages/…'` or similar path imports in `apps/server/src`.

### `package.json` workspace dependency

`apps/server/package.json` declares **`@floom/renderer`: `workspace:*`** only. It does **not** depend on `@floom/manifest`, `@floom/runtime`, or `@floom/detect`.

---

## 2. Coupling map (server → packages)

### 2.1 Declared dependency: `@floom/renderer`

- **Types:** `BundleResult`, `OutputShape`, `RendererManifest` from `@floom/renderer/contract` (type-only in TS; erased at emit).
- **Build-time / tooling:** `renderer-bundler.ts` configures esbuild with `external: ['@floom/renderer']` and resolves the monorepo’s `@floom/renderer` for React resolution comments describe bundling creator components without shipping the full package inside the bundle.

**Direction:** server → renderer **contract surface only** (plus esbuild treating the package as external).

### 2.2 `@floom/runtime` — **no import**

The server implements its own Docker-per-app path in `services/docker.ts` (dockerode, generated `Dockerfile`, copied entrypoints). That path is **orthogonal** to `packages/runtime`’s `Ax41DockerProvider`, which targets **git clone → optional generated Dockerfile + `floom-entry.sh` → `docker` CLI** for repo-based deploy (`packages/runtime/src/provider/ax41-docker.ts`).

**Coupling:** conceptual overlap (both generate Docker policy), **not** a package-level dependency.

### 2.3 `@floom/detect` — **no import**

Stack/workdir heuristics live in `packages/detect`. The server does not call them. OpenAPI ingest has its own `detectAppFromUrl` naming for **OpenAPI → Floom manifest** preview, unrelated to `@floom/detect`’s repo classification.

### 2.4 `@floom/manifest` — **no import**

Server manifest validation and normalization live in **`apps/server/src/services/manifest.ts`** with types in **`apps/server/src/types.ts`** (`NormalizedManifest`, actions, v1/v2, runtimes **`python` | `node`**).

`@floom/manifest` describes a **different** product slice: `floom.yaml`-style `Manifest` with runtimes like `python3.12`, `node22`, `go1.22`, `rust`, `docker`, `auto`, `run`/`build` shell strings, etc. (`packages/manifest/src/schema.ts`, `packages/manifest/src/types.ts`).

**Coupling:** **parallel schemas**, same word “manifest”, different shapes and evolution paths.

---

## 3. Duplicate / forked concerns

### 3.1 Renderer contract (intentional fork)

**`apps/server/src/lib/renderer-manifest.ts`** duplicates small pure helpers from `@floom/renderer/contract` (see file header: production server ships compiled JS; renderer package exposes `.ts` in a way Node cannot load at runtime without extra build wiring).

- **Risk:** Drift vs `packages/renderer/src/contract` — file explicitly says to keep in sync.
- **Mitigation already documented in-repo:** mirror changes; consider long-term publishing a **JS** subpath or a tiny `@floom/renderer-contract` package if drift becomes painful.

### 3.2 Docker defaults (two policy engines)

| Surface | Location | Role |
|---------|----------|------|
| **Server per-app images** | `apps/server/src/services/docker.ts` | `python:3.12-slim` / `node:22-slim`, pip/apt from `NormalizedManifest`, `_entrypoint.py` / `_entrypoint.mjs`, timeouts `BUILD_TIMEOUT` / `RUNNER_*` env defaults |
| **Runtime deploy provider** | `packages/runtime/src/provider/ax41-docker.ts` | `generatedDockerfile()` + `floom-entry.sh` from `@floom/manifest`’s `Manifest`, `baseImageForRuntime()` for python/go/rust variants, **CLI `docker`** not dockerode |

**Duplicate concern:** base image choices, apt/curl lines, and “what we inject into the container” can diverge when Floom bumps Python/Node defaults or security hardening in one path but not the other. The two flows serve **different ICP paths** (hosted creator Docker apps vs paste-repo AX41 pipeline), so duplication is **understandable** but should be **governed**, not accidental.

### 3.3 Manifest schema (conceptual duplicate)

`manifest.ts` (server) vs `@floom/manifest` + `@floom/detect` Runtime union: **not** a line-for-line duplicate, but **two sources of truth** for “what is a valid Floom manifest” depending on whether the user is in **gallery/OpenAPI** world or **repo `floom.yaml`** world. Merging without a product decision would break `docs/PRODUCT.md` guidance on preserving manifest shape.

---

## 4. Optional boundary diagram (text)

```
packages/detect          packages/manifest          packages/runtime
     |                          |                          |
     +----(used by CLI)---------+----(Manifest type)-------+---- Ax41DockerProvider
                                                                      |
                                                              git clone / docker CLI

apps/server
  |-- types.ts + services/manifest.ts     (gallery NormalizedManifest; no @floom/manifest)
  |-- services/docker.ts                  (dockerode per-app; no @floom/runtime)
  |-- @floom/renderer (types + esbuild external)
  +-- lib/renderer-manifest.ts            (forked pure helpers; runtime without .ts import)
```

**Observation:** The **CLI** (`@floom/cli`) depends on `@floom/runtime`; the **server** does not. Package graph keeps **server** shallow; **deploy/runtime** depth sits on the CLI side today.

---

## 5. Recommended boundary rules

1. **Keep `apps/server` depending only on packages that are compile-time safe or ship runnable JS.** Today that is effectively **`@floom/renderer`** for types + bundler resolution. If server ever needs `@floom/manifest`, add a **build step** that compiles or bundles it — do not assume `.ts` re-exports work in `node dist/`.

2. **Do not silently merge `NormalizedManifest` (server) with `@floom/manifest`’s `Manifest` without an explicit product migration.** They answer different questions (multi-action gallery app vs repo run command). If convergence is desired, pick one canonical schema and version it; until then, treat cross-imports as **high-risk**.

3. **Docker policy:** When changing default base images, resource limits, or entrypoint behavior, **check both** `apps/server/src/services/docker.ts` and `packages/runtime/src/provider/ax41-docker.ts` (and any Dockerfile templates in deploy docs). Consider a short **internal checklist** in PR template or `AGENTS.md` for “Docker defaults touched”.

4. **`lib/renderer-manifest.ts`:** Any change to `packages/renderer` contract helpers must **update the server copy in the same PR** (or add a test that compares shapes). Prefer one mechanical check (diff or shared JSON schema) if the team outgrows comments.

5. **`@floom/detect`:** If server ever needs repo detection (e.g. unified ingest), import **`@floom/detect` as a real dependency** rather than copying rules — detect is the lowest layer in the manifest stack and is designed to be shared.

6. **`packages/` path imports:** Avoid `../../packages/foo` from `apps/server`; use **`workspace:` + package name** so pnpm/resolution and publishing boundaries stay explicit.

---

## 6. Summary

| Package | Imported by server? | Coupling type |
|---------|---------------------|---------------|
| `@floom/renderer` | Yes (types + bundler) | **Tight, intentional** |
| `@floom/manifest` | No | **Parallel schema** (duplicate *concept*) |
| `@floom/runtime` | No | **Parallel Docker/deploy** (duplicate *policy risk*) |
| `@floom/detect` | No | **None** today |

**Bottom line:** `apps/server` is **thin** on workspace imports but **thick** on duplicated *domain* logic (manifest normalization, Docker generation, renderer contract fork). Boundaries are healthy at the **import graph** level; the main risk is **drift** across the forked renderer helpers and the two Docker codepaths.

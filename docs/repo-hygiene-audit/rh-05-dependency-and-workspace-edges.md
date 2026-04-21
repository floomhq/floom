# rh-05 — Dependency and workspace edges

**Audit type:** Repo-hygiene (read-only, no code changes).
**Source of truth:** `pnpm-workspace.yaml`, every `package.json` in the
workspace, `docker/Dockerfile`, `turbo.json`, `docs/PRODUCT.md`
(load-bearing packages).
**Repo snapshot:** branch `docs/hygiene-and-docs-audit-2026-04-20`,
based on `origin/main d62a4cf` (2026-04-20).

## Executive summary

The **intra-workspace dep graph is clean** (no circular edges, short
chains: `detect` → `manifest` → `runtime` → `cli`; `renderer` → `server`).
The real risks sit one layer below that graph:

1. **Docker image does not bundle load-bearing runtime packages.**
   `docker/Dockerfile:15–17` comments *"packages/detect, /manifest,
   /runtime, /cli were removed in PR #29 (chore: drop runtime-deploy
   path, ship OpenAPI-only). Only @floom/renderer remains in the
   workspace."* — but those four packages **still live in the repo**
   (`packages/detect`, `packages/manifest`, `packages/runtime`,
   `packages/cli`) and are **load-bearing per `docs/PRODUCT.md`**
   ("repo → hosted" pillar). The shipping container only `COPY`s
   `packages/renderer/src` (`Dockerfile:104`); the other four package
   sources are **absent from the runtime image**.

2. **One undeclared workspace dep in `apps/web`.** `apps/web`
   imports `@floom/renderer/contract` at
   `apps/web/src/components/CustomRendererPanel.tsx:31` but does **not**
   declare `@floom/renderer` in `apps/web/package.json`. pnpm hoist
   masks this in dev; a strict / isolated install would fail.

3. **Two unused production deps** (`cronstrue` in `apps/server`,
   `zustand` in `apps/web`).

4. **`@types/node` + `typescript` version drift** across workspaces.

5. **The root `lint` script is a no-op** — already called out in
   rh-01 and rh-04; repeated here because it is technically a
   workspace-edge finding (no `lint` script in any child `package.json`,
   yet `turbo lint` at root pretends otherwise).

---

## Executive truth table

| # | Expectation (evidence) | Reality (evidence) | Verdict |
|---|------------------------|--------------------|---------|
| 1 | Load-bearing packages per `docs/PRODUCT.md` ("Primary path: paste a repo URL, we host it") — `packages/runtime`, `packages/detect`, `packages/manifest`, `packages/cli` — should ship inside the Docker runtime image. | `docker/Dockerfile:18–21` copies only `apps/server`, `apps/web`, and `packages/renderer` manifests; `Dockerfile:104` copies only `packages/renderer/src`. The four runtime packages are neither `COPY`-ed nor `pnpm install`-ed in the runtime stage. | **Contradicted** |
| 2 | `docker/Dockerfile` comment at line 15 must match tree reality. | Comment states *"packages/detect, /manifest, /runtime, /cli were removed in PR #29"*; all four directories exist on `main` (`ls packages/` = `cli detect hub-smoke manifest renderer runtime`). | **Contradicted** |
| 3 | Every `import '@floom/...'` must resolve to a declared workspace dep. | `apps/web/src/components/CustomRendererPanel.tsx:31` imports `@floom/renderer/contract`; `apps/web/package.json` lists no `@floom/*` workspace dep. | **Drift** |
| 4 | A declared production dep should have at least one import. | `apps/server/package.json` declares `"cronstrue":"2.50.0"`; `rg "cronstrue" apps/server/src/` returns zero hits. `apps/web/package.json` declares `"zustand":"5.0.2"`; `rg "zustand" apps/web/src/` returns zero hits. | **Drift** |
| 5 | Shared toolchain deps (`typescript`, `@types/node`) should pin one version per workspace to avoid dual-install. | `apps/server/package.json` devDeps: `"@types/node":"20.17.9"`; every `packages/*/package.json` uses `"@types/node":"22.9.0"`. `typescript` is `5.7.2` in `apps/server`, `apps/web`, `packages/renderer`; `5.6.3` in `packages/cli`, `packages/detect`, `packages/manifest`, `packages/runtime`; `^5.6.3` in `packages/hub-smoke`. | **Drift** |
| 6 | Workspace dep graph should be a DAG with short chains. | Actual graph (workspace refs only): `@floom/detect` (leaf) → `@floom/manifest` → `@floom/runtime` → `@floom/cli`; `@floom/renderer` (leaf) → `@floom/server`. `@floom/web` and `@floom/hub-smoke` depend on nothing in-workspace. | **Met** |
| 7 | `turbo lint` (declared in `turbo.json:"lint": {}`) should dispatch a real linter somewhere in the workspace. | No `lint` script exists in any `apps/*/package.json` or `packages/*/package.json`; no `.eslintrc*` / `eslint.config.*` anywhere. Same finding as rh-01 T6 and rh-04 F1. | **Contradicted** |
| 8 | Peer-style deps (React, react-dom) declared where they are actually used. | `apps/server/package.json` declares `"react":"18.3.1","react-dom":"18.3.1"` because `apps/server/src/services/renderer-bundler.ts:347` does `import React from 'react'` to compile renderer bundles with esbuild at runtime. Legitimate — not a dead dep. | **Met** |
| 9 | `@floom/hub-smoke` test commands should be discoverable from root. | Root `package.json:"test:hub-smoke": "pnpm --filter @floom/hub-smoke test:fast"` wires it; `@floom/hub-smoke/package.json` exposes `test:fast`, `test:full`, `test:all`. Works. Note: hub-smoke does **not** define a `"test"` script, so `turbo test` bypasses it — intentional, documented. | **Met** |
| 10 | `@floom/detect` as a leaf package should have zero deps. | `packages/detect/package.json` deps: `{}`; devDeps: `@types/node`, `tsx`, `typescript`. Matches. | **Met** |

---

## Concrete findings

### Workspace dep graph (ground truth)

Built from every `package.json` `dependencies` field under
`pnpm-workspace.yaml:1–3` (`apps/*`, `packages/*`):

```text
@floom/detect        (no floom deps)
@floom/manifest      → @floom/detect
@floom/runtime       → @floom/detect, @floom/manifest
@floom/cli           → @floom/runtime
@floom/renderer      (no floom deps)
@floom/server        → @floom/renderer
@floom/web           (no declared floom deps — see F3)
@floom/hub-smoke     (no floom deps)
```

Evidence paths (deps field per package):
`apps/server/package.json:17` (`"@floom/renderer":"workspace:*"`),
`apps/web/package.json` (none),
`packages/cli/package.json:14` (`"@floom/runtime":"workspace:*"`),
`packages/manifest/package.json:15` (`"@floom/detect":"workspace:*"`),
`packages/runtime/package.json:18–19`
(`"@floom/detect":"workspace:*","@floom/manifest":"workspace:*"`),
`packages/renderer/package.json` (no floom deps),
`packages/hub-smoke/package.json` (no floom deps).

No circular refs, no forbidden edges (web does not import from
`apps/server/src`, server does not import from `apps/web/src`).

### F1. Docker image does not bundle load-bearing runtime packages

`docker/Dockerfile:15–17` comment:

> packages/detect, /manifest, /runtime, /cli were removed in PR #29
> (chore: drop runtime-deploy path, ship OpenAPI-only). Only
> @floom/renderer remains in the workspace.

Tree reality (`ls packages/` at `d62a4cf`):

```
cli  detect  hub-smoke  manifest  renderer  runtime
```

The Dockerfile's runtime stage (`Dockerfile:65–121`):

- Copies manifests for `apps/server`, `apps/web`, `packages/renderer`
  only (`Dockerfile:83–86`).
- Runs `pnpm install --filter @floom/server --prod` (`Dockerfile:93`).
- Copies `packages/renderer/src` (`Dockerfile:104`).
- Does **not** copy `packages/detect/src`, `packages/manifest/src`,
  `packages/runtime/src`, `packages/cli/src`.

Implication: if the "repo → hosted" pillar in `docs/PRODUCT.md` is
expected to run inside the shipping container (which is the whole
point of hosted), the deploy pipeline cannot import `@floom/runtime`
from inside the image — it only exists in the source tree and on the
CI / dev machine. This matches the concern raised in
`docs/product-audit/deep/pd-02-path1-repo-hosted-reality.md` and
`pd-19-roadmap-p0-execution-gap.md`.

Decision owed: either restore the `COPY packages/{detect,manifest,runtime,cli}/...`
lines in `docker/Dockerfile` and update the comment at line 15, or
formally mark these packages as "CI-only / CLI-only, not runtime" in
`docs/PRODUCT.md` and `docs/SELF_HOST.md`. Today the Dockerfile
comment, the repo tree, and the product promise all tell different
stories.

**Do not delete the four packages** (`AGENTS.md:9`, PRODUCT.md
load-bearing list).

### F2. `apps/web` imports `@floom/renderer` without declaring it

- `apps/web/src/components/CustomRendererPanel.tsx:31`:
  `import type { RenderProps } from '@floom/renderer/contract';`
- `apps/web/package.json` `dependencies`: no `@floom/*` key.

In pnpm with `shamefully-hoist=false` (default), this would fail
`pnpm install` in a fresh checkout. It works today because the
monorepo builds every workspace at once via `turbo build` and the
symlink survives. Vite's TypeScript path resolution reads from the
hoisted workspace and the import compiles.

Fix: add `"@floom/renderer": "workspace:*"` to `apps/web/package.json`
`dependencies`. Since it is a type-only import
(`import type ...`), it could also go to `devDependencies`.

### F3. Unused production deps

- **`cronstrue` in `apps/server`** — declared at
  `apps/server/package.json:24` (`"cronstrue":"2.50.0"`);
  `rg "cronstrue" apps/server/src/` returns zero lines. The web app
  *does* use `cronstrue`
  (`apps/web/src/components/triggers/CronExplainer.tsx` imports it —
  1 file via `rg -l cronstrue apps/web/src/`). Server declaration is
  dead weight.
- **`zustand` in `apps/web`** — declared at
  `apps/web/package.json:22` (`"zustand":"5.0.2"`);
  `rg "zustand" apps/web/src/` returns zero lines. Either a planned
  store that never shipped, or residue from a prior refactor.

Removing both trims install time and image surface without any
behavioural change.

### F4. Toolchain version drift

| Dep | `apps/server` | `apps/web` | `packages/cli` | `packages/detect` | `packages/manifest` | `packages/runtime` | `packages/renderer` | `packages/hub-smoke` |
|---|---|---|---|---|---|---|---|---|
| `typescript` | `5.7.2` | `5.7.2` | `5.6.3` | `5.6.3` | `5.6.3` | `5.6.3` | `5.7.2` | `^5.6.3` |
| `@types/node` | `20.17.9` | — | `22.9.0` | `22.9.0` | `22.9.0` | `22.9.0` | `22.9.0` | — |
| `tsx` | `4.21.0` | — | `4.21.0` | `4.21.0` | `4.21.0` | `4.21.0` | — | — |

Evidence: each package's `devDependencies`.

`typescript` drift is the one most likely to bite: `5.6 → 5.7`
introduced tighter inference around `NoInfer` and stricter JSX
handling. Shipping different compilers per workspace defeats the
point of a monorepo typecheck gate.

`@types/node` 20 vs 22 drift means `apps/server` types against Node
20 while the packages it depends on (`@floom/renderer` source, etc.)
type against Node 22. The Dockerfile builds on
`node:20-slim` (`Dockerfile:9, 66`) — so `apps/server` is correctly
tracking the runtime, but `packages/*` are one major ahead.

### F5. Version parity inside apps (matched)

These are intentionally pinned together and all match on `main`:

- `react` + `react-dom`: `18.3.1` in `apps/server`, `apps/web`,
  `packages/renderer` devDeps, and the repo root.
- `yaml`: `2.8.3` in `apps/server`, `packages/manifest`,
  `packages/runtime`.
- `cronstrue`: `2.50.0` in `apps/server` *(unused, see F3)* and
  `apps/web`.
- `react-markdown`: `9.0.1` in `apps/web` and `packages/renderer`.
- `@rjsf/core`, `@rjsf/utils`, `@rjsf/validator-ajv8`: all `5.24.1`
  in `packages/renderer`.

### F6. `lint` is a no-op

Per-package audit:

- `apps/server/package.json` scripts: `build`, `dev`, `typecheck`,
  `test` — no `lint`.
- `apps/web/package.json` scripts: `dev`, `build`, `preview`,
  `typecheck` — no `lint` (and no `test`, see rh-06).
- `packages/*/package.json`: none declare `lint`.
- Repo root: `.eslintrc*` / `eslint.config.*` — none found
  (`ls .eslintrc* eslint.config.*` exits 2).

Yet `package.json:"lint": "turbo lint"` and `turbo.json` declares
`"lint": {}`. Running `pnpm lint` exits zero with zero work done.
Recommendation: either wire ESLint/Biome across the workspace and
add a real `lint` script per package, or remove the root/turbo
declarations so nobody mistakes it for a gate.

### F7. `@floom/hub-smoke` is outside `turbo test`

`packages/hub-smoke/package.json:6–11` defines `test:all`,
`test:fast`, `test:full` but **no `"test"` script**. Root
`package.json:11` wires `"test:hub-smoke": "pnpm --filter
@floom/hub-smoke test:fast"` as a sibling command. `turbo test`
therefore does not include hub-smoke — intentional (Playwright needs
a live server), but worth documenting for operators so they do not
assume `pnpm test` covered it.

### F8. Runtime package has a stray log artifact

`packages/runtime/tests/opendraft-e2e.log` (16 357 bytes, dated
2026-04-13) sits next to `tests/detect/` and `tests/provider/` as if
it were a test. It is an e2e output dump. Overlap with rh-06 F8;
tagged here because it bloats the published tarball for
`@floom/runtime` if this package is ever `pnpm publish`-ed.

### F9. Renderer packs peerish React in devDeps; server declares it as prod

- `packages/renderer/package.json` devDeps: `react`, `react-dom`
  (expected — the package *uses* React types).
- `apps/server/package.json` deps: `react`, `react-dom` — needed at
  runtime because `apps/server/src/services/renderer-bundler.ts:347`
  does `import React from 'react'` and runs this source through
  esbuild at runtime (`Dockerfile:102–104` comment).

This is a real, intentional runtime coupling (the renderer bundler
reads React from node_modules to compile creator renderers). Not a
bug — worth flagging so nobody "cleans up" the server's React dep
thinking it is Vite-only.

### F10. Composio, Stripe, Sentry, Better Auth all declared and used

Sanity check (`rg -l`):

- `@composio/core`: 1 file (`apps/server/src/services/composio.ts`).
- `stripe`: 7 files.
- `@sentry/node`: 1 file.
- `better-auth` / `@better-auth/api-key`: reachable via the auth
  plumbing (1+ files each).
- `@modelcontextprotocol/sdk`: 1 file (`apps/server/src/routes/mcp.ts`).
- `@apidevtools/json-schema-ref-parser`, `json-schema-merge-allof`:
  1 file each (OpenAPI ingest).

All declared deps (outside F3) have at least one import.

---

## Risk register

| ID | Sev | Risk | Evidence |
|----|-----|------|----------|
| W1 | P0 | "Repo → hosted" path relies on `packages/{detect,manifest,runtime,cli}` but the shipping Docker image does not include them; first time the pillar is exercised in production, it fails at import time inside the container. | `docker/Dockerfile:15–17, 83–86, 104`; `docs/PRODUCT.md` load-bearing list |
| W2 | P1 | `apps/web` imports `@floom/renderer` without declaring it; any switch to strict pnpm isolation (e.g. `node-linker=isolated`) or any external consumer bootstrapping only `apps/web` breaks. | `apps/web/src/components/CustomRendererPanel.tsx:31` vs `apps/web/package.json` deps |
| W3 | P2 | TypeScript 5.6 vs 5.7 drift across workspaces; a future typecheck upgrade might pass in one package and fail in another. | devDeps across the seven package.jsons |
| W4 | P2 | Dead deps (`cronstrue` server, `zustand` web) add install time + a surface for future "accidentally used" confusion. | `apps/server/package.json:24`, `apps/web/package.json:22` |
| W5 | P2 | `turbo lint` is a no-op masquerading as a gate — contributors may "fix lint" believing they ran one. | `turbo.json`, absence of any `lint` script per package |
| W6 | P2 | `packages/runtime/tests/opendraft-e2e.log` is a checked-in 16 KB log artifact; bloats tarball if the package is ever published. | `packages/runtime/tests/opendraft-e2e.log` |

---

## Open PM questions

1. **Runtime packages in the Docker image — restore or formally retire?**
   The four-way drift between `docker/Dockerfile:15–17` comment, the
   repo tree, `docs/PRODUCT.md` load-bearing list, and the "repo →
   hosted" pillar has to collapse to one story. Pick: (a) ship them
   in the image, or (b) formally document them as CLI/CI-only and
   update `PRODUCT.md` + `SELF_HOST.md`.
2. **Adopt a real linter, or delete the `lint` surface?** Today it
   pretends to gate something.
3. **Collapse `typescript` to one version, and `@types/node` to one
   major across the workspace?**
4. **Remove `cronstrue` from `apps/server` and `zustand` from
   `apps/web`?** Both are zero-usage at `d62a4cf`.
5. **Add `@floom/renderer` as an explicit dep of `apps/web`**, or
   bundle the `RenderProps` type alongside the consumer so the edge
   disappears entirely?
6. **`.gitignore` `packages/runtime/tests/*.log`** so stray e2e
   artifacts stop landing on `main`?

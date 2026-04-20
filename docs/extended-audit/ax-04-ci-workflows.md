# ax-04 — CI / GitHub Actions

**Scope:** `.github/workflows/*.yml` (no `.yaml` files present). Snapshot **2026-04-20**.

**Sources:** [`ci.yml`](../../.github/workflows/ci.yml), [`hub-smoke.yml`](../../.github/workflows/hub-smoke.yml), [`publish-image.yml`](../../.github/workflows/publish-image.yml); [`docs/ROADMAP.md`](../ROADMAP.md) P0/P1; root [`package.json`](../../package.json) / [`turbo.json`](../../turbo.json) for what `pnpm test` / `pnpm typecheck` actually run.

---

## Workflow summary table

| Workflow | File | Triggers | Concurrency | Path filters | Node | Package manager cache | Other caching |
|----------|------|----------|-------------|--------------|------|----------------------|---------------|
| **CI** | `ci.yml` | `push` + `pull_request` to `main` | None declared | None (full repo changes run both jobs) | 20 (`actions/setup-node@v4`, `cache: pnpm`) | pnpm store via `setup-node` | No |
| **Hub smoke (Playwright)** | `hub-smoke.yml` | `workflow_dispatch`; `schedule` cron `0 7 * * *` (UTC); `pull_request` to default branch with paths | None declared | PR only: `packages/hub-smoke/**`, `apps/web/**`, `.github/workflows/hub-smoke.yml` | 20 | pnpm | Playwright browser install each run (Chromium + deps) |
| **Publish Docker image** | `publish-image.yml` | `push` tags `v*`; `workflow_dispatch` | None declared | None | N/A (no Node) | N/A | Docker Buildx **GHA cache** (`cache-from` / `cache-to` `type=gha,mode=max`) |

---

## Secrets and variables

| Workflow | Job / step | Secret / var | Purpose |
|----------|------------|----------------|---------|
| **CI** | — | None | Uses only `actions/checkout` + pnpm + Node |
| **Hub smoke** | `fast-apps`, `full-hub` | `vars.FLOOM_HUB_SMOKE_URL` (optional) | Base URL for Playwright; shell default `https://preview.floom.dev` if unset |
| **Hub smoke** | `full-hub` only | `secrets.HUB_SMOKE_E2E_EMAIL`, `secrets.HUB_SMOKE_E2E_PASSWORD` | Auth E2E; **if either empty, step exits 0** (“skip”) — not a hard failure |
| **Publish image** | GHCR login | `secrets.GITHUB_TOKEN` | `docker/login-action` to `ghcr.io` as `github.actor`; workflow sets `permissions: contents: read`, `packages: write` |

No PAT or third-party registry secrets in workflows; image push relies on `GITHUB_TOKEN` + package permissions.

---

## What CI actually executes (`pnpm test` / `pnpm typecheck`)

- **`pnpm typecheck`** → `turbo typecheck` (depends on `^build` per `turbo.json`).
- **`pnpm test`** → `turbo test`. Packages with a `test` script today include **`@floom/server`** (large `test/stress/*.mjs` chain after `pnpm run build`), **`@floom/runtime`** (Node test runner on `tests/*.test.ts`), and placeholder scripts in **`@floom/manifest`**, **`@floom/detect`**, **`@floom/renderer`** that exit 0 with a message. **`@floom/web`** has no `test` script. **`@floom/hub-smoke`** defines `test:fast` / `test:full` only — **no `test` script**, so **Playwright hub-smoke is not part of the CI workflow’s `pnpm test` job**.

---

## Failure visibility and signal quality

| Area | Observation |
|------|----------------|
| **PR checks** | `ci.yml` exposes two checks (Typecheck, Test). Standard GitHub UI; no `workflow_run` fan-out, no Slack/email, no job summary markdown. |
| **Hub smoke `full-hub`** | Intentionally soft: missing E2E secrets → `exit 0`. Nightly/dispatch can “pass” without ever running auth tests — good for optional creds, bad for “green means tested.” |
| **Hub smoke PR gate** | Only runs when PR touches hub-smoke, web, or the workflow file. Server-only or package-only PRs **do not** run browser smoke. |
| **Publish** | Tag push builds and pushes; no prerequisite workflow (e.g. no “required CI green on tag” enforced in YAML). |

---

## Gaps vs engineering expectations

1. **No `concurrency`** on any workflow — stacked pushes/PRs can queue many identical runs; no cancel-in-progress for PRs.
2. **No `lint` job** — root has `pnpm lint` (`turbo lint`); not invoked in CI.
3. **No explicit `build` / Docker dry-run in CI** — typecheck pulls `^build` for some packages, but there is no dedicated “build web + server” or “validate Dockerfile” job before release.
4. **Hub smoke disconnected from main CI** — Playwright is a separate workflow with narrow PR path filters; roadmap P1 explicitly calls out E2E in CI as still desired.
5. **`full-hub` skip is success** — risk of thinking auth paths are covered when secrets are absent.
6. **`publish-image.yml`** — no multi-arch test matrix beyond build; no SBOM or vulnerability scan in workflow (may be intentional scope).

---

## Comparison to `docs/ROADMAP.md` P0 journeys

P0 themes (condensed): **async job queue UI**, **custom renderer upload UI**, **rate-limit `/api/*/run`**, **legal/cookie**, **landing polish**, **repo → hosted pipeline** (clone, detect, Docker, smoke over HTTP; parts still to land on server/routes/UI).

| P0 theme | CI relevance |
|----------|----------------|
| **Rate limits on `/api/*/run`** | Server stress suite invoked via `turbo test` includes e.g. `test-rate-limit.mjs` (and related routes tests) — **high value** if that suite stays green on `main`. |
| **Repo → hosted / Docker** | **`publish-image.yml`** aligns with roadmap (“same image” as cloud / self-host): tags `v*` push multi-arch image to `ghcr.io/floomhq/floom-monorepo`. **Gap:** no CI job that validates the **deploy-from-GitHub** path or new routes before they ship; only existing unit/stress + optional hub smoke. |
| **Renderer / jobs UI** | Mostly UI; **`pnpm test`** does not run web app tests (none defined). Renderer contract tests run **via server** stress scripts, not Vite/React CI. |
| **Legal / landing** | `apps/web` changes trigger hub-smoke on PR, not full visual or content checks; no Lighthouse/legal link crawler in workflows. |

**P1 explicit note (roadmap):** “End-to-end functional test suite in CI (**currently manual**)” — current state: **hub-smoke exists in Actions** but is **not** the default `CI` workflow job, is **path-filtered** on PRs, and **authenticated** full hub is **optional** on schedule/dispatch.

---

## Recommendations (non-blocking)

1. Add **`concurrency`** at least for `ci.yml` (`group: ${{ github.workflow }}-${{ github.ref }}`, `cancel-in-progress: true` on PRs) to save minutes and clarify “latest” signal.
2. Add a **`lint` job** mirroring `typecheck`/`test` (same Node 20 + pnpm cache).
3. Decide product intent for **hub-smoke on `main` pushes** (currently only cron + dispatch + filtered PRs). If preview should track `main`, consider `push` to `main` with similar path filters or a nightly **full** suite when secrets exist.
4. For **`full-hub`**: consider a **non-zero exit** when `workflow_dispatch` was used and secrets are missing (keep skip-on-schedule if desired), or emit a **notice annotation** so the run is visibly “skipped,” not silently green.
5. Before expanding P0 **deploy-github** surface: add **targeted CI** (stress or new integration tests) for new routes and Docker defaults; optionally **Docker build** on PRs touching `docker/` or `services/docker.ts` without pushing.
6. **`publish-image`**: optional gate — require successful **`CI` workflow_run** on the tagged commit (branch protection / rulesets or a calling pattern) so tags cannot publish from unchecked SHAs.

---

## File inventory

| Path |
|------|
| `.github/workflows/ci.yml` |
| `.github/workflows/hub-smoke.yml` |
| `.github/workflows/publish-image.yml` |

No `.github/workflows/*.yaml` files found.

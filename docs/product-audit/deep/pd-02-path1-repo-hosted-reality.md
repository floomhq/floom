# pd-02 — Path 1: repo → hosted reality

**Track:** Deep product audit (super-deep). **Lens:** `docs/PRODUCT.md`, `docs/ROADMAP.md`, `packages/runtime`, `packages/detect`, `packages/manifest`, server/web wiring.

**Snapshot date:** 2026-04-20 (aligned with `docs/ROADMAP.md` “2026-04-17” + repo state at audit time).

---

## Sources read (evidence base)

| Artifact | Role |
|----------|------|
| `docs/PRODUCT.md` | ICP, deployment path ordering, load-bearing paths, `/api/deploy-github` “when present” |
| `docs/ROADMAP.md` | P0 repo→hosted bullets: library vs still-to-land |
| `packages/runtime/README.md` | Public API contract, explicit “not wired” list |
| `packages/runtime/src/deploy/pipeline.ts` | `deployFromGithub` orchestration and phases |
| `packages/runtime/src/provider/ax41-docker.ts` | Ax41 Docker provider (clone/build/run/smoke) |
| `packages/detect/src/index.ts` | Thin export surface (`detect`, types) |
| `packages/manifest/src/index.ts` + `generate.ts` | `generateManifest` bridges detect → YAML/manifest |
| `apps/server/src/index.ts` | Mounted API routes (no `deploy-github`) |
| `apps/server/src/routes/hub.ts` | `POST /api/hub/detect`, `POST /api/hub/ingest` |
| `apps/server/package.json` | Dependencies (no `@floom/runtime`) |
| `apps/web/src/pages/BuildPage.tsx` (header + `runGithubDetect`) | Multi-ramp semantics |
| `apps/web/src/api/client.ts` | `detectApp` → `/api/hub/detect` |
| `packages/cli/src/index.ts` | User-facing message referencing missing API |
| `docs/product-audit/deep/INDEX.md` | Cross-track expectations |

**UX audit cross-link:** `docs/ux-audit/LAUNCH-UX-AUDIT-2026-04-20.md` was **not present** in the workspace (only `docs/ux-audit/_captures/manifest.json` exists). Related narrative is reflected inline in `BuildPage.tsx` comments (e.g. hero auto-detect 2026-04-20). See also [`pd-01-icp-positioning-truth.md`](./pd-01-icp-positioning-truth.md) for hero vs “paste repo” positioning.

---

## 1. Executive truth table

| # | Promise (PRODUCT / ROADMAP) | Observed reality (code / routes) | Verdict |
|---|----------------------------|-------------------------------------|---------|
| 1 | **Primary path:** paste GitHub URL → Floom clones, detects runtime, builds, runs, exposes on three surfaces (`PRODUCT.md` deployment paths §1). | `deployFromGithub` in `packages/runtime/src/deploy/pipeline.ts` implements clone → `generateManifest` (@floom/manifest + @floom/detect) → provider build/run/smoke. **Not invoked from `apps/server`.** | **Partial** (library only) |
| 2 | Server exposes **`/api/deploy-github`** “when present” (`PRODUCT.md`). | No `deploy-github` router in `apps/server/src/index.ts`. Grep shows only `/api/deploy-waitlist` (`deployWaitlistRouter`). **No `POST /api/deploy` or `POST /api/deploy-github`.** | **Missing** |
| 3 | ROADMAP P0: **`POST /api/deploy-github` + SSE log**. | No deploy route; SSE exists elsewhere (`apps/server/src/routes/run.ts` for run streams; `log-stream.ts` for container logs) — **not** wired to a deploy orchestrator. | **Missing** |
| 4 | ROADMAP P0: **`/build` “host this repo” ramp** distinct from OpenAPI-in-repo discovery. | `BuildPage.tsx` lines 1–11: GitHub ramp is **“transforms repo URL to raw openapi.yaml\|json … before calling the detect API”**. `runGithubDetect` (`BuildPage.tsx` ~171–218) calls `api.detectApp(candidate)` → **`POST /api/hub/detect`** with **raw OpenAPI URLs**, not `deployFromGithub`. | **Contradicted** (UI implements path 3 via GitHub-shaped URL, not path 1 hosting) |
| 5 | ROADMAP P0: **per-user deploy quota**. | No deploy endpoint → no quota enforcement on path 1. (General rate limits apply to `/api/:slug/run`, etc., per `apps/server/src/index.ts`.) | **Missing** |
| 6 | ROADMAP P0: **hardened defaults in `services/docker.ts` for all hosted workloads**. | `apps/server/src/services/docker.ts` defines `RUNNER_MEMORY`, `RUNNER_CPUS`, `RUNNER_NETWORK`, timeouts — used by **server hosted-mode** builds. `Ax41DockerProvider` (`packages/runtime/src/provider/ax41-docker.ts`) uses **separate** defaults (`DEFAULT_MEMORY_MB`, `DEFAULT_CPUS`, etc.). Path 1 provider is **not** unified with server `docker.ts` in code. | **Partial** / **gap** (two Docker policy surfaces until integrated) |
| 7 | **`@floom/cli` `deploy`** as user entry. | `packages/cli/src/index.ts`: `floom deploy` **exits 1** and tells users to use `floom.dev/build` or **`POST /api/deploy-github` directly** — route **does not exist**. | **Contradicted** (CLI points at a non-route) |
| 8 | Packages **`detect` / `manifest`** power “paste a repo” without manual runtime pick (`PRODUCT.md` load-bearing). | Wired **inside** `deployFromGithub` → `generateManifest` → `detect`. **Hub detect/ingest** uses OpenAPI parsing (`openapi-ingest.ts`), **not** `@floom/detect` for the creator URL flow. | **Partial** (packages used only if something calls `deployFromGithub`) |

---

## 2. Gap analysis vs ROADMAP P0 — “Repo → hosted pipeline” bullet

ROADMAP (`docs/ROADMAP.md` ~40–41) lists:

| Sub-bullet | Status | Evidence |
|------------|--------|----------|
| Library: `deployFromGithub` + `Ax41DockerProvider` | **Shipped** | `packages/runtime/src/deploy/pipeline.ts`, `packages/runtime/src/provider/ax41-docker.ts`, `packages/runtime/README.md` |
| **`POST /api/deploy-github` + SSE log** | **Not shipped** | No route registration in `apps/server/src/index.ts`; no grep hit for `deploy-github` in `apps/server/src/` except absence |
| **`/build` “host this repo” ramp** (distinct from OpenAPI-in-repo) | **Not shipped** | `BuildPage.tsx` GitHub ramp = OpenAPI raw URL discovery + `/api/hub/detect` |
| **Per-user deploy quota** | **Not shipped** | No deploy API to attach quota to |
| **Hardened defaults in `services/docker.ts` for all hosted workloads** | **Ambiguous / open** | Path 1 uses runtime package Docker logic; production app hosting uses `docker.ts`. Unification not visible in repo |

**Additional gap (PRODUCT alignment):** `docs/PRODUCT.md` line 23 says code lives in runtime/detect/manifest **and** “the `/api/deploy-github` server route **(when present)**.” The route is **not** present; the doc is conditional, but the **ICP default** (“Floom runs your code”) is **not** reachable through the shipped web or server surfaces.

---

## 3. Engineering milestones vs product milestones

| Layer | Engineering state | Product milestone implied |
|-------|--------------------|---------------------------|
| **Runtime library** | `deployFromGithub` end-to-end with `onLog` hook (SSE-ready caller side) in `pipeline.ts` | “We can deploy from GitHub in process” — **met in isolation** |
| **Runtime provider** | `Ax41DockerProvider`: git clone, docker build, generated Dockerfile when missing, smoke test | Same; **met** for a Node process that imports `@floom/runtime` |
| **Server integration** | `@floom/server` does **not** list `@floom/runtime` in `apps/server/package.json` | “Users trigger deploy from cloud Floom” — **not met** |
| **HTTP API** | No `POST /api/deploy-github` | “MCP/HTTP/CLI can trigger deploy” — **not met** |
| **Streaming UX** | No deploy SSE route | ROADMAP P0 “SSE log” — **not met** |
| **Web `/build`** | GitHub ramp = OpenAPI detect | “Paste repo → hosted” — **not met**; **different** product behavior (wrap existing spec) |
| **Abuse / cost** | No per-user deploy quota | ROADMAP P0 — **not met** |
| **CLI** | Stub + wrong URL | **Worse than missing**: misdirects to non-existent API |

**Net:** Engineering has a **reusable library**; product has **no first-class ship** for Path 1 in the running app.

---

## 4. ICP journey — Path 1 (as designed) vs what exists

### 4.1 Intended journey (library + PRODUCT)

1. User provides `https://github.com/owner/repo`.
2. Backend calls `deployFromGithub(url, { provider: new Ax41DockerProvider(), githubToken, onLog })`.
3. Floom fetches metadata, generates manifest, builds container, smoke-tests.
4. On success, app is registered and three surfaces work.

**Failure branches (library-level, from `pipeline.ts`):**

- Invalid URL → `success: false`, error string (phase 1).
- GitHub API fetch fails → user-facing “Could not fetch … from GitHub” (~62–67).
- Auto-detect cannot produce runnable manifest → `draftManifest` in result (~72–77).
- Clone fails → error, manifest + draftManifest if detect succeeded (~88–96).
- Build/run/smoke fail → destroy snapshot, return errors (~99–166).

### 4.2 Actual journey today (web — `/build` GitHub ramp)

1. User pastes GitHub URL (or lands via `?ingest_url=`).
2. Client expands to **raw.githubusercontent.com** candidates (`githubCandidates` in `BuildPage.tsx` ~171–182).
3. For each candidate, **`POST /api/hub/detect`** with `openapi_url` (`api/client.ts` ~563–571).
4. If a **checked-in OpenAPI file** matches, user gets `DetectedApp` and proceeds to review/publish **as a proxied OpenAPI app** (ingest path), not as “Floom runs this repo’s server.”

**Failure branches (actual):**

- **No OpenAPI in repo (typical FastAPI/Express app without committed spec):** all candidates fail → `githubError` `'no-openapi'` (~214–218). User does **not** get path 1 fallback.
- **Private repo:** raw URLs fail; same `'no-openapi'` / unreachable classification (~214–216) — cannot use `GITHUB_TOKEN` via this flow (detect does not take a repo token for private GitHub hosting in the **runtime** sense).
- **Hub / network down:** `detectApp` throws → OpenAPI error paths; no deploy retry.
- **Success but wrong product:** User thinks they “connected GitHub”; they actually **imported a spec** if one exists.

---

## 5. Risk register

| ID | Severity | Risk | Evidence |
|----|----------|------|----------|
| R1 | **P0** | **ICP promise (“paste repo, we host it”) is not what `/build` delivers** for the GitHub ramp. | `BuildPage.tsx` header vs `runGithubDetect`; `PRODUCT.md` §Core value |
| R2 | **P0** | **No server route** → no authenticated, metered, observable path 1 in production. | `apps/server/src/index.ts`; `apps/server/package.json` |
| R3 | **P0** | **CLI references non-existent `POST /api/deploy-github`** → support burden and distrust. | `packages/cli/src/index.ts` ~16–17 |
| R4 | **P1** | **Two Docker policy implementations** (runtime provider vs `docker.ts`) → inconsistent limits/security when path 1 lands. | `packages/runtime/src/provider/ax41-docker.ts`; `apps/server/src/services/docker.ts` |
| R5 | **P1** | **Self-host in container:** `PRODUCT.md` / `runtime/README` say path 1 needs host Docker; ICP on cloud may not read this — OK for AX41, but docs vs expectation if Floom is ever shipped as “Docker only.” | `docs/PRODUCT.md` Host requirements |
| R6 | **P2** | **`deploy_waitlist` captures interest** but does not advance path 1 implementation; risk of **false expectation** (“deploy” naming). | `apps/server/src/routes/deploy-waitlist.ts` vs missing `deploy-github` |

---

## 6. Open PM questions (owner decisions)

1. **Positioning:** Until `deploy-github` ships, should marketing and `/build` copy **explicitly** say that GitHub import **requires an OpenAPI file in the repo**, and that **true repo hosting** is coming — or is that considered harmful to conversion?
2. **Ramp split:** ROADMAP asks for a **second** tile: “host this repo” vs current “find OpenAPI in repo.” What is the **IA** (two cards, tab, toggle, progressive disclosure after failure)?
3. **Success artifact:** After `deployFromGithub` succeeds, does the product **auto-ingest** into the same `apps` table / manifest shape as OpenAPI ingest, or is a **new** manifest normalization path required?
4. **Smoke test vs stay-up:** `pipeline.ts` stops the instance after smoke test (`instance.stop()` in `finally` ~139–147). For production, should the container **keep running** and register with the runner — or is another handoff step planned?
5. **Private GitHub:** Will cloud Floom support private repos via OAuth/token, and where does that token live (user connection vs server `GITHUB_TOKEN`)?
6. **Quota model:** Per workspace, per user, per day — and does **OpenAPI ingest** share the same quota when path 1 lands?
7. **CLI truth:** Ship a **working** `floom deploy`, remove the command, or point to **documented** API only when the route exists?

---

## 7. Concrete route & wiring checklist (audit artifact)

| Route / symbol | Present? | Location |
|----------------|----------|----------|
| `POST /api/deploy-github` | **No** | — |
| `POST /api/deploy` | **No** | — |
| `POST /api/deploy-waitlist` | **Yes** | `apps/server/src/index.ts` ~189 |
| `POST /api/hub/detect` | **Yes** | `apps/server/src/routes/hub.ts` ~103 |
| `POST /api/hub/ingest` | **Yes** | `hub.ts` ~132+ |
| `deployFromGithub` | **Yes (library)** | `packages/runtime/src/deploy/pipeline.ts` |
| `@floom/runtime` in server | **No** | `apps/server/package.json` dependencies |

---

## 8. Cross-links

- **[pd-01 — ICP positioning truth](./pd-01-icp-positioning-truth.md)** — hero and first-screen narrative vs repo-hosting backend.
- **[INDEX](./INDEX.md)** — pd-02 row definition.
- **[pd-19 — ROADMAP P0 execution gap](./pd-19-roadmap-p0-execution-gap.md)** (when published) — aggregate P0 checklist; this track deep-dives **only** path 1.

---

## 9. One-line synthesis

**Path 1 is implemented as a library (`@floom/runtime`) with a clear orchestrator and Docker provider, but it is not mounted on the Floom server, not exposed as `POST /api/deploy-github`, and not reflected in `/build` — where the “GitHub” ramp is still an OpenAPI-discovery shortcut, not “Floom runs your repo.”** The highest-leverage close is: **add the server route + dependency**, **split or relabel the `/build` ramps**, and **fix the CLI** so it does not reference a missing API.

# pd-19 — ROADMAP P0 execution gap

**Audit type:** Deep product audit (read-only).  
**Source of truth:** `docs/ROADMAP.md` § “P0 — Launch blockers” (snapshot 2026-04-17).  
**Repo snapshot:** Evidence gathered from workspace as of audit run (2026-04-20).

## Executive summary

Most **trust / abuse-surface** P0 items (legal pages, cookie UX, run-surface rate limits) show **implemented code**. The **ICP-defining repo→hosted product** remains a **library + provider** story without the **server route, first-class `/build` ramp, deploy quota, or the ROADMAP-cited hardening pass in `services/docker.ts` for that path**. **Async job UX** is **partially** present on run surfaces (`JobProgress` + `RunSurface`) but **does not appear** in the `/build` composer as a creator-facing toggle; **`docs/DEFERRED-UI.md` is stale** relative to `main` for async jobs. **`docs/ROADMAP.md` “Current state” table** still says “UI in flight” for custom renderer upload while **`CustomRendererPanel` is wired** into post-publish `/build` and Studio/Creator paths—**roadmap table drift**. **Wireframes v13** are **not verifiable** from code (only generic wireframe host references).

---

## P0 checklist (ROADMAP line → status)

| # | ROADMAP P0 item | Status | Evidence (shipped / gap) |
|---|-----------------|--------|---------------------------|
| 1 | Async job queue UI (re-enable) | 🟡 | **Shipped:** `RunSurface.tsx` branches `app.is_async` → `api.startJob` / `pollJob`; `JobProgress.tsx` renders queued/running with cancel + elapsed. **Gap:** No `is_async` / jobs language in `BuildPage.tsx` (grep hits are only JS `async function`). **Doc debt:** `docs/DEFERRED-UI.md` §1 still claims no jobs UI on `main`—**false vs current tree**. **Open vs “re-enable” intent:** No dedicated `/me` “Jobs” tab or `/build` async toggle called out in ROADMAP checklist elsewhere—only inferable from DEFERRED-UI. |
| 2 | Custom renderer upload UI (re-enable) | 🟡 | **Shipped:** `CustomRendererPanel.tsx` (upload + compile path to `/renderer/:slug/bundle.js`); used in `BuildPage.tsx` (post-publish block ~L1417), `StudioAppRendererPage.tsx`, `CreatorAppPage.tsx`. **Drift:** `docs/ROADMAP.md` “Shipped backend, UI pending” table still lists “Custom renderer upload \| Backend shipped, **UI in flight**”—**does not match** this wiring. Treat as **mostly done in code**, **P0 closure depends on PM** (polish, discoverability, Studio-only vs `/build` parity). |
| 3 | Rate-limit all `/api/*/run` endpoints | 🟡 | **Shipped:** `apps/server/src/index.ts` mounts `runRateLimitMiddleware` on `/api/run`, `/api/:slug/run`, `/api/:slug/jobs`, and `/mcp/app/:slug` (lines ~160–164). Implementation: `apps/server/src/lib/rate-limit.ts` (sliding window; `FLOOM_RATE_LIMIT_DISABLED` escape). **Caveat:** The same middleware prefix **`/api/:slug/jobs` applies to GET polling** (`jobsRouter.get('/:job_id')` in `routes/jobs.ts`). `pollJob` defaults to **1500 ms** (`apps/web/src/api/client.ts`) → high hourly call volume vs anon **60/hr** default—**possible UX/regression risk** for long async jobs unless users are authed or limits tuned. **Not a “missing limit” gap**; a **design validation** gap. |
| 4 | Legal: imprint, privacy policy, terms, cookie consent | ✅ | **Routes:** `apps/web/src/main.tsx` — `/legal`, `/imprint`, `/privacy`, `/terms`, `/cookies`. **Pages:** `ImprintPage.tsx`, `PrivacyPage.tsx`, `TermsPage.tsx`, `CookiesPage.tsx`. **Consent UI:** `CookieBanner.tsx` mounted in `main.tsx`. **Discovery:** `PublicFooter.tsx` links Legal / Privacy / Terms / Cookies. **SSR titles:** `apps/server/src/index.ts` maps `/imprint`, `/privacy`, `/terms`, `/cookies` for document titles (~L691–694 grep hit). |
| 5 | Landing + public-page polish (wireframes v13) | 🟡 | **Partial / unprovable from repo:** `BuildPage.tsx` header comment references **wireframes.floom.dev** (not “v13”). `CreatorHeroPage.tsx` is the eager landing path (`main.tsx` lazy-load strategy). `main.tsx` documents **wireframe v11** redirects for legacy URLs—not v13. **Conclusion:** **Polish has clearly shipped in places** (footer trust strip, About page graduation per `PublicFooter.tsx` comments), but **v13 parity cannot be scored from code** alone—needs design sign-off against `wireframes.floom.dev` v13. |
| 6a | Repo→hosted: library (`deployFromGithub`, `Ax41DockerProvider`, detect/manifest) | ✅ | `packages/runtime/README.md` documents full pipeline and public API; `packages/runtime/src/provider/ax41-docker.ts` implements clone/build/run/smoke with **loopback bind**, memory/CPU defaults (`DEFAULT_MEMORY_MB`, `DEFAULT_CPUS`). |
| 6b | Repo→hosted: `POST /api/deploy-github` + SSE log | ❌ | **No route** in `apps/server/src/index.ts` (only `deployWaitlistRouter` at `/api/deploy-waitlist`). Grep across repo: `deploy-github` appears in **docs**, `packages/runtime` comments, and `packages/cli` copy—**not** as a mounted Hono route. |
| 6c | Repo→hosted: `/build` “host this repo” ramp (distinct from OpenAPI-in-repo discovery) | ❌ | **`/build` resolves to `/studio/build`** (`main.tsx` `Navigate`). `BuildPage.tsx` GitHub path is **detect/publish via OpenAPI-in-repo**, not **`deployFromGithub`**. `packages/runtime/README.md` explicitly lists the tile as **not wired**. |
| 6d | Repo→hosted: per-user deploy quota | ❌ | No deploy API → **no quota surface** (consistent with `pd-02-path1-repo-hosted-reality.md`). |
| 6e | Repo→hosted: hardened defaults in `apps/server/src/services/docker.ts` for **all hosted workloads** | 🟡 | **`docker.ts`** exists with **Floom per-app image** build/run (`RUNNER_MEMORY`, `RUNNER_CPUS`, timeouts)—**orthogonal** to the **runtime package’s** user-repo containers. ROADMAP wording ties **hardening** to **repo-hosted** workloads; that integration is **not landed**, so this sub-item stays **open** from a product perspective even though `docker.ts` is not empty. |

**Hub smoke (supporting signal, not a ROADMAP P0 line):** ✅ **`packages/hub-smoke`** exists (`fast-apps.spec.ts`, `hub-full.spec.ts`, `playwright.config.ts`). ✅ **`.github/workflows/hub-smoke.yml`** runs Playwright on PR (path-filtered) + schedule + `workflow_dispatch`; targets live `BASE_URL` (default `https://preview.floom.dev`). This supports **regression confidence on hub/run UX**, not **repo→hosted deploy**.

---

## Narrative

The P0 list mixes **launch hygiene** (legal, rate limits, marketing polish) with **the core ICP wedge** (paste repo → hosted container). The codebase shows **strong progress on hygiene**: legal routes and cookie consent are first-class, and rate limiting is centralized on the execute and enqueue paths the ROADMAP cares about.

The **async queue** is a good example of **documentation lag**: the ROADMAP still asks to “re-enable” UI, and `DEFERRED-UI.md` still says there was never async UI on `main`, but **`RunSurface` + `JobProgress` + job client APIs** implement a credible async experience for apps already marked async. What is **not proven** in this audit is **creator-side control** (toggle during publish) and **jobs discovery** outside the run card—those may still be the real “P0 gap” behind the single roadmap bullet.

The **custom renderer** bullet suffers the opposite problem: **the UI appears shipped** in multiple surfaces, while the **living roadmap table** still says “UI in flight.” That is a **process/consistency** issue: closing P0 requires **aligning ROADMAP.md with reality** or **rescoping** what “done” means (e.g. paste-only flow vs Studio parity).

The **repo→hosted** compound bullet is still the **largest execution gap**: the **runtime README** is honest that **server wiring and `/build` UX** are missing, and this audit confirms **no `deploy-github` route** and **no deploy quota**. **`hub-smoke`** validates **existing hub apps**, not the **new deploy pipeline**.

---

## Risk register

| ID | Risk | Severity | Notes |
|----|------|----------|--------|
| R1 | **ICP narrative vs shipped path** — Hero and `/build` optimize **OpenAPI-from-GitHub** detection, not **container deployFromGithub**. | High | Aligns with `pd-01` / `PRODUCT.md` tension; P0 text is explicit. |
| R2 | **Job GET polling vs hourly rate limits** — Middleware applies to `/api/:slug/jobs` for all methods; poll interval 1.5s. | Medium | May be fine for authed + short jobs; **anon + long jobs** worth reproducing in preview. |
| R3 | **Stakeholder confusion** — `DEFERRED-UI.md` and ROADMAP “UI pending” rows **contradict** `JobProgress` / `CustomRendererPanel` wiring. | Medium | Undermines prioritization and release notes. |
| R4 | **Wireframe v13 as unchecked acceptance** — No repo traceability to v13. | Low–Med | Risk of **subjective “not done”** forever without a design diff checklist. |
| R5 | **Split Docker policy** — `docker.ts` (ingested apps) vs `Ax41DockerProvider` (repo deploy) **not unified** under one hardening story. | Medium | Security/isolation claims must be **per path**, not assumed transitive. |

---

## PM questions

1. **Async P0 closure:** Is “async job queue UI” satisfied by **`/p/:slug` + `RunSurface`** alone, or does launch require **`/build` async toggle**, a **`/me` jobs list**, and/or **deep-link restore** (`?job=` already written by `RunSurface`—should landing/docs advertise it)?
2. **Custom renderer:** Should ROADMAP **flip to shipped** with a **narrow definition** (Studio + post-publish `/build`), or is there **remaining UX** (e.g. Step 3 inline, templates, guardrails) blocking launch?
3. **Rate limits:** Should **GET job status** be **exempt** or **weighted lower** than POST enqueue/run to avoid starving long-running anon jobs?
4. **Wireframes v13:** What is the **minimum signed checklist** (screens + breakpoints) to mark bullet 5 done—**and** who owns sign-off?
5. **Repo→hosted sequencing:** Is **`POST /api/deploy-github` + SSE** still **P0 for any public launch**, or can it slip to **P1** if messaging stays OpenAPI-first until then?
6. **Deploy quota:** What is the **first quota dimension** (per user/day, per workspace, per IP) once the route exists?
7. **`docker.ts` “hardened defaults”:** Does that mean **extend current Floom app runner**, **align Ax41 limits with it**, or **new seccomp/network policy** work—**and** which environments (cloud only vs self-host)?

---

## Source index (for re-audit)

| Area | Paths |
|------|--------|
| ROADMAP P0 | `docs/ROADMAP.md` L33–40 |
| Async UI | `apps/web/src/components/runner/RunSurface.tsx`, `JobProgress.tsx`, `apps/web/src/api/client.ts` (`pollJob`) |
| Rate limits | `apps/server/src/index.ts` (~L150–164), `apps/server/src/lib/rate-limit.ts` |
| Legal + cookies | `apps/web/src/pages/{Imprint,Privacy,Terms,Cookies}Page.tsx`, `CookieBanner.tsx`, `PublicFooter.tsx`, `main.tsx` routes |
| Wireframe refs | `BuildPage.tsx` (header), `AppPermalinkPage.tsx` (v11), `main.tsx` (v11 redirects) |
| Runtime / deploy gap | `packages/runtime/README.md`, `packages/runtime/src/deploy/pipeline.ts`, `packages/runtime/src/provider/ax41-docker.ts` |
| Docker runner (ingested apps) | `apps/server/src/services/docker.ts` |
| Hub smoke | `packages/hub-smoke/tests/*.spec.ts`, `.github/workflows/hub-smoke.yml` |
| Stale internal doc | `docs/DEFERRED-UI.md` §1–2 |

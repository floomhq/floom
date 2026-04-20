# pd-11: Self-host vs cloud product split

**Lens:** `docs/PRODUCT.md` (ICP, deployment paths, host requirements, three surfaces), implementation in `apps/server/src/index.ts`, `apps/server/src/lib/better-auth.ts`, `apps/server/src/services/session.ts`, `apps/server/src/lib/auth.ts`, plus discoverability via `/protocol`, `docs/SELF_HOST.md`, and `spec/protocol.md` / bundled `apps/web/src/assets/protocol.md`.

**Date:** 2026-04-20

---

## 1. Executive truth table

| Promise or claim (source) | Observed reality | Status |
|---------------------------|------------------|--------|
| **ICP default is cloud-hosted Floom**; end users never install `git`/`docker`; those binaries live on the operator host (`docs/PRODUCT.md` L29–L36). | Repo process shells out to host `git`/`docker` for path 1 / hosted execution; matches split between “user laptop” vs “machine running Floom.” | **Met** (for cloud flagship) |
| **Self-hosted on a normal host with `git` + `docker`:** supported (`docs/PRODUCT.md` L37–L38). | `hosted` mode and seed apps require Docker API access (`docs/SELF_HOST.md` L414, L54); compose documents optional `docker.sock` mount (`docker/docker-compose.yml` L9–L25). | **Met** |
| **Self-hosted Floom inside a container** deploying other repos: **not supported**; no host socket mount, no DinD (`docs/PRODUCT.md` L39–L42). | Same constraints implied by compose (socket commented) and SELF_HOST security warnings; no productized DinD path documented as supported. | **Met** (explicit non-support) |
| **`docs/ROADMAP.md`:** “The cloud tier at floom.dev runs the **same image** as the self-host Docker release.” | Code paths gate on `FLOOM_CLOUD_MODE` and env (Better Auth, CORS origins); one codebase, mode flag — aligns with “same artifact, different config” story if images ship both modes. | **Partial** — true at build/image level; **runtime behavior diverges strongly** (auth, tenancy, CORS). Operator must understand the flag, not only the image tag. |
| **Three surfaces** identical in shape for all paths (`/p/:slug`, `/mcp/app/:slug`, `POST /api/:slug/run`) (`docs/PRODUCT.md` L27). | Routes exist in one server; OSS uses synthetic `local` user/workspace; cloud uses Better Auth + real workspace ids. Surfaces exist, but **authorization semantics** differ (see risks). | **Partial** |
| **Single “paste repo, we host” story** for ICP (`docs/PRODUCT.md` L17–L24). | Primary path is product intent; wiring is separate audit (`pd-02`). Self-host docs emphasize `apps.yaml` + Docker image, not repo paste. | **Out of scope here** — no contradiction inside pd-11, but **ICP vs operator docs** are different funnels. |
| **Protocol / public docs:** “Self-hosting” via Docker one command (`apps/web/src/assets/protocol.md` L54–L63). | Example uses `-p 3000:3000`, `ghcr.io/floomhq/floom:latest`. `docs/SELF_HOST.md` uses `3051`, `ghcr.io/floomhq/floom-monorepo:v0.4.0-minimal.6`. | **Contradicted** (copy drift: port, image name, tag) |
| **`FLOOM_CLOUD_MODE` is the sole switch** for Better Auth (`apps/server/src/lib/better-auth.ts` L7–L13, L55–L58, L278–L282). | `isCloudMode()` only accepts `true`/`1`/`yes`; `getAuth()` returns `null` otherwise; `/auth/*` mounted only when cloud (`apps/server/src/index.ts` L228–L240). | **Met** |
| **OSS mode:** every request synthesized as `local` workspace + user (`apps/server/src/services/session.ts` L111–L120). | `resolveUserContext` returns `DEFAULT_*` ids when `!isCloudMode()`; matches SELF_HOST multi-tenant section describing solo mode (`docs/SELF_HOST.md` L478–L484). | **Met** |
| **Cloud anonymous browsing** with synthetic ids until login (`apps/server/src/services/session.ts` L146–L153). | Comment says NULL workspace/user for callers; implementation returns `ossCtx` (still `local` ids) when no session — “anonymous” is **device-scoped + local ids**, with `is_authenticated: false`. Routes must use `requireAuthenticatedInCloud` for writes (`apps/server/src/lib/auth.ts` L169–L181). | **Partial** — works by convention; easy to misread as “still local user” in logs/DB. |

---

## 2. ICP confusion vectors

These are ways a **non-developer AI engineer** (ICP) or a **self-host operator** misreads the product boundary.

1. **“Open source = I run the same product as floom.dev in one click.”**  
   They pull the image, skip `FLOOM_CLOUD_MODE` and OAuth/SMTP env, then expect sign-up, orgs, and billing-adjacent flows. Reality: **OSS default is solo `local` tenant**; dashboard routes may exist but identity is not multi-user unless cloud mode + secrets are configured.

2. **“Docker run from the protocol page is copy-paste correct.”**  
   Port **3000 vs 3051**, image **`floom` vs `floom-monorepo`**, tag **`latest` vs pinned minimal** — failures range from connection refused to wrong/old behavior without a clear single canonical command in-product.

3. **“I deployed Floom in Kubernetes / on Railway; now I’ll paste a GitHub URL.”**  
   `docs/PRODUCT.md` explicitly rules out **Floom-in-container** without host Docker for path 1-style repo hosting. Operators discover this only if they read PRODUCT or hit obscure runtime errors — not from the marketing one-liner.

4. **“CORS will just work on my `https://floom.mycompany.com`.”**  
   Restricted CORS allow-list includes `PUBLIC_URL` and fixed floom.dev origins; dev adds localhost (`apps/server/src/index.ts` L68–L76). A **custom cloud-style deploy** with web on another origin must set `PUBLIC_URL` / env consistently; misconfiguration breaks cookie surfaces (`/auth/*`, `/api/session/*`, etc.) silently for non-experts.

5. **`FLOOM_AUTH_TOKEN` vs Better Auth.**  
   Global bearer gate applies to `/api/*`, `/mcp/*`, `/p/*` when set (`apps/server/src/index.ts` L143–L145, `apps/server/src/lib/auth.ts` L47–L71). Cloud users also use session cookies. **ICP mental model:** “one password for my Floom” — **operator reality:** shared bearer for self-host hardening *or* per-user sessions in cloud mode; stacking both is possible and confusing.

6. **`isAuthenticated` in `auth.ts` returns true when no token is set** (`apps/server/src/lib/auth.ts` L129–L134) — intentional for “public mode,” but the name suggests “logged-in user,” unlike `hasValidAdminBearer` (L148–L153). **Risk:** internal misuse or support misdiagnosis when comparing cloud session auth to OSS helper semantics.

7. **Docs hierarchy:** README and `docs/README.md` point to `spec/protocol.md` (repo path) and `docs/SELF_HOST.md`, while the **product** pushes `/protocol` in the web app (`apps/web/src/main.tsx` routes, `/docs/*` → `/protocol` redirects). GitHub-first readers see different filenames than browser users — **two mental maps** for “the spec.”

---

## 3. ICP journey (self-host / cloud boundary) with failure branches

| Step | Happy path | Failure branch |
|------|------------|----------------|
| Land on floom.dev | Cloud mode, Better Auth on `/auth/*` | If operator accidentally shipped image with wrong env, migrations fail and **process exits** on boot (`apps/server/src/index.ts` L928–L934). |
| Sign in / use Studio | Session cookies + restricted CORS | Third-party origin not in allow-list → browser blocks credentialed calls; user sees opaque network errors. |
| Run app from `/p/:slug` or MCP | `resolveUserContext` yields real `user_id` / `workspace_id` | Anonymous user hits write route → `401 auth_required` from `requireAuthenticatedInCloud` (`apps/server/src/lib/auth.ts` L169–L181). |
| Self-host: pull image, set `apps.yaml` | Proxied apps, no socket | OpenAPI URL not reachable from container → SELF_HOST troubleshooting (`docs/SELF_HOST.md` L463–L464). |
| Self-host: enable `hosted` + seed | Mount `docker.sock`, trust network | If Floom itself is only a container **without** socket: hosted apps fail; PRODUCT says not supported — **no first-class error message** tied to that narrative in audited files. |
| Self-host: expose to internet | Set `FLOOM_AUTH_TOKEN` | If unset, **public** run surfaces (`docs/SELF_HOST.md` L450–L451); ICP-adjacent “I thought this was private.” |

---

## 4. Risk register

| ID | Severity | Risk | Evidence |
|----|----------|------|----------|
| R-11-01 | **P0** | **Protocol marketing copy contradicts operator docs** (wrong port/image), undermining trust for self-host and “same stack” claims. | `apps/web/src/assets/protocol.md` L58–L62 vs `docs/SELF_HOST.md` L27–L34 |
| R-11-02 | **P1** | **Custom-domain cloud-style deploy** breaks credentialed flows if origin is not allow-listed and `PUBLIC_URL` / `BETTER_AUTH_URL` do not match reality. | `apps/server/src/index.ts` L68–L86, `apps/server/src/lib/better-auth.ts` L92–L95, L115–L116 |
| R-11-03 | **P1** | **OSS “everyone is authenticated” for `isAuthenticated`** when no `FLOOM_AUTH_TOKEN` — correct for product, toxic for security assumptions if a route uses the wrong helper. | `apps/server/src/lib/auth.ts` L129–L134 |
| R-11-04 | **P1** | **`FLOOM_CLOUD_MODE` without session** still returns `local` ids in context (`session.ts` L146–L153); debugging and partial-route audits can confuse “local user” with “solo OSS.” | `apps/server/src/services/session.ts` L146–L154 |
| R-11-05 | **P2** | **SELF_HOST multi-tenant prose** still says “Cloud (W3.1) will add” as if future — may stall operators who think multi-user self-host is unsupported. | `docs/SELF_HOST.md` L478–L484 (wording vs shipped `FLOOM_CLOUD_MODE`) |
| R-11-06 | **P2** | **Discoverability:** `/protocol` is wired in SPA + SSR title (`apps/server/src/index.ts` L687–L689), `/spec/*` 308 to `/protocol` (L826–L839); **SELF_HOST** is not embedded in protocol anchor copy beyond high-level Docker blurb — deep host constraints live only in PRODUCT + SELF_HOST. | Split between `apps/web/src/assets/protocol.md` §Self-hosting vs `docs/PRODUCT.md` L39–L42 |
| R-11-07 | **P2** | **OpenAPI description** references `docs/SELF_HOST.md#rate-limits` (`apps/server/src/index.ts` L252–L253) — good — but **self-host operator** discovering rate limits via `/openapi.json` only if they know that endpoint exists. | `apps/server/src/index.ts` L243–L253 |

---

## 5. Open PM questions (owner decisions)

1. **Canonical self-host command:** Should the **only** copy-paste quickstart live in `/protocol`, `SELF_HOST.md`, both in sync, or in the README with everything else linking to it?

2. **Product line:** Is **operator self-host with `FLOOM_CLOUD_MODE=true`** (private Floom with real users) a first-class SKU, or reserved for floom.dev? Docs and pricing narrative should match (affects support, CORS defaults, and whether to document `trustedOrigins` extension).

3. **Floom-in-container:** Do you want a **runtime banner or health field** (`e.g. docker_available: false`) when the server detects no Docker socket but UI advertises repo/hosted features — or keep “silent failure” to avoid noise for proxied-only users?

4. **ICP vs operator segmentation:** Should the **marketing site** ever mention `FLOOM_CLOUD_MODE`, or only “Floom.dev account” vs “run your own (advanced)” with a single link to SELF_HOST?

5. **Anonymous cloud sessions:** Is the **intentional** use of `local` workspace id for pre-auth cloud traffic stable long-term, or should PM specify a dedicated `anonymous` sentinel for analytics and support tooling?

6. **Single binary narrative:** Ship messaging as **“one Docker image, two modes”** explicitly in About/Protocol, or avoid “binary” language and say **“one server process + optional static bundle”** (`apps/server/src/index.ts` L601–L607, L906–L914 backend-only branch)?

---

## 6. Cross-references

- `docs/product-audit/deep/INDEX.md` — pd-11 row.
- Related audits: **pd-03** (Docker operator story), **pd-07** (workspaces/identity), **pd-20** (/protocol vs docs productization).

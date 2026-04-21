# rh-03 — Config and env drift

**Audit type:** Repo-hygiene (read-only).
**Source of truth:** `apps/server/src/**/*.ts` runtime reads +
`apps/server/src/lib/rate-limit.ts` (`envNumber(...)` wrapper), plus
`apps/web/vite.config.ts` for build-time Sentry vars;
`docker/.env.example` (276 lines), `docker/docker-compose.yml`,
`docker/Dockerfile`, and `docs/SELF_HOST.md` as the operator-facing
contract.
**Repo snapshot:** branch `docs/hygiene-and-docs-audit-2026-04-20`.

## Executive summary

The server reads **~50 distinct environment variables** at runtime.
`docker/.env.example` declares **66**, `docker-compose.yml` sets **5**,
and `docs/SELF_HOST.md` documents a subset. The overlap is mostly good
(most security-critical variables show up in all three places) but
there are three concrete drift patterns:

1. **Read-but-not-declared**: `FLOOM_STORE_HIDE_SLUGS`,
   `FLOOM_TRIGGERS_POLL_MS`, `FLOOM_DISABLE_TRIGGERS_WORKER`,
   `PUBLIC_ORIGIN` — all read in `apps/server/src/**` but absent from
   `docker/.env.example` and `docker-compose.yml`.
2. **Declared-but-not-read**: `FLOOM_MAGIC_LINK_EMAIL_FROM` — appears
   only in `docker/.env.example:96`; no code reads it. Dead
   declaration.
3. **Image tag drift**: `docker/docker-compose.yml:15` pins
   `ghcr.io/floomhq/floom:v0.3.0`; `docs/SELF_HOST.md:35` quickstart
   uses `ghcr.io/floomhq/floom-monorepo:v0.4.0-minimal.6` — different
   image **name** and different major version. Operators will
   experience "works with quickstart, broken with compose".

## Executive truth table

| # | Expectation (evidence) | Reality (evidence) | Verdict |
|---|------------------------|--------------------|---------|
| 1 | Every `process.env.*` read in `apps/server/src` has a documented default or placeholder in `docker/.env.example` (276 lines). | `FLOOM_STORE_HIDE_SLUGS` read at `apps/server/src/routes/hub.ts:495`; `PUBLIC_ORIGIN` read at `apps/server/src/index.ts:634` and `routes/triggers.ts:44`; `FLOOM_TRIGGERS_POLL_MS` read in server; `FLOOM_DISABLE_TRIGGERS_WORKER` read in server. **None** are in `docker/.env.example`. | **Drift** |
| 2 | `docs/SELF_HOST.md` documents every operator-visible flag. | `FLOOM_STORE_HIDE_SLUGS` documented at `docs/SELF_HOST.md:64` but missing from `docker/.env.example`. Opposite drift: operator can learn about it in the docs but not from copying the example file. | **Drift** |
| 3 | `docker/.env.example` does not ship dead declarations. | `FLOOM_MAGIC_LINK_EMAIL_FROM` declared at `docker/.env.example:96`; repo-wide grep shows **no code reader**. Dead. | **Contradicted** |
| 4 | `docker/docker-compose.yml` and `docs/SELF_HOST.md` pin the same image tag and repository. | `docker/docker-compose.yml:15` → `ghcr.io/floomhq/floom:v0.3.0`. `docs/SELF_HOST.md:35` → `ghcr.io/floomhq/floom-monorepo:v0.4.0-minimal.6`. Different image name **and** different major version. | **Contradicted** |
| 5 | Rate-limit tunables read via `envNumber('FLOOM_RATE_LIMIT_*', default)` in `apps/server/src/lib/rate-limit.ts:34,36,38,40` are declared in `.env.example`. | Yes — `.env.example` lists `FLOOM_RATE_LIMIT_IP_PER_HOUR`, `_USER_PER_HOUR`, `_APP_PER_HOUR`, `_MCP_INGEST_PER_DAY`. Wrapper hides these from naive `process.env.*` regex scans; this is the reason they at first appear "declared but not used". | **Met** |
| 6 | Composio OAuth configs for all providers listed in `.env.example` are actually read. | `apps/server/src/services/composio.ts:94` builds `\`COMPOSIO_AUTH_CONFIG_${provider.toUpperCase()}\`` dynamically — any provider the caller passes in will be looked up. `.env.example` ships 12 providers; there is no enumerated list in code tying the 12 to actual active providers. | **Partial** (dynamic read, static list drift risk) |
| 7 | `FLOOM_AUTH_TOKEN`, `FLOOM_MASTER_KEY`, `FLOOM_FEEDBACK_SALT`, `FLOOM_FEEDBACK_ADMIN_KEY` documented as security-critical in one place. | All four in `.env.example`; `FLOOM_AUTH_TOKEN` also in `docker-compose.yml:32` (commented), `docs/SELF_HOST.md` Rate limits section; `FLOOM_MASTER_KEY` + secrets-admin callouts live across `.env.example` + `docs/SELF_HOST.md` + `docs/product-audit/deep/pd-06-secrets-trust-contract.md`. | **Met** |
| 8 | Build-time Sentry vars (`SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT`) live only in `vite.config.ts` and `Dockerfile`, not in runtime `process.env.*`. | Confirmed: `apps/web/vite.config.ts:12–14` and `docker/Dockerfile:50–56` are the only references. `.env.example` also declares them — **correct** (Docker build arg). | **Met** |
| 9 | `VITE_POSTHOG_KEY` is declared as a build-time knob. | Code reference at `apps/web/src/lib/onboarding.ts:168` is a **comment only** — *"…VITE_POSTHOG_KEY by another workstream"*. `.env.example` does not declare it. Runtime relies on an external `<script>` tag exposing `window.posthog`. | **Drift (by design?)** |
| 10 | `NODE_ENV` is treated as a runtime knob, documented. | Read in 6+ server files (`lib/sentry.ts:55,67`, `lib/better-auth.ts:124`, `lib/rate-limit.ts:211,227`, `index.ts:73`, `services/renderer-bundler.ts:491`) and set in `apps/server/src/services/docker.ts:75` Dockerfile. Not declared in `.env.example` but conventional. | **Met** (conventional) |

---

## Concrete findings

### A. Drift — read in server, not declared in `.env.example`

For each variable, location of the read is given as `path:line`.

| Variable | Server read | In `.env.example`? | In `compose`? | In `SELF_HOST.md`? |
|----------|-------------|--------------------|---------------|---------------------|
| `FLOOM_STORE_HIDE_SLUGS` | `apps/server/src/routes/hub.ts:495` | **No** | **No** | Yes (`docs/SELF_HOST.md:64`) |
| `FLOOM_TRIGGERS_POLL_MS` | `apps/server/src/*triggers*` | **No** | **No** | **No** |
| `FLOOM_DISABLE_TRIGGERS_WORKER` | server workers | **No** | **No** | **No** |
| `PUBLIC_ORIGIN` | `apps/server/src/index.ts:634`, `routes/triggers.ts:44` | **No** (only `PUBLIC_URL`) | **No** | **No** |

Source methodology: `rg -oE 'process\.env\.[A-Z_][A-Z0-9_]+' apps/server/src` → sort -u → diff against `.env.example`. The four above fell out of the diff and none of them are read via the `envNumber()` helper, so they really are undeclared.

### B. Declared in `.env.example` but not read anywhere

| Variable | Line in `.env.example` | Code readers |
|----------|------------------------|--------------|
| `FLOOM_MAGIC_LINK_EMAIL_FROM` | `docker/.env.example:96` | **None** (repo-wide grep returns only the `.env.example` line) |

All other variables that looked unread on first pass actually resolved to either the `envNumber()` wrapper (`FLOOM_RATE_LIMIT_*`, `FLOOM_TRUSTED_PROXY_CIDRS`, `FLOOM_TRUSTED_PROXY_HOP_COUNT`) or dynamic `process.env[\`COMPOSIO_AUTH_CONFIG_${...}\`]` reads (`composio.ts:94`) or build-time / Dockerfile ARGs (`SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT`, `VITE_SENTRY_DSN`, `GITHUB_TOKEN` for the runtime package).

### C. Image / tag drift

- `docker/docker-compose.yml:15` — `image: ghcr.io/floomhq/floom:v0.3.0`.
- `docs/SELF_HOST.md:35` — quickstart runs `ghcr.io/floomhq/floom-monorepo:v0.4.0-minimal.6`.
- `.github/workflows/publish-image.yml` (see rh-04) publishes to `ghcr.io/floomhq/floom-monorepo` on tags.

Operator impact: copy-paste flow from the docs produces a different image than `docker compose up -d`. This is the single highest-signal doc/config drift in the repo.

### D. `.env.example` is 276 lines; 40% of content is prose

`docker/.env.example` is dense with comments that act as a mini
reference manual. This is a good pattern (contributors read the
example before reading `SELF_HOST.md`), but it means any drift in
comments becomes a documentation drift in disguise. Examples:

- `docker/.env.example:64–69` — prose about `FAST_APPS_HOST` /
  `FAST_APPS_PORT` default to `127.0.0.1:4200`. `apps/server/src`
  confirms the defaults but no doc outside this file spells it out.
- `docker/.env.example:124` — inline `<YOUR_PUBLIC_URL>/api/connections/callback`
  placeholder. This is the **only** location that documents the
  Composio callback URL shape; `docs/SELF_HOST.md` does not mirror it.

### E. `VITE_POSTHOG_KEY` is a soft env

`apps/web/src/lib/onboarding.ts:168` calls out the variable in prose
only: *"…VITE_POSTHOG_KEY by another workstream"*. The runtime check
is `typeof window.posthog !== 'undefined'` — PostHog is expected to
inject itself via `<script>`. `.env.example` does not declare
`VITE_POSTHOG_KEY` at all. Self-hosters wanting the same analytics
posture must either inject the script tag themselves or guess.

### F. `docker-compose.yml` is mostly commented-out guidance

`docker-compose.yml:26–60` is ~34 lines of comments enumerating env
vars with default values but **all commented out**. Only five envs are
set non-commented: `PORT`, `DATA_DIR`, `FLOOM_APPS_CONFIG`. Everything
else lives as inline docs. This makes the file a worse copy-paste
starter than the `docker run` example in `docs/SELF_HOST.md`, and
contributes to the image-tag drift (operators who reach for compose
get `v0.3.0`; operators who follow the docs get `v0.4.0-minimal.6`).

### G. `NODE_ENV` set in the runtime container image

`apps/server/src/services/docker.ts:75` emits `ENV NODE_ENV=production`
into the Floom **per-app** runner image. The host server also reads
`NODE_ENV` in five+ locations. No `.env.example` line for it — treated
as conventional, which is fine, but worth noting because it influences
Sentry environment tag (`lib/sentry.ts:55`) and Better Auth cookie
security (`lib/better-auth.ts:124`).

### H. Zero `.env.local` / `.env.development` conventions

There is no `.env.development`, `.env.local`, or equivalent. Dev
guidance is implicit: `apps/server/package.json`'s `dev` script assumes
the developer has exported the right envs. For a repo whose ICP is
*"non-developer AI engineer"*, this is worth revisiting — though
targeted squarely at contributor onboarding, not operator hosting.

---

## Risk register

| ID | Sev | Risk | Evidence |
|----|-----|------|----------|
| R1 | P0 | **Compose vs docs image drift** — self-hosters get different Floom versions depending on which doc they follow. | `docker/docker-compose.yml:15` vs `docs/SELF_HOST.md:35` |
| R2 | P1 | **`FLOOM_STORE_HIDE_SLUGS` undocumented** in the file every operator copies. `SELF_HOST.md:64` mentions it but `.env.example` does not. | `apps/server/src/routes/hub.ts:495`; `docker/.env.example` |
| R3 | P1 | **`PUBLIC_ORIGIN` undocumented** anywhere operator-facing; `PUBLIC_URL` is the only documented knob. Consumers of MCP webhooks and trigger URLs may set the wrong one. | `apps/server/src/index.ts:634`, `routes/triggers.ts:44`; not in `.env.example`, `compose`, or `SELF_HOST.md` |
| R4 | P1 | **`FLOOM_TRIGGERS_POLL_MS`, `FLOOM_DISABLE_TRIGGERS_WORKER` undocumented** — triggers is an actively-developed surface, operators can't tune or disable it without reading the source. | server code; not in docs |
| R5 | P2 | **`FLOOM_MAGIC_LINK_EMAIL_FROM` is a dead declaration** — looks like a tunable, isn't. | `docker/.env.example:96` |
| R6 | P2 | **`VITE_POSTHOG_KEY` referenced in code comments** but not declared anywhere — self-host analytics posture is undocumented. | `apps/web/src/lib/onboarding.ts:168`; not in `.env.example` |
| R7 | P2 | **Composio provider list in `.env.example` (12 providers) may drift** from the provider set exercised at runtime. Dynamic read hides additions. | `apps/server/src/services/composio.ts:94`; `docker/.env.example:*COMPOSIO_AUTH_CONFIG_*` |
| R8 | P2 | **Prose-heavy `.env.example`** risks doc drift silently — `docker/.env.example:124` is the only place the Composio callback URL is documented. | `docker/.env.example:124`; absent from `docs/SELF_HOST.md` |

---

## Open PM questions

1. **Compose image pin**: bump `docker/docker-compose.yml:15` to the
   same image name/tag the docs recommend (`ghcr.io/floomhq/floom-monorepo:v0.4.0-minimal.6`),
   or change the docs to match the compose pin? These must reconcile
   before any public operator test.
2. **`FLOOM_STORE_HIDE_SLUGS`**: promote to `docker/.env.example`
   (and `docker-compose.yml` comment), or demote from `SELF_HOST.md`?
3. **`PUBLIC_ORIGIN` vs `PUBLIC_URL`**: are these meant to be
   distinct (`PUBLIC_URL` = advertised URL; `PUBLIC_ORIGIN` = same
   with no trailing path) or is one a legacy alias? Current code
   picks `PUBLIC_ORIGIN ?? PUBLIC_URL` — document or collapse.
4. **Triggers worker envs** (`FLOOM_TRIGGERS_POLL_MS`,
   `FLOOM_DISABLE_TRIGGERS_WORKER`): are triggers operator-tunable
   (then document them) or internal-only (then namespace them e.g.
   `FLOOM_INTERNAL_TRIGGERS_POLL_MS` so they stop looking operator-
   facing)?
5. **`FLOOM_MAGIC_LINK_EMAIL_FROM`**: delete the dead declaration or
   wire it up? If magic-link email is on the roadmap, this was likely
   an abandoned half-step.
6. **`VITE_POSTHOG_KEY`**: make it a first-class self-host knob
   (inject script if set), or delete the comment to avoid implying
   one?

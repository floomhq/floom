# da-01 — Doc claims vs code reality

**Audit type:** Docs-hygiene audit (read-only).
**Scope:** every claim a user or operator can reach through `README.md`, `docs/*.md`, or a mounted SPA page, checked against what `apps/server` / `apps/web` / `packages/*` actually ship.
**Repo snapshot:** `origin/main` `d62a4cf`, audit branch `docs/hygiene-and-docs-audit-2026-04-20`, audit run **2026-04-20**.

## Executive summary

The marketing-level story (three surfaces, two ingest modes, MIT, paste-a-spec ingest) is accurate. The **operational-level story — the exact image tag, the exact port, the exact env-var defaults, the exact routes — is drifted in at least six places a first-day self-hoster can hit in their first ten commands**. The biggest surfaces:

1. **Four different image tags across docs and docker-compose**, two of them under a GHCR package that CI has not published in two minor releases.
2. **Rate-limit defaults in the code are 3× the numbers `docs/SELF_HOST.md` advertises**, and the `Retry-After` math a self-hoster computes from the docs will be wrong.
3. **`PUBLIC_URL` fallbacks diverge across server files** — `https://floom.dev` in the MCP router and `http://localhost:$PORT` everywhere else — which means self-host and preview MCP payloads silently advertise production URLs when `PUBLIC_URL` is unset.
4. **Two `protocol.md` files** with contradicting self-host commands both ship in the repo.
5. **`/install` page is partly fiction** — advertises port `:8787` and `POST /api/publish`, neither of which exists in the server.
6. **`docs/ROADMAP.md` says Stripe Connect is `Backend stub, UI deferred to v1.1+`, but `apps/server/src/index.ts` mounts the full `/api/stripe/*` router** — 5 shipped endpoints + webhook, plus a dedicated `docs/monetization.md` and a `Creator monetization` section in `docs/SELF_HOST.md`.

The code is ahead of the docs in some places (rate limits bumped 2026-04-19 in code but not in `docs/SELF_HOST.md`; Stripe shipped but ROADMAP still says stub), and the docs are ahead of the code in other places (`InstallPage` promises an endpoint that does not exist; `apps/web/src/assets/protocol.md` advertises port 3000 when the server runs on 3051). That bidirectional drift is the trust problem.

---

## Executive truth table

| # | Doc claim (quote + path) | Code/Reality (`file:line`) | Verdict |
|---|--------------------------|-----------------------------|---------|
| 1 | "`ghcr.io/floomhq/floom-monorepo:v0.4.0-mvp.4`" ([`README.md:87`](../../README.md)) | `docs/SELF_HOST.md:34` says `v0.4.0-minimal.6`; `docs/ROADMAP.md:16` says `v0.4.0-mvp.4`; `docker/docker-compose.yml:15` says `ghcr.io/floomhq/floom:v0.3.0` (different image name, older tag); `examples/docker-compose.proxied.yml:53` says `ghcr.io/floomhq/floom:v0.3.0` | **Contradicted** — four tags, two image names, one repo |
| 2 | "`docker run -p 3000:3000 ... ghcr.io/floomhq/floom:latest`" (`apps/web/src/assets/protocol.md:60–62`) | Server default port is `3051` (`apps/server/src/index.ts:45`: `const PORT = Number(process.env.PORT \|\| 3051);`); CI publishes to `ghcr.io/floomhq/floom-monorepo` only (`.github/workflows/publish-image.yml:43`) | **Contradicted** — wrong port, defunct image name |
| 3 | "protocol version 2024-11-05 (Claude Desktop compatible)" (`docs/SELF_HOST.md:132`) and "HTTP+SSE transport (MCP spec 2024-11-05)" (`apps/web/src/assets/protocol.md:93`) | Server imports `WebStandardStreamableHTTPServerTransport` (`apps/server/src/routes/mcp.ts:12`, `743`) — Streamable HTTP, **not** HTTP+SSE; `spec/protocol.md:238` correctly says "Streamable HTTP" | **Drift** — canonical `spec/protocol.md` correct, SPA-rendered asset stale |
| 4 | "`FLOOM_RATE_LIMIT_IP_PER_HOUR` `20`" and per-(IP,app) `50` and user `200` (`docs/SELF_HOST.md:60–63`, table `docs/SELF_HOST.md:232–237`) | Code defaults: anon **60**/hr, authed **300**/hr, per-(IP,app) **500**/hr (`apps/server/src/lib/rate-limit.ts:33–38`, comment at `:27–32` says "Defaults bumped 2026-04-19 (issue #128): prior 20/200/50 were too tight…") | **Contradicted** — doc still reflects the pre-2026-04-19 numbers |
| 5 | "`PUBLIC_URL` defaults to `http://localhost:$PORT`" (`docs/SELF_HOST.md:52`) | True in `apps/server/src/index.ts:46`, `routes/jobs.ts:127`, `services/workspaces.ts:425`; **false** in `apps/server/src/routes/mcp.ts:40` — `const PUBLIC_URL = process.env.PUBLIC_URL \|\| 'https://floom.dev';` (MCP permalinks + `mcp_url` fields silently advertise production) | **Contradicted** — doc describes one fallback, code has two |
| 6 | "Stripe Connect monetization — Backend stub, UI deferred to v1.1+" (`docs/ROADMAP.md:28`) | `apps/server/src/index.ts:203` mounts `app.route('/api/stripe', stripeRouter);` (full router at `apps/server/src/routes/stripe.ts`); `apps/server/src/index.ts:354–430` documents 6 shipped Stripe paths in `/openapi.json`; `docs/SELF_HOST.md:727–787` ships a full "Creator monetization (Stripe Connect, v0.4.0-alpha.2+)" section; `docs/monetization.md` exists | **Contradicted** — backend is fully shipped, ROADMAP says stub |
| 7 | "Async job queue UI (re-enable) … P0 launch blocker" (`docs/ROADMAP.md:33–36`) vs "Async job queue — shipped" (`docs/DEFERRED-UI.md:13`) vs "Async job queue \| Shipped (`RunSurface.tsx`, `JobProgress.tsx`)" (`docs/ROADMAP.md:26`) | `apps/web/src/components/runner/JobProgress.tsx` + `RunSurface.tsx` wire the async flow (already cross-referenced at `docs/product-audit/deep/pd-19-roadmap-p0-execution-gap.md:17`) | **Contradicted** — same `ROADMAP.md` file says "shipped" and "P0 launch blocker" four rows apart |
| 8 | "Custom renderer upload — Shipped (`CustomRendererPanel.tsx`)" (`docs/ROADMAP.md:27`) + P0 item "Custom renderer upload UI (re-enable)" (`docs/ROADMAP.md:36`) | `apps/web/src/components/CustomRendererPanel.tsx` wired into `BuildPage.tsx`, `StudioAppRendererPage.tsx`, `CreatorAppPage.tsx` (`docs/DEFERRED-UI.md:30–33`) | **Contradicted** — roadmap table + P0 list disagree |
| 9 | "`POST /api/publish` … Point an OpenAPI spec … Floom wraps it into a runnable app" (`apps/web/src/pages/InstallPage.tsx:62–69`) | **No `/api/publish` route is mounted.** `apps/server/src/index.ts:167–222` lists every mounted router; `/api/hub/ingest` is the real ingest endpoint (`apps/server/src/routes/hub.ts`, documented in `spec/protocol.md:308`). Grep confirms `/api/publish` exists nowhere else in the repo. | **Missing** — doc promises an endpoint that does not exist |
| 10 | "The server comes up on `http://localhost:8787`" (`apps/web/src/pages/InstallPage.tsx:56`) | Server binds `3051` by default (`apps/server/src/index.ts:45`), and every other doc, compose file, `.env.example`, curl sample, and test (`docker/.env.example:8`, `docs/SELF_HOST.md:34,42`, `README.md:82–90`) uses 3051 | **Contradicted** — one live page lies about the port |
| 11 | "`ghcr.io/floomhq/floom:<prev>`" rollback runbook (`docs/ROLLBACK.md:69, 83, 100, 101, 116, 125, 166`) | CI publishes **only** `ghcr.io/floomhq/floom-monorepo` on `v*` tags (`.github/workflows/publish-image.yml:37–46`: "the `floom` package belongs to a different project, so switching target here breaks the build"); no `floom/floom` tag exists after v0.3.2 | **Drift** — runbook is writing to a package CI does not publish |
| 12 | "Self-host image: `ghcr.io/floomhq/floom-monorepo:v0.4.0-mvp.4` (CI publishes on `v*` tags)" (`docs/ROADMAP.md:16`) | `publish-image.yml:44–46` tags `type=ref,event=tag` + `latest` on v-prefixed tags. An `mvp.4` tag is a valid `type=ref` output; a `minimal.6` tag is also valid. But **both tags exist on the registry only if someone cut both tags** — the audit cannot prove one over the other without network access. Evidence the correct answer is **mvp.4**: `apps/server/package.json:3` reads `"version": "0.4.0-mvp.5"` (one step ahead of `mvp.4`). Evidence `minimal.6` is real: `docs/SELF_HOST.md:34,424` uses it twice. | **Drift — needs owner decision** on the canonical stream name |
| 13 | "Four MCP admin tools at `/mcp` root: `ingest_app`, `list_apps`, `search_apps`, `get_app`" (`docs/ROADMAP.md:14`, mirrored in `README.md:34` and `docs/SELF_HOST.md:178–183`) | `apps/server/src/routes/mcp.ts:760–764` also mounts **`/mcp/search`** — a fifth surface. `spec/protocol.md:234–236` lists it; ROADMAP and README do not. | **Drift** — fifth MCP surface exists, README + ROADMAP under-count |
| 14 | README links self-host to `./docs/SELF_HOST.md` and protocol to `./spec/protocol.md` (`README.md:19–20`) | Both files exist; `spec/protocol.md` is 360 lines and canonical. `apps/web/src/assets/protocol.md` (102 lines) is a **second, diverging copy** loaded by the SPA at `/protocol` (`apps/web/src/pages/ProtocolPage.tsx:9`: `import protocolMd from '../assets/protocol.md?raw';`). A visitor on GitHub reads the 360-line version; a visitor on `floom.dev/protocol` reads the 102-line version. | **Contradicted** — two canonical-looking docs |
| 15 | "/spec and /spec/* are server-side 308 redirects to /protocol (wired in `apps/server/src/index.ts`). No client route needed" (`apps/web/src/main.tsx:169–171`) | `apps/server/src/index.ts:842–852` implements the redirect; server wiring matches the comment. | **Met** — verified |
| 16 | "per-app MCP tool calls" (`apps/server/src/index.ts:157`) advertises `POST /mcp/app/:slug` | Route is `all()` not `post()` (`apps/server/src/routes/mcp.ts:767`: `mcpRouter.all('/app/:slug', …)`). Matches MCP spec but the server comment and `spec/protocol.md:167` ("Rate-limited routes … `/mcp/app/:slug`") consistently describe it as POST. | **Drift** — minor |
| 17 | "v0.3.1 ships a `floom_device` cookie (HttpOnly, SameSite=Lax, 10-year TTL)" (`docs/SELF_HOST.md:545–547`) | `apps/server/src/services/session.ts:26`: `const COOKIE_NAME = 'floom_device';` — matches. **But** the user-facing cookie disclosure in `apps/web/src/pages/CookiesPage.tsx:18–46` never lists `floom_device` at all; it claims the only strictly-necessary session cookie is `floom.session` (a name that exists nowhere else in the codebase). | **Contradicted + legal surface** — see da-05 |

---

## Concrete findings

### F1 — Image tag + GHCR name drift is live in four places at once

Evidence:

- [`README.md:87`](../../README.md): `ghcr.io/floomhq/floom-monorepo:v0.4.0-mvp.4`
- [`docs/SELF_HOST.md:34`](../SELF_HOST.md): `ghcr.io/floomhq/floom-monorepo:v0.4.0-minimal.6`
- [`docs/SELF_HOST.md:424`](../SELF_HOST.md): `ghcr.io/floomhq/floom-monorepo:v0.4.0-minimal.6` (compose sample)
- [`docs/ROADMAP.md:16`](../ROADMAP.md): `ghcr.io/floomhq/floom-monorepo:v0.4.0-mvp.4`
- [`docker/docker-compose.yml:15`](../../docker/docker-compose.yml): `ghcr.io/floomhq/floom:v0.3.0` — **different image name, two minor versions old**
- [`examples/docker-compose.proxied.yml:53`](../../examples/docker-compose.proxied.yml): `ghcr.io/floomhq/floom:v0.3.0` — same drift
- [`apps/web/src/pages/ProtocolPage.tsx:708`](../../apps/web/src/pages/ProtocolPage.tsx): `ghcr.io/floomhq/floom-monorepo:latest` (port 3051)
- [`apps/web/src/assets/protocol.md:60–62`](../../apps/web/src/assets/protocol.md): `ghcr.io/floomhq/floom:latest` (port 3000)

CI publishes to [`ghcr.io/floomhq/floom-monorepo`](../../.github/workflows/publish-image.yml#L37-L46) only. The comment at `publish-image.yml:37–42` is explicit: `the 'floom' package belongs to a different project, so switching target here breaks the build`. Therefore every `ghcr.io/floomhq/floom:*` reference in the repo (`docker/docker-compose.yml`, `examples/docker-compose.proxied.yml`, `apps/web/src/assets/protocol.md`, and every line in `docs/ROLLBACK.md`) is pointing at a package **Floom does not own**.

`apps/server/package.json:3` reads `"version": "0.4.0-mvp.5"` — one tick ahead of the `mvp.4` tag quoted in README/ROADMAP. `docs/SELF_HOST.md:881` reads `v0.4.0-alpha.2 (April 2026): Stripe Connect partner app`, describing a **third** tag-stream prefix (`alpha` vs `mvp` vs `minimal`).

**Verdict:** four coexisting tag streams (`mvp.4`, `mvp.5`, `minimal.6`, `alpha.2`) with no doc that picks one. A self-hoster following README, then docker-compose, then SELF_HOST.md will pull three different images.

### F2 — Rate-limit defaults: docs say 20/200/50, code says 60/300/500

Evidence:

- Docs (`docs/SELF_HOST.md:60`): "`FLOOM_RATE_LIMIT_IP_PER_HOUR` `20`" — repeated in the table at `docs/SELF_HOST.md:232–237` (`20/hr / 200/hr / 50/hr`).
- Code (`apps/server/src/lib/rate-limit.ts:27–40`):
  ```
  // Defaults bumped 2026-04-19 (issue #128): prior 20/200/50 were too tight for
  // headless/integration/CI use and NAT'd offices.
  envNumber('FLOOM_RATE_LIMIT_IP_PER_HOUR', 60);
  envNumber('FLOOM_RATE_LIMIT_USER_PER_HOUR', 300);
  envNumber('FLOOM_RATE_LIMIT_APP_PER_HOUR', 500);
  ```
- `spec/protocol.md:166` is **correct**: "Defaults: anon 60/hr per IP, authed 300/hr per user, 500/hr per (IP, app)."
- `docs/product-audit/deep/pd-19-roadmap-p0-execution-gap.md:19` also quotes the **pre-bump** numbers ("anon 60/hr default" there is approximate; the `pd-19` audit pre-dates the issue #128 bump comment and should be re-verified).

**Impact:** A developer who computes their `Retry-After` budget from `SELF_HOST.md` is working against numbers the server no longer enforces. This is a low-severity bug but it undermines every downstream trust signal in the env-var table.

### F3 — `PUBLIC_URL` fallback divergence — MCP router points at production

Evidence:

- [`apps/server/src/index.ts:46`](../../apps/server/src/index.ts): `const PUBLIC_URL = process.env.PUBLIC_URL \|\| \`http://localhost:${PORT}\`;`
- [`apps/server/src/routes/jobs.ts:127`](../../apps/server/src/routes/jobs.ts): same fallback, `http://localhost:$PORT`.
- [`apps/server/src/routes/triggers.ts:43`](../../apps/server/src/routes/triggers.ts): same.
- [`apps/server/src/services/workspaces.ts:425`](../../apps/server/src/services/workspaces.ts): same.
- [`apps/server/src/lib/better-auth.ts:95`](../../apps/server/src/lib/better-auth.ts): same.
- **But** [`apps/server/src/routes/mcp.ts:40`](../../apps/server/src/routes/mcp.ts): `const PUBLIC_URL = process.env.PUBLIC_URL \|\| 'https://floom.dev';`

The MCP `ingest_app`, `list_apps`, `search_apps`, and `get_app` tools build `permalink` and `mcp_url` fields off that constant (`mcp.ts:332–333, 504–505, 635–636, 729`). A self-hoster or preview deployment that forgets `PUBLIC_URL` will have the admin MCP tools return `https://floom.dev/p/<slug>` and `https://floom.dev/mcp/app/<slug>` — pointing at **production** — even when the caller hit a local or staging instance.

`docs/SELF_HOST.md:52` says `PUBLIC_URL` defaults to `http://localhost:$PORT`. It does not. Operators who rely on the default get production URLs in agent-visible responses, which is both a UX bug and a minor trust/abuse surface (agents following the returned permalink will cross origins silently).

**Suggested resolution (for the owner):** decide whether the MCP fallback should match the rest of the server (`localhost:$PORT`) or whether `SELF_HOST.md` should document both fallbacks. Either change is single-line.

### F4 — Dual `protocol.md` with contradicting self-host commands

Two files both called `protocol.md` ship in the repo:

| Path | Line count | Self-host command |
|------|------------|--------------------|
| [`spec/protocol.md`](../../spec/protocol.md) | 360 (`spec/protocol.md:1–360`) | linked as the canonical protocol from `README.md:20`, `docs/README.md:5` |
| [`apps/web/src/assets/protocol.md`](../../apps/web/src/assets/protocol.md) | 102 (`apps/web/src/assets/protocol.md:1–102`) | `docker run -p 3000:3000 ghcr.io/floomhq/floom:latest` (`:60–62`) |

`apps/web/src/pages/ProtocolPage.tsx:9` loads the **102-line** file into the `/protocol` SPA route. `apps/web/src/pages/ProtocolPage.tsx:708` then overrides the body with a different snippet (`ghcr.io/floomhq/floom-monorepo:latest` on port 3051) in the page footer.

Net result: the `/protocol` page displays **two contradicting self-host commands to the same visitor** — one in the rendered markdown body (port 3000, image `floom`), one in the footer card (port 3051, image `floom-monorepo`). `docs/product-audit/deep/pd-20-docs-protocol-product.md:23` flagged this already and the drift has not been reconciled.

Load-bearing note: `spec/protocol.md` is **on `docs/PRODUCT.md`'s load-bearing list by virtue of defining the protocol**. Do not delete either file; pick one source and have the SPA render that one. Recommended mechanical fix is to point `ProtocolPage.tsx:9` at `../../../../spec/protocol.md?raw` via a Vite asset alias; that is a product decision, not a doc-audit action.

### F5 — `/install` page documents a wrong port and a non-existent route

[`apps/web/src/pages/InstallPage.tsx`](../../apps/web/src/pages/InstallPage.tsx) is mounted at `/install` (`apps/web/src/main.tsx:168`) and linked from `TopBar` and wireframes per its own header comment (`InstallPage.tsx:1–6`). Three factual claims on the page:

1. `InstallPage.tsx:56`: "The server comes up on `http://localhost:8787` with the dashboard served from the same host." — Server defaults to **3051** (`apps/server/src/index.ts:45`), and the matching `.env.example`/`docker-compose.yml`/README/SELF_HOST.md all say 3051.
2. `InstallPage.tsx:62–69`: promises `POST /api/publish`. That route **does not exist**. Grep across the repo for `/api/publish` returns `InstallPage.tsx` only. The real ingest surface is `/api/hub/ingest` (`apps/server/src/routes/hub.ts`, `spec/protocol.md:308`).
3. `InstallPage.tsx:53`: `pnpm --filter @floom/server dev` — this one is correct.

**Impact:** the first public page with the word "Install" in its title instructs the ICP to curl a route that 404s. This is worse than a dead link: it looks like the product is broken.

Load-bearing note: `/install` is wired in the SPA, not listed in PRODUCT.md's load-bearing table. Still, **do not delete**: the route is advertised from the TopBar and wireframes, and the header comment explicitly says "the route needed to exist (returned 404 before)". Fix in place by swapping the port + route.

### F6 — ROADMAP contradicts itself on Stripe

- [`docs/ROADMAP.md:28`](../ROADMAP.md): "Stripe Connect monetization — Backend stub, UI deferred to v1.1+"
- [`docs/ROADMAP.md:33–40`](../ROADMAP.md) P0 section: no Stripe item; OK.
- [`docs/SELF_HOST.md:727–787`](../SELF_HOST.md): full "Creator monetization (Stripe Connect, v0.4.0-alpha.2+)" section with 6 endpoints and an onboarding shell snippet.
- [`docs/SELF_HOST.md:881`](../SELF_HOST.md): "v0.4.0-alpha.2 (April 2026): Stripe Connect partner app (W3.3) — `/api/stripe/*` routes for creator monetization. … 163 new unit + integration tests."
- [`apps/server/src/index.ts:203`](../../apps/server/src/index.ts): `app.route('/api/stripe', stripeRouter);`
- [`apps/server/src/routes/stripe.ts`](../../apps/server/src/routes/stripe.ts) + [`apps/server/src/services/stripe-connect.ts`](../../apps/server/src/services/stripe-connect.ts) implement the surface.
- [`docs/monetization.md`](../monetization.md) is the per-call reference.

**Verdict:** the backend is "shipped + documented + tested", not a stub. The one line in ROADMAP is stale. The UI deferral is accurate (`docs/DEFERRED-UI.md:39–53` lists Stripe Connect UI on branch `feature/ui-stripe-connect`).

### F7 — MCP admin surface under-counts — `/mcp/search` is a fifth tool

- `README.md:34`: "Four MCP admin tools (`ingest_app`, `list_apps`, `search_apps`, `get_app`)"
- `docs/ROADMAP.md:14`: "Four MCP admin tools at `/mcp` root: `ingest_app`, `list_apps`, `search_apps`, `get_app`"
- `docs/SELF_HOST.md:178–184`: same four-row table
- `spec/protocol.md:228–236`: lists **three** endpoints (`/mcp`, `/mcp/search`, `/mcp/app/:slug`) with the fifth tool
- `apps/server/src/routes/mcp.ts:760–764`: `mcpRouter.all('/search', …)` — a dedicated gallery-wide search MCP server

Not a bug, but the "four tools" count in README/ROADMAP/SELF_HOST undersells the agent surface that `spec/protocol.md` correctly describes. Every `mcp_url` also advertises `/mcp/app/:slug` — that's the same four tools per app, not a fifth admin tool, so the truth is: **4 admin tools on `/mcp`, 1 tool on `/mcp/search`, N tools on each `/mcp/app/:slug`**.

### F8 — `docs/ROADMAP.md` "Shipped backend, UI pending" vs `docs/DEFERRED-UI.md`

Already flagged in [`pd-19-roadmap-p0-execution-gap.md:17–18`](../product-audit/deep/pd-19-roadmap-p0-execution-gap.md) but worth pinning here because it is the single largest inconsistency inside `ROADMAP.md`:

- `ROADMAP.md:26`: "Async job queue \| Shipped (`RunSurface.tsx`, `JobProgress.tsx`)"
- `ROADMAP.md:35`: "- Async job queue UI (re-enable)" under **P0 — Launch blockers**

Both lines are in the same file, nine rows apart. `DEFERRED-UI.md:13,24` also declares these two as "shipped on main". One of the three documents is wrong; a reader cannot tell which.

### F9 — MCP protocol version claim is stale

- `docs/SELF_HOST.md:132`: "Protocol version 2024-11-05 (Claude Desktop compatible)."
- `apps/web/src/assets/protocol.md:93`: "HTTP+SSE transport (MCP spec 2024-11-05)."
- `spec/protocol.md:238`: "Streamable HTTP (JSON response mode) … **not** HTTP+SSE."
- `apps/server/src/routes/mcp.ts:12`: `import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';`
- `apps/server/src/routes/mcp.ts:743`: `const transport = new WebStandardStreamableHTTPServerTransport({ ... });`

The transport string in `SELF_HOST.md` and the legacy asset is ambiguous (Streamable HTTP was introduced in the 2024-11-05 spec as the replacement for HTTP+SSE; both names coexist in vendor docs). **Load-bearing per MCP interop** — reconcile the two transport names in `SELF_HOST.md` + `apps/web/src/assets/protocol.md` against `spec/protocol.md`.

### F10 — Image pin in SECURITY.md + issue template vs CI reality

- `SECURITY.md:33`: "Docker image `ghcr.io/floomhq/floom-monorepo`" ✅ matches CI.
- `.github/ISSUE_TEMPLATE/bug_report.md:24`: "Floom version or image tag: `ghcr.io/floomhq/floom-monorepo:...`" ✅ matches CI.
- **But** `docs/ROLLBACK.md:21, 22, 69, 83, 100, 101, 116, 125, 166` all use the legacy name `ghcr.io/floomhq/floom:*`.

`docs/ROLLBACK.md` is a production runbook used in release drills (`docs/ROLLBACK.md:54–93`); running `sed -i 's|ghcr.io/floomhq/floom:.*|ghcr.io/floomhq/floom:v0.2.0|' docker-compose.yml` as written on `docs/ROLLBACK.md:22` on a live box with the new image will **silently no-op** (the sed pattern does not match `ghcr.io/floomhq/floom-monorepo:*`) and the deploy will keep running the broken tag.

### F11 — `WORKPLAN-20260414-W1.2-job-queue.md` is non-load-bearing root noise

- Repo root: [`WORKPLAN-20260414-W1.2-job-queue.md`](../../WORKPLAN-20260414-W1.2-job-queue.md) (first line: "W1.2 — Floom job queue primitive (v0.3.0)").
- `docs/PRODUCT.md:62–63` explicitly flags "Sprint-specific workplan / handoff docs at repo root (they should live in PR descriptions or be deleted once merged)" as **non-load-bearing, safe to prune**.

Not a drift; listing here for completeness and to flag it at P2 severity in the risk register.

### F12 — `/api/deploy-github` route missing, runtime README honest about it

Already in [`pd-19`](../product-audit/deep/pd-19-roadmap-p0-execution-gap.md:23): `docs/ROADMAP.md:40` still-to-land wording is accurate. `packages/runtime/README.md` honestly lists the `/build` "host this repo" tile as not wired. **No doc drift here; listed so the reader of this audit does not re-flag it.**

### F13 — JSON OpenAPI doc at `/openapi.json` drifts from other docs on Stripe

[`apps/server/src/index.ts:246–430`](../../apps/server/src/index.ts) hand-writes the `/openapi.json` document. It correctly lists `/api/stripe/*`, `/api/connections/*`, `/api/memory/*`, `/api/secrets`, etc. That file is **more accurate than `docs/ROADMAP.md`** about what the server ships — a self-hoster running `curl host/openapi.json | jq '.paths | keys'` will see Stripe endpoints their own roadmap claims don't exist.

Not a bug on its own; it is strong evidence for closing F6.

---

## Risk register

| ID | Sev | Risk | Evidence |
|----|-----|------|----------|
| da1-R1 | **P0** | A self-hoster following `docker/docker-compose.yml` pulls `ghcr.io/floomhq/floom:v0.3.0` (a package CI no longer publishes) and either boots a v0.3.0 image missing Stripe/connections/custom-renderer or fails to pull at all. ICP breakage on the "60-second self-host" promise. | `docker/docker-compose.yml:15`, `.github/workflows/publish-image.yml:37–46`, `README.md:66–90` |
| da1-R2 | **P0** | `/install` page advertises `localhost:8787` and `POST /api/publish`. First CLI user runs both commands, both fail. | `apps/web/src/pages/InstallPage.tsx:56,62–69`; `apps/server/src/index.ts:45, 167–222` |
| da1-R3 | **P0** | Self-host MCP admin tools silently return `https://floom.dev/...` URLs when `PUBLIC_URL` is unset — agents pivot to production without the operator noticing. Privacy + trust surface. | `apps/server/src/routes/mcp.ts:40, 332–333, 504–505, 635–636, 729`; `docs/SELF_HOST.md:52` |
| da1-R4 | **P1** | Rate-limit doc table is 3× too low — docs-driven capacity planning is wrong by 3×. | `docs/SELF_HOST.md:60–63, 232–237`; `apps/server/src/lib/rate-limit.ts:27–40` |
| da1-R5 | **P1** | Two `protocol.md` files, both live. The public `/protocol` page renders the shorter one and contradicts itself inside a single viewport (port 3000 in body, port 3051 in footer). | `spec/protocol.md`, `apps/web/src/assets/protocol.md:60–62`, `apps/web/src/pages/ProtocolPage.tsx:9, 708` |
| da1-R6 | **P1** | ROADMAP + DEFERRED-UI contradict on async queue and custom renderer. Stakeholders cannot tell what is P0 remaining vs shipped. | `docs/ROADMAP.md:26, 35, 36`; `docs/DEFERRED-UI.md:13, 24` |
| da1-R7 | **P1** | `docs/ROLLBACK.md` sed pattern silently no-ops on the real image name. Release drills run from this runbook will not catch a broken promotion. | `docs/ROLLBACK.md:22, 100–125` |
| da1-R8 | **P2** | `docs/ROADMAP.md:28` says Stripe Connect backend is a stub; `/openapi.json` and `docs/SELF_HOST.md` prove it is shipped. Roadmap credibility eroded for contributors. | `docs/ROADMAP.md:28`; `apps/server/src/index.ts:203, 354–430`; `docs/monetization.md` |
| da1-R9 | **P2** | Four simultaneous tag streams (`mvp.4`, `mvp.5`, `minimal.6`, `alpha.2`) with no public doc explaining which is "the" release. | `README.md:87`, `docs/SELF_HOST.md:34, 881`, `apps/server/package.json:3`, `docs/ROADMAP.md:16` |
| da1-R10 | **P2** | README/ROADMAP/SELF_HOST under-count MCP admin surface (4 tools; actually 4 + `/mcp/search`). Agent-first positioning weakened. | `README.md:34`, `docs/ROADMAP.md:14`, `docs/SELF_HOST.md:178–184`; `apps/server/src/routes/mcp.ts:760–764` |
| da1-R11 | **P2** | `WORKPLAN-20260414-W1.2-job-queue.md` at repo root is the kind of file `PRODUCT.md:62–63` calls "safe to prune". Keeping it implies current-state importance it no longer has. | Repo root, `docs/PRODUCT.md:62–63` |
| da1-R12 | **P2** | Transport name drift ("HTTP+SSE" vs "Streamable HTTP"). Wrong but not fatal — MCP clients negotiate. | `docs/SELF_HOST.md:132`, `apps/web/src/assets/protocol.md:93`, `spec/protocol.md:238`, `apps/server/src/routes/mcp.ts:12` |

---

## Open PM questions

1. **Canonical image tag.** Which of `v0.4.0-mvp.4`, `v0.4.0-mvp.5`, `v0.4.0-minimal.6`, `v0.4.0-alpha.2` is "the" public tag as of 2026-04-20? Once the answer is chosen, every offender in F1 + `docs/ROLLBACK.md` (F10) can be mechanically fixed in one PR.
2. **Canonical image name.** Rename `ghcr.io/floomhq/floom-monorepo` to `ghcr.io/floomhq/floom`, or retire the latter everywhere? CI comment at `.github/workflows/publish-image.yml:37–42` says "The repo rename (floom-monorepo → floom) is docs-only; the image stays on the monorepo name until we migrate packages explicitly." — decision still open.
3. **`PUBLIC_URL` fallback in MCP router.** Should it match the rest of the server (`http://localhost:$PORT`) or stay at `https://floom.dev` on purpose? If the latter, `docs/SELF_HOST.md:52` must document both fallbacks and the operator warning.
4. **`/install` page scope.** Kill the `localhost:8787` + `/api/publish` copy and point at `/api/hub/ingest` + port 3051 (load-bearing per the TopBar link per `InstallPage.tsx:1–6`), or replace with a minimal "CLI coming soon" stub? Either is a 10-minute change.
5. **Dual `protocol.md`.** Point the SPA at `spec/protocol.md` via a Vite raw-asset alias and delete the 102-line copy? The shorter copy is **not** on the load-bearing list; it is a cached duplicate.
6. **ROADMAP P0 rewrite.** Either flip async-queue and custom-renderer lines from "P0 — Launch blockers" to "shipped" (matching `DEFERRED-UI.md`) or rewrite both DEFERRED-UI rows as "shipped on main — remaining P0 work is X, Y". Same decision covers the Stripe row.

---

## Source index

| Area | Paths (non-exhaustive) |
|------|------------------------|
| Image tag drift | `README.md:87`, `docs/ROADMAP.md:16`, `docs/SELF_HOST.md:34, 424, 881`, `docker/docker-compose.yml:15`, `examples/docker-compose.proxied.yml:53`, `apps/web/src/pages/ProtocolPage.tsx:708`, `apps/web/src/assets/protocol.md:60–62`, `docs/ROLLBACK.md:21, 22, 69, 83, 100, 101, 116, 125, 166`, `.github/workflows/publish-image.yml:37–46`, `apps/server/package.json:3` |
| Rate-limit drift | `docs/SELF_HOST.md:60–63, 232–237`, `apps/server/src/lib/rate-limit.ts:27–40`, `spec/protocol.md:166` |
| PUBLIC_URL drift | `apps/server/src/index.ts:46`, `apps/server/src/routes/mcp.ts:40, 332–333, 504–505, 635–636, 729`, `apps/server/src/routes/jobs.ts:127`, `apps/server/src/services/workspaces.ts:425`, `apps/server/src/routes/triggers.ts:43`, `apps/server/src/lib/better-auth.ts:95`, `docs/SELF_HOST.md:52` |
| Dual protocol | `spec/protocol.md:1–360`, `apps/web/src/assets/protocol.md:1–102`, `apps/web/src/pages/ProtocolPage.tsx:9, 708`, `docs/product-audit/deep/pd-20-docs-protocol-product.md:23` |
| `/install` lies | `apps/web/src/pages/InstallPage.tsx:1–100`, `apps/server/src/index.ts:45, 167–222` |
| Stripe shipped vs stub | `docs/ROADMAP.md:28`, `apps/server/src/index.ts:203, 354–430`, `apps/server/src/routes/stripe.ts`, `docs/SELF_HOST.md:727–787, 881`, `docs/monetization.md` |
| MCP surfaces | `README.md:34`, `docs/ROADMAP.md:14`, `docs/SELF_HOST.md:178–184`, `apps/server/src/routes/mcp.ts:760–767`, `spec/protocol.md:228–236` |
| `/spec` redirect | `apps/web/src/main.tsx:169–171`, `apps/server/src/index.ts:838–852` |
| `floom_device` vs `floom.session` | `apps/server/src/services/session.ts:26`, `apps/web/src/pages/CookiesPage.tsx:18–46` (see da-05) |

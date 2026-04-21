# da-03 — OpenAPI / JSON / MCP narrative alignment

**Scope:** how Floom's three programmatic surfaces — the **OpenAPI self-describe doc** at `/openapi.json`, the **canonical protocol spec** at [`spec/protocol.md`](../../spec/protocol.md), and the **MCP server** under `/mcp/*` — line up across what the docs say, what the SPA renders at `/protocol`, and what the code actually exposes.
**Audit run:** 2026-04-20, against `origin/main` `d62a4cf`.

## Executive summary

Three parallel narratives describe "how to talk to Floom programmatically":

1. **`spec/protocol.md`** — 360 lines, dated `2026-04-19` (`spec/protocol.md:3`). Correct, current, canonical. Lists three MCP endpoints, Streamable HTTP transport, rate-limit truth, ingest at `/api/hub/ingest`.
2. **`/openapi.json`** — hand-written in `apps/server/src/index.ts:246–437` and served at `GET /openapi.json`. Lists 19 concrete HTTP paths with summaries. More accurate than `docs/ROADMAP.md` on Stripe (six Stripe routes listed and shipped, ROADMAP still calls Stripe "backend stub").
3. **`apps/web/src/assets/protocol.md`** — 102 lines, served by the SPA at `/protocol` via [`apps/web/src/pages/ProtocolPage.tsx:9`](../../apps/web/src/pages/ProtocolPage.tsx). Pre-Stripe, pre-Composio, pre-multi-tenant. Advertises `/api/pick`, `/api/parse`, `/api/thread` (alive on the server but dead in the web client per [`rh-01-unused-and-dead-surface.md:33`](../repo-hygiene-audit/rh-01-unused-and-dead-surface.md)). Calls the MCP transport "HTTP+SSE" (wrong).

The ProtocolPage component then **renders doc 3's body and overrides the footer with a snippet that contradicts doc 3's body** (port 3000 vs 3051, `floom` vs `floom-monorepo`; see [`da-01-doc-code-truth.md:109`](./da-01-doc-code-truth.md)). A single human user scrolling one page sees two contradicting stories.

Meanwhile, `/openapi.json` — the one place the server is forced to be honest about its routes because it's machine-readable — is **the most accurate doc of the three**, but it is linked nowhere in the docs tree, linked nowhere from the TopBar, and its existence is mentioned only inside an internal prose comment on `apps/server/src/index.ts:244`. A reader who wants to know "what can I actually call?" has no doc telling them to `curl host/openapi.json | jq '.paths | keys'`.

## Executive truth table

| # | Doc claim (quote + path) | Code/Reality (`file:line`) | Verdict |
|---|--------------------------|----------------------------|---------|
| 1 | "Each app exposes a per-app MCP server at `/mcp/app/{slug}`. The MCP server uses **HTTP+SSE transport** (MCP spec 2024-11-05)." (`apps/web/src/assets/protocol.md:93`) | `apps/server/src/routes/mcp.ts:12` imports `WebStandardStreamableHTTPServerTransport`; `spec/protocol.md:238` correctly says `"Streamable HTTP (JSON response mode)"` | **Contradicted** — SPA-rendered protocol is wrong |
| 2 | "Floom exposes three MCP endpoints" (`spec/protocol.md:230–236`) | `apps/server/src/routes/mcp.ts:755–767` mounts three routes: `/mcp/:slug` (admin), `/mcp/search/:search`, `/mcp/app/:slug`. `apps/server/src/index.ts:155` also mounts a top-level `/mcp` admin handler. Three MCP **hosts**, four handler wirings. | **Met** |
| 3 | "Four MCP admin tools (`ingest_app`, `list_apps`, `search_apps`, `get_app`)" (`README.md:34`, mirrored `docs/SELF_HOST.md:178–183`, `docs/ROADMAP.md:14`) | `apps/server/src/routes/mcp.ts` registers four admin tools on `/mcp`; a separate full MCP server on `/mcp/search` exposes gallery-wide `search_apps` as its own agent-addressable surface (`spec/protocol.md:235`). README + ROADMAP count tools, not surfaces. | **Drift** — count correct, but `/mcp/search` as an advertised surface is only in `spec/protocol.md` |
| 4 | "POST /api/pick { prompt, limit }   -> ranked app picks for a query" (`apps/web/src/assets/protocol.md:81`) | Server-side `/api/pick`, `/api/parse`, `/api/thread` still exist (`apps/server/src/index.ts:172–174`); no web client code calls them ([`rh-01-unused-and-dead-surface.md:33–34`](../repo-hygiene-audit/rh-01-unused-and-dead-surface.md)); `spec/protocol.md` — the canonical doc — does **not** list them as part of the protocol. | **Drift** — SPA advertises routes the canonical spec has retired |
| 5 | "`/api/hub/ingest` — create/update an app from an OpenAPI spec" (`spec/protocol.md:308`) | `apps/server/src/routes/hub.ts` implements `POST /api/hub/ingest`; `/openapi.json` does **not** list it (`apps/server/src/index.ts:255–437` only covers admin/secrets/memory/connections/stripe). A machine inspecting `/openapi.json` cannot discover the ingest endpoint. | **Drift** — `/openapi.json` under-lists the public API |
| 6 | "Returned at /openapi.json so users hitting http://host/openapi.json get something useful instead of the SPA index.html" (`apps/server/src/index.ts:244`) | `apps/web/vite.config.ts` catch-all rewrites `/openapi.json` to the server (historical bug called out in `docs/SELF_HOST.md:885`: "fixed SPA wildcard swallowing /openapi.json"). Endpoint serves hand-written JSON at `:246–437`. | **Met** |
| 7 | "Tools are generated from the OpenAPI spec: each operation becomes one MCP tool" (`apps/web/src/assets/protocol.md:93`) | Correct in principle: `apps/server/src/routes/mcp.ts` derives per-app tools from manifest actions (which are in turn derived from OpenAPI at ingest time). `spec/protocol.md:247–258` describes the full derivation. | **Met** |
| 8 | "HTTP API: Floom proxies requests to the underlying service, injecting secrets at runtime and enforcing rate limits / access control" (`apps/web/src/assets/protocol.md:40`) | Matches `apps/server/src/services/proxied-runner.ts` and `apps/server/src/lib/rate-limit.ts`. True for `type: proxied`; for `type: hosted` apps, Floom runs the image and the "HTTP API" is `/api/:slug/run` → container, not a proxy (`spec/protocol.md:337`). The SPA doc elides this nuance. | **Partial** |
| 9 | "`POST /api/publish`" (`apps/web/src/pages/InstallPage.tsx:62–69`) | No `/api/publish` route in the codebase. Real ingest: `/api/hub/ingest` (`apps/server/src/routes/hub.ts`, `spec/protocol.md:308`). | **Missing** |
| 10 | `/openapi.json` description (`apps/server/src/index.ts:253`) says `"see docs/SELF_HOST.md#rate-limits"` | Anchor exists (`docs/SELF_HOST.md:221` — `## Rate limits (self-host)`). **But** the numbers in that section (`docs/SELF_HOST.md:232–236`: 20/100/200 per hour) are stale — real defaults are 60/300/500 per hour (`apps/server/src/lib/rate-limit.ts:27–40`). A machine reading `/openapi.json`, following the link, and parsing the numbers will get the wrong answer. | **Drift** — pointer correct, target stale |
| 11 | "stdio transport — An alternative stdio MCP surface at `packages/floom-mcp-stdio/`" (`spec/protocol.md:259–261`) | Package exists at `packages/floom-mcp-stdio/`; `docs/CLAUDE_DESKTOP_SETUP.md` is referenced from `spec/protocol.md:261` but not from `docs/SELF_HOST.md` MCP sections. Discoverable via `docs/README.md:20`. | **Met** |
| 12 | Manifest schema formally documented in `spec/protocol.md:62–130` (fields, types) | Zod schema lives in `apps/server/src/services/manifest.ts` (`spec/protocol.md:350` cites it). `apps/web/src/assets/protocol.md:11–33` shows a **different** manifest-by-example with fields (`type: proxied|hosted`, `openapi_spec_url`, `base_url`, `auth`) that are a subset of the real manifest. Docs are not outright wrong but are lossy. | **Drift** — two manifest views, one formal, one informal |

---

## Concrete findings

### F1 — `/openapi.json` is the most-honest doc and nothing points at it

[`apps/server/src/index.ts:246`](../../apps/server/src/index.ts) serves a hand-written OpenAPI 3 document listing every meaningful admin surface: `/api/health`, `/api/hub`, `/api/memory/*`, `/api/secrets`, `/api/connections/*`, `/api/stripe/*`, `/api/workspaces/*`, `/api/session/me`. This is updated in-lockstep with code changes (the Stripe routes were added to the JSON at the same PR that mounted the router, as evidenced by the matching feature-parity between `apps/server/src/index.ts:354–430` and `apps/server/src/routes/stripe.ts`).

**But**:

- `README.md` does not mention `/openapi.json` anywhere.
- `docs/README.md` does not mention it.
- `docs/SELF_HOST.md` does not mention it (grep of the file for `openapi.json` returns only the five example `apps.yaml` `openapi_spec_url` lines — which point at **third-party** specs like `resend.yaml`, not Floom's own).
- `spec/protocol.md` does not mention it.
- `apps/web/src/assets/protocol.md:76–89` lists every API route **except** the one that describes every API route.

A reader who wants machine-readable truth about what Floom exposes has to read `apps/server/src/index.ts` prose to find out the prose doc they should have been reading was there the whole time.

### F2 — `/openapi.json` itself under-lists the public API

Compare what `/openapi.json` documents (`apps/server/src/index.ts:255–437`) vs what the server actually mounts (`apps/server/src/index.ts:155–222`):

| Surface | In `/openapi.json`? | Mounted? |
|---------|--------------------|----------| 
| `/api/health` | ✅ | ✅ |
| `/api/metrics` (Prometheus) | ❌ | ✅ (`apps/server/src/index.ts:155–157`) |
| `/api/hub` (list) | ✅ | ✅ |
| `/api/hub/:slug` | ❌ | ✅ (`apps/server/src/routes/hub.ts`) |
| `/api/hub/detect` | ❌ | ✅ |
| `/api/hub/ingest` | ❌ | ✅ |
| `/api/hub/:slug/runs` | ❌ | ✅ |
| `/api/hub/:slug/renderer` | ❌ | ✅ |
| `/api/:slug/run` | ❌ | ✅ (`apps/server/src/routes/run.ts`) |
| `/api/:slug/jobs` | ❌ | ✅ (`apps/server/src/routes/jobs.ts`) |
| `/api/memory/*` | ✅ | ✅ |
| `/api/secrets` | ✅ | ✅ |
| `/api/connections/*` | ✅ | ✅ |
| `/api/stripe/*` | ✅ (six paths) | ✅ |
| `/api/workspaces/*` | ✅ | ✅ |
| `/api/session/me` | ✅ | ✅ |
| `/api/runs/:id/public` | ❌ | ✅ |
| `/hook/:webhook_url_path` (inbound trigger) | ❌ | ✅ (`apps/server/src/routes/webhook.ts`) |
| `/mcp`, `/mcp/search`, `/mcp/app/:slug` | ❌ | ✅ |
| `/spec`, `/spec/*` (308 redirect) | ❌ | ✅ (`apps/server/src/index.ts:842–852`) |

`/openapi.json` covers **admin and plumbing** but not the two things a self-hoster most wants to call programmatically: **ingest** (`/api/hub/ingest`) and **run** (`/api/:slug/run`). It also omits **MCP entirely**, which is fine in the OpenAPI-document sense but leaves a reader dependent on `spec/protocol.md` for the agent-native surface. That's one more reason the canonical prose spec has to be kept correct.

### F3 — `apps/web/src/assets/protocol.md` advertises three HTTP routes the canonical spec has dropped

`apps/web/src/assets/protocol.md:81–87` lists:

- `POST /api/pick  { prompt, limit }   -> ranked app picks for a query`
- `POST /api/parse { prompt, app_slug, action } -> structured inputs from prose`
- `POST /api/thread                    -> create thread`
- `POST /api/thread/:id/turn           -> save turn`

[`apps/server/src/index.ts:172–174`](../../apps/server/src/index.ts) still mounts them. `spec/protocol.md` does **not** mention any of them. [`rh-01-unused-and-dead-surface.md:33–34`](../repo-hygiene-audit/rh-01-unused-and-dead-surface.md) notes that the web client no longer calls them (`pickApps`, `parsePrompt`, `createThread`, `saveTurn` in `apps/web/src/api/client.ts:94, 101, 424, 428` are dead). An agent author reading the `/protocol` page will try to wire these routes; it will work; there will be no documentation of what they return on the canonical spec page; and a future refactor may drop them silently.

Load-bearing note: none of these routes are called out in `docs/PRODUCT.md` load-bearing list. They are defensible to delete (see [`rh-01-unused-and-dead-surface.md`](../repo-hygiene-audit/rh-01-unused-and-dead-surface.md)) but this is a product decision, not a doc-audit one.

### F4 — MCP transport drift on the SPA

- `apps/web/src/assets/protocol.md:93`: "HTTP+SSE transport (MCP spec 2024-11-05)"
- `spec/protocol.md:238`: "Streamable HTTP (JSON response mode) … Both JSON-RPC request/response and SSE notifications ride over the same HTTP endpoint"
- `apps/server/src/routes/mcp.ts:12`: `import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';`

The MCP 2024-11-05 spec defines *both* "HTTP+SSE" (two-endpoint legacy) and "Streamable HTTP" (single-endpoint unified). Floom ships Streamable HTTP. The web-rendered protocol page claims HTTP+SSE. An agent author wiring up the two-endpoint legacy transport will fail to connect and blame Floom.

### F5 — Manifest story is told three times, three different shapes

| Source | Shape | Fields shown |
|--------|-------|--------------| 
| `spec/protocol.md:62–130` | Formal prose + example | `slug`, `name`, `version`, `description`, `category`, `license`, `app_type`, `runtime`, `image`, `build`, `run`, `actions[]`, `secrets_needed`, `memory_keys`, `visibility`, `is_async`, `timeout_ms`, `featured`, `renderer` |
| `apps/web/src/assets/protocol.md:11–33` | Informal YAML | `name`, `type: proxied\|hosted`, `openapi_spec_url` \| `openapi_spec`, `base_url`, `auth`, `secrets`, `runtime`, `build`, `run` |
| `docs/SELF_HOST.md:9–30, 70–95` | Operator YAML (`apps.yaml` shape) | `slug`, `type: hosted\|proxied`, `openapi_spec_url`, `base_url`, `auth`, `secrets`, `display_name`, `description`, plus examples |
| `apps/server/src/services/manifest.ts` | Zod schema — source of truth | Full type, enforced at ingest |

Not a contradiction — each is a correct lossy view of the Zod schema — but a reader comparing the three has to intuit that `spec/protocol.md` is canonical. `docs/PRODUCT.md:16` explicitly calls "manifest shape" a load-bearing surface. Pinning the spec to the Zod schema (mechanically — code-gen a table from the schema into `spec/protocol.md`) would prevent future drift.

### F6 — `/mcp/search` is in one doc and one code file and nowhere else

- `apps/server/src/routes/mcp.ts` (search endpoint registration, confirmed by the earlier ROADMAP + da-01 F5 evidence).
- `spec/protocol.md:234–235` lists it as a first-class MCP surface.

Nothing else references it:

- `README.md:34`: "Four MCP admin tools" — no mention.
- `docs/SELF_HOST.md`: MCP sections (`:129–183, :178–183`) list `ingest_app`, `list_apps`, `search_apps`, `get_app` as the admin tool set; **separate** `/mcp/search` surface is not advertised.
- `apps/web/src/assets/protocol.md:95–98`: only shows `/mcp/app/{slug}`.
- `/openapi.json` does not include any MCP route.

`/mcp/search` is a load-bearing agent surface by design (gallery-wide natural-language app discovery). The product has shipped it and then forgotten to tell anyone. Fix in place — do not delete.

### F7 — `/openapi.json` description string has become a mini-README

`apps/server/src/index.ts:253` packs a 600-character prose description into the `info.description` field listing all optional routes, deploy-mode disclaimers, and a `docs/SELF_HOST.md#rate-limits` link. That's a reasonable place for it — it's the only user-facing doc the machine-readable self-describe ever shows. **But**:

- It does not point at `spec/protocol.md`.
- It does not point at `/mcp` / `/mcp/search` / `/mcp/app/:slug` for the agent-native surface.
- It points at a **stale** rate-limit section (`docs/SELF_HOST.md#rate-limits` — numbers are 3× off per da-01 F2).

An agent that scrapes `/openapi.json` and decides what else to poke at based on the `description` field is pointed at `docs/SELF_HOST.md#rate-limits` instead of `spec/protocol.md`. That's a pointer choice.

### F8 — Adapter doc exists and is reachable, but no contract tests

[`spec/adapters.md`](../../spec/adapters.md) exists and is linked from `spec/protocol.md:333` and `docs/README.md:6`. Not audited in depth (not in scope for this pass). The extensibility framing — five concerns, reference impl, swap-at-compile-time — is consistent across `spec/protocol.md:335–342` and `docs/SELF_HOST.md` adapter sections.

### F9 — "HTTP API" claim in the SPA doc collapses two modes

`apps/web/src/assets/protocol.md:40`: "HTTP API: Floom proxies requests to the underlying service, injecting secrets at runtime and enforcing rate limits / access control."

Accurate for `type: proxied`. For `type: hosted`, Floom does not proxy — it runs the Docker image and forwards `stdin/argv/env` per [`spec/protocol.md:337`](../../spec/protocol.md) `RuntimeAdapter` row. A reader who only ever sees the SPA protocol doc is missing the hosted execution model entirely. `docs/PRODUCT.md:25` places the hosted path as primary.

### F10 — Ingest endpoints fragmented across docs

Where to look to learn about ingesting an app:

- `README.md:111` shows `openapi_spec_url: https://docs.stripe.com/api/openapi.json` in a docker-compose fragment.
- `docs/SELF_HOST.md:9–30` shows operator-side YAML ingest via `apps.yaml`.
- `spec/protocol.md:307–308` documents `POST /api/hub/detect` and `POST /api/hub/ingest` as HTTP surfaces.
- `apps/web/src/pages/InstallPage.tsx:62–69` tells readers to `POST /api/publish` (fictional — da-02 F1).
- `/openapi.json` does not list either of the real ingest routes.
- `docs/connections.md` and `docs/monetization.md` both exist but do not link to `spec/protocol.md`'s ingest section.

Five partial answers, no authoritative one. `spec/protocol.md` is closest to authoritative but is linked from README as "Protocol" (framed as a reference, not an on-ramp).

### F11 — `/spec` redirect wiring is consistent; a rare win

- `apps/web/src/main.tsx:168–171` explains `/spec` is server-side redirected.
- `apps/server/src/index.ts:842–852` implements a 308 redirect from `/spec` and `/spec/*` to `/protocol`.
- The SPA doc reader lands on the same page as someone who typed `/spec`.

This is actually the best-aligned surface in the whole pack. Worth replicating the pattern (single-source + mechanical redirect) for the protocol spec itself — see Open PM Q1.

---

## Risk register

| ID | Sev | Risk | Evidence |
|----|-----|------|----------|
| da3-R1 | **P0** | SPA protocol page at `/protocol` tells agent authors the MCP transport is HTTP+SSE. A reader following that will wire the legacy two-endpoint transport and fail. | `apps/web/src/assets/protocol.md:93`; `apps/server/src/routes/mcp.ts:12` |
| da3-R2 | **P0** | `/openapi.json` is the cleanest, most-current self-describe doc the project has and it is **linked nowhere**. Machine discovery story relies on the reader guessing the path. | grep of docs for `openapi.json` returns no user-facing discovery mentions |
| da3-R3 | **P1** | Dead protocol verbs (`/api/pick`, `/api/parse`, `/api/thread`) still in the SPA spec but not in canonical spec. Agent authors wiring them work today; silent removal tomorrow is a breakage. | `apps/web/src/assets/protocol.md:81–87`; `spec/protocol.md` (absent); `rh-01-unused-and-dead-surface.md:33` |
| da3-R4 | **P1** | `/mcp/search` surface has one canonical reference (`spec/protocol.md:234`) and is omitted from README, ROADMAP, SELF_HOST, SPA. The #2 differentiator (natural-language app discovery for agents) is effectively undocumented for marketing-trail readers. | `README.md:34`; `docs/SELF_HOST.md:178–183`; `docs/ROADMAP.md:14`; `apps/web/src/assets/protocol.md:95–98` |
| da3-R5 | **P1** | `/openapi.json`'s `info.description` points agent consumers at `docs/SELF_HOST.md#rate-limits`, which carries stale numbers (see da-01 F2). The one doc we guaranteed machines would read lies to them about rate limits. | `apps/server/src/index.ts:253`; `docs/SELF_HOST.md:232–236`; `apps/server/src/lib/rate-limit.ts:27–40` |
| da3-R6 | **P2** | Three manifest views (prose in `spec/protocol.md`, informal in `apps/web/src/assets/protocol.md`, operator YAML in `docs/SELF_HOST.md`), four schemas if you count Zod. Future manifest schema changes will need four edits. | `spec/protocol.md:62–130`; `apps/web/src/assets/protocol.md:11–33`; `docs/SELF_HOST.md:9–30`; `apps/server/src/services/manifest.ts` |
| da3-R7 | **P2** | `/openapi.json` omits `/api/hub/ingest`, `/api/:slug/run`, `/api/:slug/jobs`. Machine consumers cannot discover the two ingest modes or the run contract. | `apps/server/src/index.ts:255–437` (diff vs `:155–222`) |

---

## Open PM questions

1. **One protocol doc, one canonical source.** Pick one of `spec/protocol.md` or `apps/web/src/assets/protocol.md`. Mechanically route the other. Candidate mechanic: Vite alias + `import protocolMd from '@spec/protocol.md?raw';` in `apps/web/src/pages/ProtocolPage.tsx:9` — or a docs build step that copies `spec/protocol.md` into `apps/web/src/assets/protocol.md` at build time. `spec/protocol.md` is on `docs/PRODUCT.md`'s load-bearing list; the SPA asset is not.
2. **Should `/openapi.json` list `/api/hub/*`, `/api/:slug/run`, `/api/:slug/jobs`?** Adding them pulls `/openapi.json` into alignment with what a self-hoster most wants to automate. Alternatively, generate `/openapi.json` from route decorators (Hono OpenAPI plugin) instead of hand-writing it, so drift stops being a manual problem.
3. **Is `/mcp/search` a product pillar or an internal detail?** If the first: call it out in `README.md`, `docs/SELF_HOST.md`, and the home page hero. If the second: remove the canonical-spec advertisement (`spec/protocol.md:234–236`) and keep it as an undocumented route. Current state (one spec mentions it, four do not) erodes both readings.
4. **Retire or document `/api/pick`, `/api/parse`, `/api/thread`.** They are advertised on the `/protocol` page but dead in the web client. Either unmount them (per `rh-01-unused-and-dead-surface.md:33`), or re-enable the web-client callers, or at minimum back-port them into `spec/protocol.md` so agent authors who rely on them have spec coverage.
5. **`/openapi.json` discovery.** Link it from `README.md`, `docs/SELF_HOST.md` ("What to call programmatically"), and `spec/protocol.md` ("see also"). One-line fix, high trust payoff for the "is this thing observable?" class of reader.
6. **Manifest schema: single source of truth.** Choose one of (a) generate `spec/protocol.md:62–130` from `apps/server/src/services/manifest.ts` Zod schema; (b) enforce a docs test that fails CI when manifest fields change without a matching `spec/protocol.md` edit; or (c) accept drift and document the Zod schema as truth in `spec/protocol.md:350`. Status-quo is (c) by default but doesn't declare itself.

---

## Source index

| Area | Paths |
|------|-------|
| Canonical spec | `spec/protocol.md:1–360`, `spec/adapters.md` |
| SPA-rendered spec | `apps/web/src/assets/protocol.md:1–102`, `apps/web/src/pages/ProtocolPage.tsx:9, 708` |
| JSON self-describe | `apps/server/src/index.ts:243–437` |
| MCP wiring | `apps/server/src/routes/mcp.ts:1–800`, `apps/server/src/index.ts:155` |
| Ingest reality | `apps/server/src/routes/hub.ts`, `spec/protocol.md:307–308` |
| Manifest schema | `apps/server/src/services/manifest.ts`, `spec/protocol.md:62–130`, `apps/web/src/assets/protocol.md:11–33`, `docs/SELF_HOST.md:9–30` |
| Dead-but-advertised protocol verbs | `apps/web/src/assets/protocol.md:81–87`, `apps/server/src/index.ts:172–174`, `rh-01-unused-and-dead-surface.md:33` |
| `/spec` → `/protocol` redirect (good alignment) | `apps/web/src/main.tsx:168–171`, `apps/server/src/index.ts:842–852` |

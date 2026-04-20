# pd-18: MCP as agent-native product

**Audit type:** Deep product truth — MCP surfaces vs “agent-native” promise and vs gateway-style competitors  
**Sources of truth:** `docs/PRODUCT.md`, `docs/ROADMAP.md`, `apps/server/src/routes/mcp.ts`, `docs/SELF_HOST.md`, `docs/CLAUDE_DESKTOP_SETUP.md`  
**Cross-reference:** `docs/product-audit/deep/pd-01-icp-positioning-truth.md` (three-surface narrative), `docs/product-audit/deep/INDEX.md` (pd-05 parity)  
**Functionality audit:** `docs/functionality-audit/by-area/fn-12-mcp.md` — **not present** in repo at audit time; gaps called out here stand in for that track until filed.

**Snapshot note:** Behavior reflects `mcp.ts` and docs as of audit date; transport and client ecosystems (Claude Desktop, Cursor, `mcp-remote`) evolve independently of Floom.

---

## 1. Capability story (agent-native Floom MCP)

Floom’s product contract (`PRODUCT.md`) states that **all deployment paths** converge on the **same three surfaces**: web form (`/p/:slug`), **MCP** (`/mcp/app/:slug`), and HTTP (`/api/:slug/run`). MCP is therefore not an integration afterthought; it is a **first-class execution and discovery channel** for the same hosted or proxied workloads as the UI.

The implementation splits MCP into **three HTTP mounts** inside `mcpRouter`, with registration order chosen so `/mcp` is not swallowed by a catch-all slug route:

1. **`/mcp` — admin / gallery MCP** (`createAdminMcpServer`, version `0.4.0`)  
   Tools: **`ingest_app`**, **`list_apps`**, **`search_apps`**, **`get_app`**.  
   **Intent:** An agent (or human driving an MCP client) can **discover** the hub, **inspect** full manifests, and **create or update** apps from OpenAPI **without** opening Studio — this is what `PRODUCT.md` names as load-bearing: *“Agent-native ingest is a core promise.”*

2. **`/mcp/search` — search-only MCP** (`createSearchMcpServer`, version `0.3.0`)  
   Tool: **`search_apps`** only (lighter server for clients that only need discovery).  
   **Intent:** Documented in `CLAUDE_DESKTOP_SETUP.md` as a dedicated Claude Desktop entrypoint for gallery search.

3. **`/mcp/app/:slug` — per-app MCP** (`createPerAppMcpServer`, version `0.3.0`)  
   Tools: **one MCP tool per manifest action**; if the action name is `run`, the tool name is derived from the slug (sanitized) for ergonomics in clients that expect a single primary tool.  
   **Intent:** Same **inputs → run → outputs** contract as the web form and HTTP run API, exposed as **typed tool calls** with Zod-built `inputSchema` from the manifest.

**Agent-specific behaviors** wired into per-app tools:

- **`_auth` Floom extension:** Optional per-call secrets object merged into the tool arguments, stripped before manifest validation, **never persisted** server-side; advertised in the schema when `secrets_needed` is set. Missing secrets yield a **structured** `missing_secrets` JSON payload so the client can prompt the user — a deliberate **LLM-in-the-loop** pattern vs opaque 401s.
- **Sync vs async:** Non-async apps **block the tool handler** until the run completes (poll loop up to 10 minutes). Async apps return immediately with **`job_id`**, **`poll_url`**, **`cancel_url`** — shifting long work to the **HTTP jobs surface** the agent can poll or wire to webhooks (`PRODUCT.md` async queue pillar aligns here).

**Auth and limits (admin):** `ingest_app` mirrors **`/api/hub/ingest`**: cloud mode requires an authenticated session; OSS uses the synthetic local user. **`checkMcpIngestLimit`** runs **before** the auth gate so 429 vs `auth_required` does not become a timing side-channel. Read tools are **public** by design, matching hub listing semantics.

**Auth and limits (per-app):** Before building the per-app server, **`checkAppVisibility`** enforces `public` / `private` (owner match in cloud) / `auth-required` (`FLOOM_AUTH_TOKEN` bearer) parity with other app routes.

**Positioning sentence:** Floom MCP is **“host my app + give agents the same powers as the browser”** — catalog, ingest, typed invocation, secrets handoff, and async — rather than **“here is a static OpenAPI file ChatGPT can import.”**

---

## 2. Executive truth table

| Promise / claim | Where stated | Observed reality | Status |
|-----------------|--------------|-------------------|--------|
| MCP is one of **three equal surfaces** for every app | `PRODUCT.md` §Core value, §Deployment paths | `ROADMAP.md` lists per-app MCP as shipped; `mcp.ts` implements `/mcp/app/:slug` with tools mirroring manifest actions | **Met** |
| **`mcp.ts`** is load-bearing; admin tools include **`ingest_app`**, **`list_apps`**, etc. | `PRODUCT.md` load-bearing table | Four admin tools on `/mcp`; duplicate **`search_apps`** on `/mcp/search` | **Met** |
| **Agent-native ingest** | `PRODUCT.md` row for `mcp.ts` | `ingest_app` only accepts **`openapi_url`** or **`openapi_spec`** — same advanced path as HTTP ingest, not “paste repo URL and host” | **Partial** (true for OpenAPI-shaped agents; **under**delivers vs repo→hosted ICP #1 until deploy path lands) |
| **Discovery without leaking private apps** | Implied by `list_apps` docstring + SQL filter | `list_apps` filters `visibility` public/null; **`search_apps`** uses embeddings query with same filter; **`get_app` has no visibility check** — slug-known callers may read full manifest including private apps | **Contradicted** / **Missing** (parity gap between list/search and `get_app`) |
| **Per-app MCP respects app visibility** | Same as HTTP/web | `checkAppVisibility` applied on `/mcp/app/:slug` | **Met** |
| **Per-user secrets without server persistence** | `SELF_HOST.md`, `mcp.ts` | `_auth` stripped, merged into run path; `missing_secrets` structured error | **Met** |
| **Async long runs do not block MCP clients indefinitely** | Async jobs narrative | Async: immediate JSON with poll URLs; sync: blocks up to 10 minutes inside tool handler | **Partial** (async path **Met**; sync path **risk** for client timeouts / UX) |
| **OpenAI Actions–style “one chat product, OAuth to APIs”** | Competitor framing (see §6) | Floom: **open protocol (MCP)**, multi-client, **gallery + ingest + run** on operator infrastructure; OAuth **user-consent** for proxied apps explicitly **not** supported — `_auth` / secrets instead (`SELF_HOST.md`) | **Differentiated** (not drop-in replacement; **different** auth and distribution model) |

**Legend:** Same as pd-01 — **Met** / **Partial** / **Missing** / **Contradicted**.

---

## 3. Agent journey (first successful “agent ships an app”) — with failure branches

**Assumed actor:** Power user or “AI engineer” ICP with Claude Desktop + `mcp-remote`, pointed at Floom cloud.

| Step | Happy path | Failure branches |
|------|------------|------------------|
| **A. Wire admin MCP** | User adds `https://floom.dev/mcp` (or self-host URL) per `SELF_HOST.md` / `CLAUDE_DESKTOP_SETUP.md` | **`mcp-remote` missing / wrong Node** → client fails before Floom. **Headers** wrong (`accept` must include stream) → HTTP errors. |
| **B. Discover** | Agent calls `search_apps` or `list_apps`; gets `mcp_url` per hit | **`OPENAI_API_KEY` unset** → keyword fallback (lower quality). **Hub down** → empty or error; no cached offline catalog. |
| **C. Deep inspect** | Agent calls `get_app` for chosen slug before invoking | **Private app slug guessed** → tool may still return manifest (**visibility gap**). **Malformed manifest JSON** → `manifest: null` in serialization paths. |
| **D. Ingest new app** | Signed-in user; agent calls `ingest_app` with `openapi_url` | **Anonymous in cloud** → `auth_required`. **Rate limit** → `rate_limit_exceeded` (10/day). **Bad spec** → `ingest_failed`. **ICP without OpenAPI** → ingest path unusable — must use Studio/repo story elsewhere. |
| **E. Wire per-app MCP** | Client points at `/mcp/app/{slug}`; `tools/list` shows actions | **Unknown slug** → JSON-RPC error envelope, HTTP 200 (by design). **Private / wrong user** → 404 `not_found` style (no leak). **`auth-required` without bearer** → 401. |
| **F. Run tool** | Args match Zod schema; secrets via DB or `_auth` | **Missing secrets** → structured `missing_secrets`. **Validation** → `Invalid inputs`. **App paused** → `App is {status}`. **Sync slow run** → long blocking call; client may timeout. **Async** → agent must follow up on **HTTP** poll URL (second surface to learn). |

---

## 4. Risk register (P0 / P1 / P2)

| ID | Tier | Risk | Evidence | Downstream effect |
|----|------|------|----------|-------------------|
| R1 | **P0** | **Agent-native ingest** is **OpenAPI-shaped**, while `PRODUCT.md` prioritizes **repo→hosted** as the ICP default | `ingest_app` input schema in `mcp.ts`; `PRODUCT.md` deployment order | Agents onboard Floom as “**spec wrapper**,” not “**host my code**”; same positioning tension as pd-01/pd-04 |
| R2 | **P1** | **`get_app` may expose private apps** to anyone who knows the slug | `get_app` handler: DB `SELECT` by slug only, no `checkAppVisibility` (`mcp.ts` ~653–688) vs `list_apps` public filter (~555–558) | **Catalog privacy contract breaks** for creators who expect “private = invisible everywhere” |
| R3 | **P1** | **Duplicate `search_apps`** on `/mcp` and `/mcp/search` with **slightly different payloads** (permalink only on admin copy) | `createAdminMcpServer` vs `createSearchMcpServer` in `mcp.ts` | Client docs drift; agents may depend on fields present in one mount only |
| R4 | **P1** | **Sync runs block the MCP tool** for up to **10 minutes** | `waitForRun` + `MAX_WAIT_MS` in `mcp.ts` | Gateway timeouts, dropped SSE/HTTP connections, “stuck tool” perception vs OpenAI Actions server-side execution expectations |
| R5 | **P2** | **Per-app JSON-RPC 404** vs **admin tool `not_found`** use different shapes | Unknown app on `/mcp/app/:slug` returns JSON-RPC error + 200; admin tools use MCP `isError` content | Agent error-recovery prompts must handle **two idioms** |
| R6 | **P2** | **Claude Desktop requires `mcp-remote`** for HTTP MCP | `SELF_HOST.md`, `CLAUDE_DESKTOP_SETUP.md` | Friction vs competitors bundled inside a single chat product; onboarding support burden |
| R7 | **P2** | **`ingest_app` rate limit** scoped per implementation (`checkMcpIngestLimit`) | Pre-auth 429 in `mcp.ts` | Legitimate power users hit 10/day ceiling during iterative ingest; need clear upgrade path in product comms |

---

## 5. Open PM questions

1. **Visibility contract:** Should **`get_app`** (and any future admin read tools) apply the **same visibility rules** as `/mcp/app/:slug` and hub APIs, or is “slug as capability URL” intentional for share-with-link workflows?
2. **Single search surface:** Should **`/mcp/search`** merge into **`/mcp`** with optional capability flags, or stay split for **least-privilege** Claude configs?
3. **Repo→hosted + MCP:** When **`POST /api/deploy-github`** exists, will **`ingest_app`** gain a **`repo_url`** mode, or will **repo ingest stay HTTP/Studio-only** — and what does that imply for the “agent-native” headline?
4. **Blocking vs streaming:** For **sync** long runs, should MCP move to **job-first** always, **SSE**, or **documented max latency** so clients set expectations?
5. **OAuth vs `_auth`:** Is “**no authorization_code for proxied apps**” a permanent differentiator, or is there a **managed OAuth** story (e.g. Composio UI) that must eventually surface **through MCP** for parity with Actions-style competitors?
6. **Metrics that prove MCP pillar:** Is success measured by **`floom_mcp_tool_calls_total`**, **ingest_app conversions**, or **time from `list_apps` → first successful per-app tool call**?
7. **`fn-12-mcp` functionality audit:** Should a formal **`fn-12-mcp.md`** be added to **`docs/functionality-audit/by-area/`** to lock acceptance tests (auth, visibility, rate limits, async) the way other areas do?

---

## 6. Competitive positioning — Floom MCP vs “OpenAI Actions” style products

**What “OpenAI Actions” style usually means:** A **single vendor chat surface** (e.g. ChatGPT) imports **OpenAPI operations** as **tools**; **OAuth** and **PKCE** flows tie end-user identity to third-party APIs; distribution is **inside the vendor’s GPT directory**; execution and billing are **vendor-controlled**.

**What Floom MCP is:**

| Dimension | OpenAI Actions–style | Floom MCP (as shipped) |
|-----------|----------------------|-------------------------|
| **Protocol** | Vendor-specific Actions + OpenAPI import | **MCP** (Streamable HTTP) — **portable** across Claude, Cursor, custom agents |
| **Discovery** | GPT store / manual URL | **In-protocol** tools: **`list_apps`**, **`search_apps`**, **`get_app`** + **`mcp_url`** in payloads |
| **Creation** | Builder UI + vendor console | **`ingest_app`** tool (session-gated in cloud) — **agent-driven** create/update |
| **Execution host** | Vendor backend calls your API | **Floom runner** executes **your** container or proxied API — **you** choose self-host vs cloud |
| **Secrets / OAuth** | First-party OAuth connectors | **Server-stored secrets** + **`_auth`** per-call injection; doc states **authorization_code not supported** for proxied apps — pushes secrets model toward **MCP client / user** |
| **Surfaces parity** | Chat-first | **Web + MCP + HTTP** same manifest — **differentiator** vs chat-only gateways |

**Plain-language takeaway:** Floom competes as **“MCP-native hosting + catalog + ingest,”** not as **“easiest ChatGPT plugin.”** The win is **cross-client agent compatibility** and **full-stack execution**; the gap vs Actions-style products is **frictionless consumer OAuth inside one chat app** unless Composio (or similar) is productized end-to-end.

---

## Appendix A — Route / tool map (quick reference)

| HTTP path | Server object | Tools | Notes |
|-----------|---------------|-------|--------|
| `ALL /mcp` | `floom-admin` v0.4.0 | `ingest_app`, `list_apps`, `search_apps`, `get_app` | Session + IP on ingest |
| `ALL /mcp/search` | `floom-chat-search` v0.3.0 | `search_apps` | Minimal discovery server |
| `ALL /mcp/app/:slug` | `floom-chat-{slug}` v0.3.0 | One tool per action | Visibility gate; `_auth`; async branch |

---

## Appendix B — `PRODUCT.md` MCP-related excerpts (audit anchor)

- *“Floom hosts it in production in 30 seconds, gives it an auth layer, rate limits, secret injection, a web form, **an MCP server**, and an HTTP endpoint.”*
- *“**All three paths produce the same three surfaces**: web form (`/p/:slug`), MCP server (`/mcp/app/:slug`), HTTP endpoint (`/api/:slug/run`).”*
- Load-bearing row: **`apps/server/src/routes/mcp.ts`** — *“MCP admin tools (`ingest_app`, `list_apps`, etc.). **Agent-native ingest is a core promise.**”*

---

*End of pd-18 — MCP as agent-native product.*

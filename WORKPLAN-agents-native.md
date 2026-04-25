# [investigate] Agents-Native Floom — Architecture + Workplan

Date: 2026-04-26
Branch: `codex/agents-native-investigate`
Scope: Phase 1 investigation + architecture/workplan only (no implementation)

## 1) Current Agent-Facing Surface (Verified)

### Verification evidence run in this branch

- `pnpm install --frozen-lockfile`
- `pnpm --filter @floom/server build`
- `node test/stress/test-skill-md-routes.mjs` (10/10 passed)
- `node test/stress/test-mcp-admin.mjs` (53/53 passed)
- `node test/stress/test-auth-401-hints.mjs` (132/132 passed)
- `node test/stress/test-w31-waitlist-auth-gate.mjs` (5/5 passed)
- Direct probe: `POST /auth/api-key/create` without session in cloud mode returns `401 {"code":"UNAUTHORIZED_SESSION"}`

### Surface map

| Surface | Where it lives | Auth accepted today | Returns | Works for headless agent with no browser session? |
|---|---|---|---|---|
| `GET /skill.md` | `apps/server/src/routes/skill.ts:143` (mounted at `apps/server/src/index.ts:339`) | None by default; not covered by global `/api|/mcp|/p` auth middleware (`index.ts:222-224`) | Markdown skill index, cache-control `public,max-age=300` | Yes |
| `GET /p/:slug/skill.md` | `apps/server/src/routes/skill.ts:172` | Public app only (`status='active'`, `visibility='public'` at `skill.ts:176-180`); plus global bearer required only when `FLOOM_AUTH_TOKEN` is set (`index.ts:224`, `lib/auth.ts:85-115`) | Per-app markdown skill with MCP + HTTP endpoints | Yes for public apps (unless self-host global token is enabled) |
| `GET /apps` | Web route in SPA router `apps/web/src/main.tsx:222` | Browser page route; not machine API | HTML/SPA page | Not the machine-readable discovery surface |
| `GET /api/hub` (directory API) | `apps/server/src/routes/hub.ts:748` | Public read by default; global bearer only if `FLOOM_AUTH_TOKEN` is set (`index.ts:222`) | JSON array of published public apps (`hub.ts:779-803`) | Yes |
| `POST /api/run` | `apps/server/src/routes/run.ts:186` | No mandatory session for public apps; visibility gate applies (`run.ts:210`, `lib/auth.ts:127-178`). User context resolved via Better Auth session/API key (`services/session.ts:114-219`) | `{ run_id, status }` (`run.ts:326`) | Yes for public apps |
| `POST /api/:slug/run` | `apps/server/src/routes/run.ts:572` | Same as above | `{ run_id, status }` (`run.ts:683`) | Yes for public apps |
| App creation API (closest existing) `POST /api/hub/ingest` | `apps/server/src/routes/hub.ts:307` | In cloud mode requires authenticated context (`hub.ts:308-310`, `lib/auth.ts:224-239`) | Creates/updates app from `openapi_url`, returns created flag (`hub.ts:325-341`) | Yes if caller already has session/API key |
| Any `POST /api/.../create-app` route | Search across server routes | Not found | N/A | No dedicated `create-app` endpoint exists |
| Auth handler `/auth/*` | Mounted in `apps/server/src/index.ts:350-434`; Better Auth config in `apps/server/src/lib/better-auth.ts` | Better Auth session cookies + API keys (`apiKey` plugin at `better-auth.ts:369-411`) | Auth/session/API-key operations | Sessionless bootstrap not available today |
| API key UI/API | Frontend calls `/auth/api-key/list|create|delete` in `apps/web/src/api/client.ts:1186-1207` | Requires authenticated session (direct probe unauth `/auth/api-key/create` => 401 `UNAUTHORIZED_SESSION`) | Lists/creates/deletes keys | Existing key usage is headless; first key mint is not headless |
| MCP admin surface `/mcp` | `apps/server/src/routes/mcp.ts:1021` | `ingest_app` requires auth in cloud (`mcp.ts:507-530`); read tools public | Tools: `ingest_app`, `ingest_hint`, `detect_inline`, `list_apps`, `search_apps`, `get_app` (`mcp.ts:403-968`) | Partially |
| MCP per-app `/mcp/app/:slug` | `apps/server/src/routes/mcp.ts:1037` | Visibility gate only (`mcp.ts:1054-1058`) + global token if configured | Dynamic tool per action; executes run | Yes for public apps |

## 2) Auth Reality (Important)

- Cloud-mode account creation is currently gated by waitlist/deploy flag (`index.ts:372-381`). Verified by `test-w31-waitlist-auth-gate.mjs`.
- Better Auth API keys are already wired for `/api/*` context resolution:
  - `enableSessionForAPIKeys: true` (`better-auth.ts:375-393`)
  - `Authorization: Bearer floom_*` or `x-api-key` accepted (`better-auth.ts:393-409`)
- There is no bootstrap flow for a brand-new agent to mint its first key without a user-authenticated step:
  - unauth `POST /auth/api-key/create` returns `401 UNAUTHORIZED_SESSION` (verified).

## 3) Gap Analysis for “Fully Agent-Native”

### GAP A — First-token bootstrap is not headless

- Today, first key mint requires a signed-in human session (`/auth/api-key/create`), so a fresh agent cannot self-bootstrap from only an owner-issued identity without browser/session handoff.

### GAP B — MCP write surface is incomplete for full lifecycle

- Existing MCP admin tools cover discovery + OpenAPI ingest.
- Missing MCP tools for full contract: publish-status transition, token mint/rotate, secret lifecycle parity, app deletion/visibility management parity, run history primitives.

### GAP C — REST parity is incomplete

- Some capabilities exist only in MCP (`ingest_app` supports inline spec, docker image path).
- HTTP create path `/api/hub/ingest` is URL-only (no inline spec create equivalent).

### GAP D — “Publish my own app” is not user-self-serve headlessly

- New ingests default to `publish_status='pending_review'` (`openapi-ingest.ts:2388-2407`).
- Public publish transition is admin-only via `POST /api/admin/apps/:slug/publish-status` and requires `FLOOM_AUTH_TOKEN` (`routes/admin.ts:24-27`, `46-89`).
- For the stated agent contract, this blocks autonomous publish unless policy changes.

### GAP E — Token model lacks agent scopes

- Existing API keys are user-level bearer keys (no app/workspace capability scopes exposed in Floom policy layer).
- Needed: read-only / run-write / publish-only (or fine-grained permissions) per token.

### GAP F — CLI state is fragmented

- A usable bash CLI exists at `cli/floom/` (`bin/floom`, `lib/*`) for init/deploy/status/auth.
- `packages/cli` Node/TS package exists but is mostly placeholder stubs that exit with “not wired” (`packages/cli/src/index.ts:11-34`).
- No single official npm-installable first-class CLI that mirrors full agent-native lifecycle.

### GAP G — Secret management is not agent-tool unified

- REST endpoints exist (`/api/secrets`, `/api/me/apps/:slug/secret-policies`, `/api/me/apps/:slug/creator-secrets/:key`), but no dedicated MCP tools for these.
- No explicit per-agent secret namespace/audit model.

### GAP H — Agent docs are split across multiple surfaces

- `/skill.md` and `/p/:slug/skill.md` exist, but complete lifecycle docs are split between web docs + skill docs + repo docs.
- Missing one canonical “agent contract” document with bootstrap + auth + tool catalog + error taxonomy.

## 4) Proposed Architecture

## 4.1 Agent token type

### Token artifact

- New token class: `floom_agent_<random>`
- Stored hashed at rest (never plaintext), show prefix + last 4 for identity
- Fields:
  - `id`, `workspace_id`, `owner_user_id`, `label`
  - `token_hash`, `token_prefix`, `created_at`, `last_used_at`, `expires_at`, `revoked_at`
  - `scopes_json`

### Scopes (phase-1 pragmatic)

- `read_only`: discover + get app + get skills + list/get runs
- `read_write`: includes run + create/update app drafts + set secrets
- `publish_only`: create/update/publish app + visibility

### Auth resolution order (server)

1. `FLOOM_AUTH_TOKEN` (self-host global admin bearer) — existing behavior unchanged
2. Agent token bearer (`Authorization: Bearer floom_agent_*`)
3. Better Auth API key/session cookie (existing user auth)
4. Anonymous/device fallback (existing OSS/public behavior)

This keeps backward compatibility while adding an explicit machine principal.

## 4.2 MCP tools to add (target set)

Below are concrete MCP tools for `/mcp` (admin/control plane). Per-app execution at `/mcp/app/:slug` remains.

- `discover_apps`
  - Input: `{ query?: string, category?: string, visibility?: "public"|"private"|"all", limit?: number, cursor?: string }`
  - Output: `{ apps: AppSummary[], next_cursor?: string }`
- `get_app_skill`
  - Input: `{ slug: string }`
  - Output: `{ slug: string, skill_markdown: string, skill_url: string }`
- `run_app`
  - Input: `{ slug: string, action?: string, inputs?: object, async?: boolean }`
  - Output: `{ run_id: string, status: string, stream_url?: string }`
- `get_run`
  - Input: `{ run_id: string }`
  - Output: `RunRecord`
- `list_my_runs`
  - Input: `{ limit?: number, cursor?: string, slug?: string, status?: string }`
  - Output: `{ runs: RunSummary[], next_cursor?: string }`
- `create_app_from_repo`
  - Input: `{ repo_url: string, branch?: string, path?: string, name?: string, slug?: string, visibility?: string }`
  - Output: `{ app_id: string, slug: string, detect_report: object, publish_status: string }`
- `create_app_from_spec`
  - Input: `{ openapi_url?: string, openapi_spec?: object|string, name?: string, slug?: string, visibility?: string }`
  - Output: `{ app_id: string, slug: string, publish_status: string }`
- `publish_app`
  - Input: `{ slug: string }`
  - Output: `{ slug: string, publish_status: "published" }`
- `update_app_visibility`
  - Input: `{ slug: string, visibility: "public"|"private"|"auth-required" }`
  - Output: `{ ok: true, slug: string, visibility: string }`
- `set_secret`
  - Input: `{ scope: "user_vault"|"creator_override", slug?: string, key: string, value: string }`
  - Output: `{ ok: true, key: string }`
- `list_my_apps`
  - Input: `{ include_drafts?: boolean, limit?: number, cursor?: string }`
  - Output: `{ apps: AppSummary[], next_cursor?: string }`
- `delete_app`
  - Input: `{ slug: string, hard?: boolean }`
  - Output: `{ ok: true, slug: string }`
- `mint_agent_token` (bootstrap tool; heavily gated)
  - Input: `{ label: string, scope: "read_only"|"read_write"|"publish_only", expires_in_days?: number }`
  - Output: `{ token_once: string, token_id: string, prefix: string, scope: string }`

## 4.3 REST equivalents (every MCP tool)

All endpoints under `/api/agent/*`, auth header: `Authorization: Bearer <floom_agent_...>`.

- `GET /api/agent/apps` → `discover_apps`
- `GET /api/agent/apps/:slug/skill` → `get_app_skill`
- `POST /api/agent/runs` → `run_app`
- `GET /api/agent/runs/:id` → `get_run`
- `GET /api/agent/runs` → `list_my_runs`
- `POST /api/agent/apps/create-from-repo` → `create_app_from_repo`
- `POST /api/agent/apps/create-from-spec` → `create_app_from_spec`
- `POST /api/agent/apps/:slug/publish` → `publish_app`
- `PATCH /api/agent/apps/:slug/visibility` → `update_app_visibility`
- `PUT /api/agent/secrets` → `set_secret`
- `GET /api/agent/my/apps` → `list_my_apps`
- `DELETE /api/agent/apps/:slug` → `delete_app`
- `POST /api/agent/tokens` → `mint_agent_token` (bootstrap policy)

Backward-compatible note: existing `/api/hub/*`, `/api/run*`, `/mcp*` remain; new endpoints give explicit machine contract.

## 4.4 CLI scaffold (`floom`)

Target: one official Node/TS CLI package (`@floom/cli`) with real wiring.

Core commands:

- `floom auth` (supports API key + agent token + `--check`)
- `floom run <slug> --action run --input k=v`
- `floom create --from-repo <url>`
- `floom create --from-spec <url|file>`
- `floom publish <slug>`
- `floom apps [--mine]`
- `floom runs [--slug <slug>]`
- `floom keys list|mint|revoke|rotate`
- `floom secrets set|get|list|delete`
- `floom logs <run_id>`

Implementation note: absorb/replace shell CLI logic from `cli/floom` so there is one canonical client surface.

## 4.5 Bootstrap flow recommendation (pick one)

### Recommended: **Option (b)** `/me/agent-keys` one-time-show token

Why this is best for phase 2:

- Fastest to ship on top of current Better Auth account model
- Keeps user ownership and audit trail tied to account/workspace
- Does not require introducing device-code OAuth flow complexity in phase 2
- Does not require privileged operator CLI access on AX41 for every new agent

Flow:

1. User signs into Floom web (`/me/agent-keys`), creates an agent token with scope + label.
2. Token is shown once, copied into agent secret store (Clawdbot/Codex/Claude/Cursor/etc.).
3. Agent works fully headless thereafter.

Future phase: add device-code (`floom auth device`) as optional bootstrap v2.

## 4.6 Docs structure

- Keep `/skill.md` as top-level discovery landing, but extend with:
  - “Agent auth contract”
  - MCP tool catalog summary
  - REST fallback contract
  - bootstrap instructions
- Keep `/p/:slug/skill.md` for per-app execution contract.
- Add canonical long-form docs:
  - `docs/agents/quickstart.md` (operator + agent setup)
  - `docs/agents/architecture.md` (this deeper design)

## 4.7 Clawdbot wiring plan (read-only investigation, no changes yet)

Observed:

- Runtime config is docker-compose at `/opt/clawdbot/docker-compose.yml`
- Env is loaded from `/opt/clawdbot/.env`
- Operational restart command exists; container name is `clawdbot`

Plan (phase 2F, no rebuild):

1. Add env vars in `/opt/clawdbot/.env`:
   - `FLOOM_API_URL=https://floom.dev`
   - `FLOOM_AGENT_TOKEN=floom_agent_...`
   - `FLOOM_AGENT_SKILL_URL=https://floom.dev/skill.md`
2. Add/update clawdbot tool adapter config to call Floom MCP/REST using this bearer token.
3. Pull refreshed Floom skill doc into clawdbot agent context on boot (and optional periodic refresh).
4. Restart only: `docker restart clawdbot` (no image rebuild / no container recreation).
5. Verify via logs + a WhatsApp prompt that performs: discover app -> run app -> report result.

## 5) Sequenced Implementation Plan (mergeable PRs)

Every phase includes tests and can ship independently.

### Phase 2A — Agent token primitive + docs seed

- Add `agent_tokens` table + hashing + issue/revoke/list endpoints (web-authenticated owner flow).
- Add `/me/agent-keys` page.
- Extend `/skill.md` with “agent bootstrap + auth”.
- Tests:
  - token mint/revoke/list
  - unauthorized mint denied
  - waitlist/signup gate unaffected

### Phase 2B — MCP read/run parity

- Add MCP tools: `discover_apps`, `get_app_skill`, `run_app`, `get_run`, `list_my_runs`, `list_my_apps`.
- Enforce token scopes (`read_only` and above).
- Tests:
  - tool contracts, auth failures, scope enforcement
  - parity with existing run semantics

### Phase 2C — REST equivalents for 2B tools

- Add `/api/agent/*` read/run endpoints matching MCP behavior.
- Keep old endpoints unchanged.
- Tests:
  - request/response parity tests MCP vs REST
  - cursor pagination + filters

### Phase 2D — Write tools + publish + secrets

- Add MCP/REST write tools:
  - `create_app_from_repo`, `create_app_from_spec`, `publish_app`, `update_app_visibility`, `set_secret`, `delete_app`
- Decide publish policy (self-serve vs moderated).
- Tests:
  - scope enforcement for write/publish
  - secret write/read constraints
  - publish-status transitions

### Phase 2E — Official Node/TS CLI

- Wire real commands in `packages/cli` and publish path.
- Optionally deprecate shell CLI with wrapper compatibility.
- Tests:
  - CLI e2e for auth/run/create/publish/secrets
  - non-interactive CI mode

### Phase 2F — Clawdbot + agent docs rollout

- Add `docs/agents/quickstart.md`, update docs nav.
- Wire clawdbot env + skill pull + restart procedure (no rebuild).
- Run canary validation in WhatsApp.
- Tests/runbook:
  - smoke script: discover/run/create/publish in clawdbot context

## 6) Risks + Federico Decisions Needed

1. Publish policy
- Keep moderated publish (`pending_review -> admin`) or allow scoped self-serve publish for agent tokens?

2. Token scope granularity
- Three coarse scopes vs fine-grained permission matrix (`runs:write`, `apps:publish`, `secrets:write`, etc.).

3. Workspace binding model
- Token bound to one workspace only (recommended for safety) vs multi-workspace token.

4. Bootstrap UX
- Ship web one-time token first (recommended) vs device-code first.

5. Rate limiting
- Add per-token limits in addition to current per-IP/per-user/per-app controls.

6. Secrets model
- Reuse existing user vault + creator override only, or add per-agent secret namespaces.

7. CLI strategy
- Consolidate onto Node/TS CLI as canonical, keep shell CLI as compatibility wrapper, or maintain both long-term.

8. Backward compatibility window
- How long existing `/api/hub/ingest`, `/mcp` tool names, and shell CLI behaviors remain supported after agent-native API lands.

## 7) Summary

- Core foundations already exist: skill routes, public run API, MCP admin+per-app, Better Auth API keys, secret vault, ingest pipeline.
- Missing pieces for full agent-native contract are primarily:
  - scoped agent token type + bootstrap
  - complete MCP/REST lifecycle parity
  - publish flow policy and automation
  - canonical CLI + docs unification
- The 2A->2F plan above keeps each PR mergeable and production-safe.

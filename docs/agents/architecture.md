# Agents-Native Floom Architecture (Phase 1 Proposal)

Date: 2026-04-26
Status: Investigation proposal for review (no implementation in this phase)

## Goal

Enable any AI agent (Clawdbot, Codex, Claude Code, Cursor, ChatGPT plugin, etc.) to use Floom fully headlessly:

- Discover apps
- Run apps
- Create apps from repo or spec
- Publish apps
- Mint and rotate its own agent credentials (within owner policy)
- Manage secrets

## Existing Baseline (Verified)

- Skill discovery exists:
  - `GET /skill.md`
  - `GET /p/:slug/skill.md`
- Run APIs exist:
  - `POST /api/run`
  - `POST /api/:slug/run`
- Directory API exists:
  - `GET /api/hub`
- MCP exists:
  - `/mcp` admin toolset
  - `/mcp/app/:slug` dynamic per-app tools
- Better Auth API key plugin exists and resolves bearer keys in API context.
- First key bootstrap is still user-session dependent (`/auth/api-key/create` unauthenticated returns 401).

## Problem Statement

The platform has strong primitives, but no explicit agent-native contract that guarantees end-to-end lifecycle operation via one documented machine interface. The main missing pieces are:

- Scoped machine principal (`agent token`) with explicit capabilities
- Full MCP + REST lifecycle parity
- Publish flow that supports agent operation under clear policy
- Canonical CLI that mirrors the contract
- Unified agent docs and bootstrap path

## Proposed Auth Model

### Agent token artifact

- Prefix: `floom_agent_...`
- Stored hashed at rest
- Token identifier shown as prefix + suffix for audit
- Suggested fields:
  - `id`
  - `workspace_id`
  - `owner_user_id`
  - `label`
  - `token_hash`
  - `token_prefix`
  - `scopes_json`
  - `created_at`
  - `last_used_at`
  - `expires_at`
  - `revoked_at`

### Phase-1 scopes

- `read_only`: discovery + skills + run read/list
- `read_write`: includes running apps, drafts, and secrets writes
- `publish_only`: includes publish and visibility transitions

### Auth resolution order

1. Existing global self-host token (`FLOOM_AUTH_TOKEN`) for ops/admin mode
2. Agent token (`Authorization: Bearer floom_agent_*`)
3. Existing Better Auth API key/session
4. Public/anonymous behavior where endpoint policy allows

This order preserves backward compatibility while adding a clear machine principal.

## MCP Contract (Target Tools)

- `discover_apps`
- `get_app_skill`
- `run_app`
- `get_run`
- `list_my_runs`
- `list_my_apps`
- `create_app_from_repo`
- `create_app_from_spec`
- `publish_app`
- `update_app_visibility`
- `set_secret`
- `delete_app`
- `mint_agent_token` (gated bootstrap path)

Each tool must define stable input/output schemas and explicit error codes (`unauthorized`, `forbidden_scope`, `not_found`, `validation_error`, `rate_limited`).

## REST Contract (Parity Requirement)

Add an explicit machine API namespace:

- `GET /api/agent/apps`
- `GET /api/agent/apps/:slug/skill`
- `POST /api/agent/runs`
- `GET /api/agent/runs`
- `GET /api/agent/runs/:id`
- `GET /api/agent/my/apps`
- `POST /api/agent/apps/create-from-repo`
- `POST /api/agent/apps/create-from-spec`
- `POST /api/agent/apps/:slug/publish`
- `PATCH /api/agent/apps/:slug/visibility`
- `PUT /api/agent/secrets`
- `DELETE /api/agent/apps/:slug`
- `POST /api/agent/tokens` (gated)

Auth header:

- `Authorization: Bearer floom_agent_...`

Every MCP tool must have a REST equivalent so non-MCP agents are first-class.

## Bootstrap Recommendation

Recommend Phase-1 bootstrap: web one-time token issue at `/me/agent-keys`.

Why:

- Builds directly on current ownership model
- Fastest safe rollout
- Clear revocation and audit trail
- No device-code complexity in initial release

Future extension:

- Add `floom auth device` device-code flow for zero-copy operational bootstrap.

## CLI Strategy

Adopt one canonical Node/TS CLI surface (`floom`) that mirrors MCP/REST capabilities:

- `floom auth`
- `floom run <slug>`
- `floom create --from-repo <url>`
- `floom create --from-spec <url|file>`
- `floom publish <slug>`
- `floom apps`
- `floom runs`
- `floom keys list|mint|revoke|rotate`
- `floom secrets set|get|list|delete`
- `floom logs <run_id>`

Current shell CLI behavior can remain as compatibility wrapper during migration.

## Docs Contract

- Keep `/skill.md` as top-level machine entrypoint.
- Keep `/p/:slug/skill.md` as per-app execution contract.
- Add:
  - `docs/agents/quickstart.md` (operator quickstart)
  - `docs/agents/architecture.md` (this design)

`/skill.md` must include:

- Auth contract
- MCP tool inventory
- REST fallback mapping
- Bootstrap instructions
- Error handling expectations

## Clawdbot Integration Plan (No Rebuild)

Integration target: `/opt/clawdbot` runtime config only.

- Add runtime env:
  - `FLOOM_API_URL`
  - `FLOOM_AGENT_TOKEN`
  - `FLOOM_AGENT_SKILL_URL`
- Update bot tool adapter to call Floom MCP/REST with bearer token.
- Load skill metadata on startup and optionally refresh on interval.
- Restart only with `docker restart clawdbot`.
- Do not recreate container/image.

## Delivery Phases (Safe, Mergeable)

1. Phase 2A: Agent token primitive + `/me/agent-keys` + `/skill.md` extension
2. Phase 2B: MCP read/run tool parity
3. Phase 2C: REST parity for read/run
4. Phase 2D: MCP+REST write tools (create/publish/secrets/delete)
5. Phase 2E: Official Node/TS CLI
6. Phase 2F: Clawdbot wiring + docs rollout

Each phase ships with tests and can be released independently.

## Key Decisions Required

1. Publish policy: moderated publish vs scoped self-serve publish
2. Scope model: coarse three-scope vs fine-grained permissions
3. Token tenancy: single-workspace binding vs multi-workspace
4. Bootstrap mode: web one-time first vs device-code first
5. Rate limits: add per-token quotas in addition to existing controls
6. Secrets policy: shared user vault only vs per-agent secret namespace

## Non-Goals (Phase 1)

- No runtime behavior change in this document phase
- No bypass of existing waitlist/sign-up gate
- No changes to live deploy stacks or production bot runtime

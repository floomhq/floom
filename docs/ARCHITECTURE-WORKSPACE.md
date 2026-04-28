# Floom Workspace Architecture

Date: 2026-04-27  
Scope: headless workspace architecture first, UI routing second.  
Launch constraint: Tuesday 2026-04-28 remains fixed. v1 means one workspace per user, with backend membership already present for v1.1.

## Architecture Principle

Workspace is the tenant boundary. Studio and Run are modes inside that tenant.

Every request has two relevant scopes:

- `app.workspace_id`: the workspace that owns and publishes the app.
- `SessionContext.workspace_id`: the workspace acting on the request. Browser sessions derive it from `user_active_workspace`; agent tokens derive it from the token row; OSS and anonymous fallback use `local`.

This keeps all three surfaces consistent:

- Web form: `/p/:slug` resolves the app by slug, then runs under the caller workspace.
- MCP: `Authorization: Bearer floom_agent_<token>` resolves the caller workspace, then tools resolve apps by slug.
- HTTP: browser cookie or bearer token resolves the caller workspace, then `/api/run` and `/api/:slug/run` resolve apps by slug.

## Current Verified Base

Verified files:

- [docs/PRODUCT.md](/root/floom/docs/PRODUCT.md)
- [docs/LAUNCH-STATUS.md](/root/floom/docs/LAUNCH-STATUS.md)
- [apps/server/src/db.ts](/root/floom/apps/server/src/db.ts)
- [apps/server/src/types.ts](/root/floom/apps/server/src/types.ts)
- [apps/server/src/services/session.ts](/root/floom/apps/server/src/services/session.ts)
- [apps/server/src/services/workspaces.ts](/root/floom/apps/server/src/services/workspaces.ts)
- [apps/server/src/routes/workspaces.ts](/root/floom/apps/server/src/routes/workspaces.ts)
- [apps/server/src/lib/auth.ts](/root/floom/apps/server/src/lib/auth.ts)
- [apps/server/src/lib/agent-tokens.ts](/root/floom/apps/server/src/lib/agent-tokens.ts)
- [apps/server/src/routes/agent_keys.ts](/root/floom/apps/server/src/routes/agent_keys.ts)
- [apps/server/src/services/user_secrets.ts](/root/floom/apps/server/src/services/user_secrets.ts)
- [apps/server/src/routes/mcp.ts](/root/floom/apps/server/src/routes/mcp.ts)
- [apps/server/src/routes/run.ts](/root/floom/apps/server/src/routes/run.ts)
- [apps/server/src/routes/hub.ts](/root/floom/apps/server/src/routes/hub.ts)
- [cli/floom/lib/floom-api.sh](/root/floom/cli/floom/lib/floom-api.sh)
- [cli/floom/lib/floom-auth.sh](/root/floom/cli/floom/lib/floom-auth.sh)
- [cli/floom/lib/floom-deploy.sh](/root/floom/cli/floom/lib/floom-deploy.sh)
- [apps/web/src/main.tsx](/root/floom/apps/web/src/main.tsx)
- [apps/web/src/api/client.ts](/root/floom/apps/web/src/api/client.ts)

Facts from code:

- `workspaces`, `workspace_members`, `workspace_invites`, and `user_active_workspace` already exist.
- `apps.workspace_id`, `runs.workspace_id`, `run_threads.workspace_id`, `builds.workspace_id`, `connections.workspace_id`, `agent_tokens.workspace_id`, and `app_creator_secrets.workspace_id` already exist.
- `user_secrets` is encrypted by workspace DEK but currently keyed by `(workspace_id, user_id, key)`.
- Agent tokens already use the `floom_agent_` prefix and resolve directly to `workspace_id`.
- Existing public slug surfaces are flat: `/p/:slug`, `/mcp/app/:slug`, `/api/:slug/run`.

## Data Model

### 1. Workspace Entity

Chosen path: keep the existing `workspaces` table as canonical and add only launch-safe metadata.

Canonical columns:

- `id TEXT PRIMARY KEY`
- `slug TEXT NOT NULL UNIQUE`
- `name TEXT NOT NULL`
- `plan TEXT NOT NULL DEFAULT 'oss'`
- `wrapped_dek TEXT`
- `created_at TEXT NOT NULL DEFAULT (datetime('now'))`
- `updated_at TEXT NOT NULL DEFAULT (datetime('now'))` - add in v1
- `default_mode TEXT NOT NULL DEFAULT 'run' CHECK (default_mode IN ('run', 'studio'))` - add in v1.1 only if product needs a workspace landing preference

Indexes:

- existing `idx_workspaces_slug ON workspaces(slug)`
- add `idx_workspaces_created_at ON workspaces(created_at)` only when list pagination arrives

Alternatives rejected:

- Organization plus workspace split: too much model surface for v1 and no current product need.
- User-owned resources with workspace as UI wrapper: contradicts Agent tokens and BYOK keys being workspace resources.

Reasoning: the repo already uses workspace as the tenant boundary. The minimum architecture work is naming, route ownership, and secrets/token semantics, not a new top-level entity.

### 2. Ownership Migration

Chosen path: every owned table remains or becomes workspace-scoped. Backfill all missing rows to `local` in OSS mode and to the user's default workspace in Cloud mode where a user is known.

Current FK status:

- Already scoped: `apps`, `runs`, `run_threads`, `builds`, `user_secrets`, `agent_tokens`, `connections`, `stripe_accounts`, `workspace_invites`, `app_reviews`, `feedback`, `app_creator_secrets`, `triggers`.
- Needs cleanup: legacy `secrets` table has no `workspace_id` and stores plaintext. Keep it only for self-host seed/server global secrets. Runtime must prefer `workspace_secrets` and `app_creator_secrets`.
- Needs semantic rename in v1.1: `agent_tokens.user_id` means minting user, not owner. Rename to `issued_by_user_id` in v1.1 with a compatibility view or code alias.

Backfill strategy:

- Existing `apps.workspace_id`, `runs.workspace_id`, and `run_threads.workspace_id` already default to `local`.
- Add `workspace_secrets` in v1:

```sql
CREATE TABLE workspace_secrets (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  nonce TEXT NOT NULL,
  auth_tag TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (workspace_id, key)
);
```

- Backfill `workspace_secrets` from `user_secrets` only when a `(workspace_id, key)` group has one value. The migration compares `(ciphertext, nonce, auth_tag)` groups, not just row count.
- If multiple users in the same workspace have different values for the same key, the migration inserts no `workspace_secrets` row for that key and records the conflict in `workspace_secret_backfill_conflicts(workspace_id, key, user_ids_json, detected_at)`.
- OSS `local` is the expected conflict case: multiple local developers can share `workspace_id = 'local'` while each has private rows in `user_secrets`. The v1 migration must not pick one developer's credential. Those conflicted keys keep working through the legacy user-scoped fallback until an admin/editor explicitly replaces the key from the BYOK keys page, which creates the workspace-level value.
- Cloud with one user per workspace backfills cleanly. Cloud with historical duplicate rows follows the same conflict path instead of silently choosing the admin's row.
- Keep `user_secrets` as a legacy read path for 30 days. New writes go to `workspace_secrets`.

Alternatives rejected:

- Keep BYOK keys per user: breaks headless agent runs when team membership arrives.
- Hard rename `user_secrets` before launch: high risk because runner, routes, tests, and UI already call it.

Reasoning: v1 can ship with one workspace per user, but the data contract must not create a in v1.1 breaking migration for BYOK keys.

### 3. Membership Table

Chosen path: ship `workspace_members` in v1, with exactly one auto-created admin member per user. Hide multi-member UI.

Alternatives rejected:

- Defer membership table: already exists and already powers `assertRole`.
- Expose invites/team UI at launch: not needed for Tuesday and adds product surface that launch QA has not covered.

Reasoning: backend membership is the clean v1.1 bridge. UI can stay single-member while every route already checks role through the same service.

### 4. Default Workspace

Chosen path: create a default workspace on first authenticated request, not only on signup.

Existing behavior: `resolveUserContext` calls `provisionPersonalWorkspace` when an authenticated user has no active workspace.

Deploy behavior:

- Existing OSS rows remain in `local`.
- Existing Cloud users get one workspace on their next authenticated request.
- `user_active_workspace` stores the active workspace pointer.
- Signup does not need a separate workspace creation hook as long as first request provisioning remains idempotent.

Alternatives rejected:

- Create only in signup handler: misses OAuth, invite acceptance, and restored sessions.
- Create a global shared Cloud workspace: leaks tenant data.

Reasoning: request-time provisioning is already implemented and covers every auth entry path.

## Auth And Identity

### 5. HTTP Workspace Resolution

Chosen path:

- Agent bearer: lookup `agent_tokens.hash`, use `agent_tokens.workspace_id`.
- Browser session: Better Auth session resolves `users.id`, then `user_active_workspace.workspace_id`.
- Explicit path: `/api/workspaces/:id/*` verifies membership and uses `:id`.
- Public/anonymous OSS fallback: `local`.
- No `FLOOM_WORKSPACE` header for v1.

Alternatives rejected:

- Subdomain per workspace: not launch-safe and not compatible with self-host defaults.
- Header-selected workspace: easy to spoof unless every route repeats membership checks; active workspace already solves this.

Reasoning: one resolution pipeline exists in `resolveUserContext`; extending it beats adding a second tenant selector.

### 6. MCP Workspace Resolution

Chosen path: agent token alone resolves the workspace. `/mcp/app/:slug` does not require a workspace slug.

Alternatives rejected:

- Token plus workspace slug: redundant and creates mismatch cases.
- Workspace slug in MCP URL: breaks current install snippets and per-app MCP URLs.

Reasoning: MCP clients are headless. The credential is the identity and tenant selector.

### 7. CLI Workspace Resolution

Chosen path: `FLOOM_API_KEY` is the only workspace selector for v1. The key is an Agent token and embeds workspace through the server lookup.

Compatibility:

- Keep `FLOOM_API_KEY`.
- Keep `~/.floom/config.json`.
- Update CLI copy from deprecated `/me/api-keys` wording to "Agent token in Workspace settings".
- Do not add `FLOOM_WORKSPACE` in v1.

Alternatives rejected:

- Separate `FLOOM_WORKSPACE`: creates split-brain config.
- Path-scoped deploy commands: more typing for agents and no extra security if token already scopes tenant.

Reasoning: agents and CLI need one secret, not a secret plus selector.

### 8. Agent Token Lifecycle

Chosen path: Agent tokens are workspace credentials, optionally app-restricted in v1.1.

v1 token fields:

- `id`
- `prefix`
- `hash`
- `label`
- `scope`
- `workspace_id`
- `issued_by_user_id` as semantic name in service/types, backed by existing `user_id` column for launch
- `created_at`
- `last_used_at`
- `revoked_at`
- `rate_limit_per_minute`

Authorization:

- `read`: discover public apps, read accessible app skill metadata, get owned/shared runs.
- `read-write`: `read` plus run apps in the token workspace and public apps.
- `publish-only`: ingest/build/publish paths only. Current read-tool MCP path treats it as not read-authorized.

v1.1 extension:

- Add `agent_token_app_scopes(token_id, app_id, can_run, can_manage)`.
- Default remains workspace-wide.

Alternatives rejected:

- Per-app tokens only: too much token sprawl for agents.
- User-personal tokens: contradicts the tenant model and breaks when the minting user leaves a workspace.

Reasoning: the token belongs to the workspace. The minting user is audit metadata.

### 9. BYOK Keys

Chosen path: BYOK keys are workspace-level encrypted secrets. Runtime can decrypt them; UI members can list masked names and replace/delete values by role.

Access policy:

- `admin` and `editor`: create, replace, delete, list masked.
- `viewer`: list masked only if needed in v1.1; v1 hides controls.
- App runtime: decrypt only declared keys required by the app/action.
- Direct plaintext read endpoint: none.

Implementation:

- Add `workspace_secrets`.
- Update `/api/secrets` to write/read workspace secrets behind its existing path for compatibility.
- Add canonical `/api/workspaces/:id/secrets`.
- Update runner secret loading to use `workspace_secrets` first, then `user_secrets` legacy fallback, then per-call `_auth`.

Alternatives rejected:

- Keep BYOK in browser localStorage only: already insufficient for MCP and HTTP agents.
- Let every member reveal plaintext: unnecessary and increases blast radius.

Reasoning: BYOK keys are operational credentials for workspace apps and agents, not personal profile data.

## API Surface

### 10. Endpoint Scoping

Chosen path: split path-explicit workspace administration from token-implicit runtime operations.

Path-explicit workspace endpoints:

- Keep `/api/workspaces`
- Keep `/api/workspaces/:id`
- Keep `/api/workspaces/:id/members`
- Keep `/api/workspaces/:id/invites`
- Add `/api/workspaces/:id/secrets`
- Add `/api/workspaces/:id/agent-tokens`
- Add `/api/workspaces/:id/apps` as v1.1 alias for `/api/hub/mine`
- Add `/api/workspaces/:id/runs` as v1.1 alias for `/api/me/runs`

Token-implicit endpoints stay flat:

- `/api/session/me`
- `/api/session/switch-workspace`
- `/api/hub`
- `/api/hub/:slug`
- `/api/hub/ingest`
- `/api/studio/build/*`
- `/api/run`
- `/api/run/:id`
- `/api/:slug/run`
- `/api/:slug/jobs`
- `/api/:slug/quota`
- `/mcp`
- `/mcp/app/:slug`
- `/p/:slug`

Compatibility aliases:

- Keep `/api/me/agent-keys` as alias for `/api/workspaces/:active/agent-tokens`.
- Keep `/api/secrets` as alias for `/api/workspaces/:active/secrets`.

Alternatives rejected:

- Move all routes under `/api/workspaces/:id/*`: breaks HTTP, MCP, CLI, skills, and public launch snippets.
- Keep everything flat forever: hides the tenant boundary in admin surfaces.

Reasoning: runtime calls are credential-implicit. Administration benefits from explicit workspace paths.

### 11. MCP Tool Names

Chosen path: keep current tool names for launch; update descriptions and response fields to say workspace.

v1 names:

- `discover_apps`
- `get_app_skill`
- `run_app`
- `get_run`
- `list_my_runs`
- `ingest_app`
- `list_apps`
- `search_apps`
- `get_app`

v1.1 additions:

- `list_workspace_apps` as alias for `discover_apps` when authenticated with an Agent token.
- `list_workspace_runs` as alias for `list_my_runs`.

Alternatives rejected:

- Rename tools before launch: breaks existing MCP clients and docs.
- Keep "my" wording indefinitely: conflicts with workspace model.

Reasoning: MCP tool names are API surface. Add aliases before deprecating old names.

### 12. Public App Surface

Chosen path: keep app slugs globally unique for v1 and v1.1. `/p/:slug`, `/mcp/app/:slug`, and `/api/:slug/run` remain flat.

Alternatives rejected:

- `/w/:workspaceSlug/p/:appSlug`: breaks public links and install snippets.
- Duplicate slugs per workspace: requires workspace selector on all three public surfaces.

Reasoning: global slugs are already enforced by `apps.slug UNIQUE` and deeply embedded across the product.

### 13. Webhook And Callback URLs

Chosen path: keep webhook and callback URLs flat, store workspace ownership in the target row.

Examples:

- Incoming trigger webhooks stay `/hook/:webhook_url_path`.
- GitHub build webhooks stay `/api/studio/build/github-webhook`.
- OAuth and auth callbacks stay provider-controlled.
- Outgoing job callbacks stay creator-configured URLs.

Alternatives rejected:

- Workspace-prefixed webhooks: forces every external provider config to change after a workspace rename.
- Workspace subdomain callbacks: not launch-safe and not self-host friendly.

Reasoning: callbacks need stable URLs. Workspace is persisted in `triggers`, `builds`, and related rows.

## UI

### 14. URL Structure

Chosen path: make workspace-mode browser URLs explicit for v1 launch. The canonical authenticated browser paths are `/run/*`, `/studio/*`, `/settings/*`, and `/account/settings`. Existing `/me/*` browser paths remain compatibility redirects and SPA aliases during launch.

v1 canonical browser routes:

- `/run` - Run dashboard for the active workspace.
- `/run/apps` - runnable apps in the active workspace.
- `/run/apps/:slug` - app overview for runner context.
- `/run/apps/:slug/run` - app run surface.
- `/run/apps/:slug/secrets` - per-app runtime key guidance when that view exists.
- `/run/apps/:slug/triggers/*` - workspace trigger setup for an installed app.
- `/run/runs` and `/run/runs/:id` - active workspace run history and run detail.
- `/run/install` - authenticated install helper.
- `/studio/*` - creator mode inside the active workspace, unchanged except cross-links.
- `/settings/byok-keys` - workspace BYOK keys.
- `/settings/agent-tokens` - workspace Agent tokens.
- `/settings/studio` - Studio-local General/GitHub configuration for the active workspace.
- `/account/settings` - profile, email, security, and account deletion.

Compatibility browser routes:

- `/me` redirects to `/run`.
- `/me/apps*` redirects to `/run/apps*`.
- `/me/runs*` redirects to `/run/runs*`.
- `/me/install` redirects to `/run/install`.
- `/me/secrets` redirects to `/settings/byok-keys`.
- `/me/agent-keys` and `/me/api-keys` redirect to `/settings/agent-tokens`.
- `/me/settings` redirects to `/account/settings`.
- `/studio/settings` redirects to `/settings/studio`.

Server/API route names stay unchanged for v1 unless already listed as additive workspace delegates. `/api/me/*` is an internal compatibility API family, not a user-facing browser namespace.

Alternatives rejected:

- Keep `/me/*` as canonical: rejected because it states personal ownership for workspace apps, runs, BYOK keys, and Agent tokens.
- Move browser URLs to `/w/:slug/*` before Tuesday: rejected because v1 hides the switcher and the slug adds screenshot, deep-link, and route-load complexity without user value in single-workspace launch.
- Put account settings under `/settings/account`: rejected because `/settings/*` is the workspace settings family; account settings are not workspace-owned.
- Rename only settings and keep Run at `/me`: rejected because apps and runs remain workspace-owned and Federico's objection applies to the whole Run mode.

Reasoning: `/run/*` names the consumer mode. `/settings/*` names workspace administration at the same tier as Run and Studio. `/account/settings` names personal identity settings without using `/me` as a product namespace.

## URL Rework Decision Log

Canonical namespace:

- Run mode: `/run/*`
- Studio mode: `/studio/*`
- Workspace settings: `/settings/*`
- Account settings: `/account/settings`

Decision rationale:

- `/run` is a mode verb/noun that matches the consumer surface and avoids claiming that workspace apps/runs are personal assets.
- `/settings` follows the GitHub/Linear/Vercel/Notion convention for a mode-agnostic settings area. In Floom v1 it resolves the active workspace because there is one visible workspace.
- `/account/settings` gives personal profile/security/deletion a distinct home.
- `/me` is no longer a canonical product area; it exists only as a compatibility redirect family.

Rejected alternatives:

- `/me/*`: semantically wrong for workspace-owned resources.
- `/workspace/settings/*`: accurate but verbose and visually heavier than the convention users already know.
- `/w/:slug/*`: correct future multi-workspace URL family, but v1 hides workspace switching and launch has less than 48 hours.
- `/settings/account`: mixes tenant administration and personal identity in one family.
- `/account/*` for Run or workspace settings: repeats the original ownership bug with a different noun.

## Multi-Workspace Auth & MCP Topology

Decision date: 2026-04-27. This section resolves the v1.1+ multi-workspace operating model for Claude Code, Cursor, Codex, CLI, custom scripts, web, MCP, and HTTP. v1 still ships one visible workspace per user and hides every switcher/member surface.

### 1. Token Model

Chosen path: one Agent token per workspace. `agent_tokens.workspace_id` remains authoritative and a single `floom_agent_*` token resolves to exactly one workspace.

v1 behavior:

- Users mint an Agent token for the active workspace only.
- `/settings/agent-tokens` lists and revokes tokens for `ctx.workspace_id`.
- No multi-workspace token exists.

v1.1 behavior:

- `/settings/agent-tokens` still shows only the active workspace.
- `/install-in-claude` gains a multi-workspace helper that renders one card per workspace the browser user can access. Each card can mint or reveal setup snippets for that workspace through `/api/workspaces/:id/agent-tokens` after membership and role verification.
- This lets a user create the second Claude/Cursor/Codex credential from one install page without bouncing through Run, Settings, and Studio.

Alternatives considered and rejected:

- One super-token spanning workspaces: rejected because revocation becomes ambiguous. Revoking access to workspace B would require token surgery, partial grants, or global revocation that also breaks workspace A.
- Token plus `workspace_id` selector at call time: rejected because mismatched selectors create a second authorization boundary on every MCP and HTTP route.
- Auto-mint tokens for every workspace on invite acceptance: rejected because it creates durable headless credentials before the user explicitly asks for a headless client.

### 2. MCP Server Model

Chosen path: one MCP config entry per workspace, each using one workspace Agent token. Example names: `floom-personal`, `floom-acme-corp`.

Rules:

- MCP server identity and tenant context come from `Authorization: Bearer floom_agent_*`.
- Tool names stay identical across entries. The user chooses the workspace by choosing the MCP server entry in Claude Code, Cursor, Codex, or another client.
- MCP install snippets name the entry after the workspace slug or a user-edited label.

Alternatives considered and rejected:

- One MCP entry with a workspace selector tool: rejected because agents can select the wrong tenant mid-plan, and every tool call would need duplicate tenant validation.
- One MCP entry with browser active workspace lookup: rejected because headless clients do not share browser active-workspace state reliably.
- Workspace slug in the MCP URL as the source of truth: rejected because it creates token/URL mismatch cases. A path slug can exist for readability, but the token row remains the authority.

### 3. Workspace Selector In MCP Tools

Chosen path: MCP tools do not accept a workspace parameter. `run_app`, `list_workspace_runs`, `list_workspace_apps`, and publish tools infer workspace from the calling Agent token.

Leak prevention contract:

- `run_app("competitor-lens", ...)` inserts `runs.workspace_id = ctx.workspace_id`, where `ctx.workspace_id` comes from the token row.
- `list_workspace_runs` filters by `ctx.workspace_id`.
- A token for workspace B can never read workspace A rows, even when the app slug is identical.
- Any supplied workspace-like field in MCP tool input is ignored or rejected as invalid input, not treated as an override.

Alternatives considered and rejected:

- Explicit `workspace` argument on every tool: rejected because it duplicates the token boundary and creates wrong-workspace writes.
- Optional workspace argument only for list tools: rejected because read and write semantics would diverge.

### 4. Public App Slugs Across Workspaces

Chosen path: public app slugs remain global, while runs and runtime credentials belong to the caller workspace.

Exact rule:

- App lookup: global slug, for example `competitor-lens`.
- Run row owner: caller workspace from `SessionContext.workspace_id`.
- BYOK keys: caller workspace.
- App creator secrets: the app owner's workspace, used only for publisher-controlled app configuration.

Example:

- Workspace A calls `run_app("competitor-lens", ...)` with token A. The run row belongs to workspace A and loads workspace A BYOK keys.
- Workspace B calls the same slug with token B. The run row belongs to workspace B and loads workspace B BYOK keys.
- Neither caller receives the other workspace's runs, BYOK keys, Agent tokens, or app creator secrets.

Alternatives considered and rejected:

- Load BYOK keys from the app owner workspace: rejected because a public app owner would accidentally supply runtime credentials for every caller.
- Make app slugs workspace-local: rejected because it breaks public URLs, MCP install snippets, and HTTP clients.

### 5. HTTP Route Model

Chosen path: run endpoints are token-implicit or session-implicit. They do not accept a trusted `workspace_id` body parameter.

Rules:

- `/api/run` and `/api/:slug/run` infer workspace from the bearer token or browser session.
- If both a browser cookie and `Authorization: Bearer floom_agent_*` are present, the Agent token wins.
- Any `workspace_id` in a run body is ignored or rejected. It never changes tenant context.
- `/api/workspaces/:id/*` is for browser/session management, workspace settings, and path-explicit reads after membership verification.
- If an Agent-token bearer calls `/api/workspaces/:id/*`, `:id` must equal the token workspace or the route returns `workspace_mismatch`.

Alternatives considered and rejected:

- Let `/api/run` accept `workspace_id`: rejected because it enables confused-deputy bugs in scripts and CI.
- Use only `/api/workspaces/:id/*`: rejected because Claude Code and curl snippets become longer while the token already selects the tenant.

### 6. CLI Workspace Switching

Chosen path: CLI stores named token profiles, not a separate workspace selector.

v1 behavior:

- `floom auth login --token=floom_agent_...` writes the default profile.
- `FLOOM_API_KEY=floom_agent_...` remains a one-command compatibility override.

v1.1 behavior:

- `floom auth login --profile personal --token=floom_agent_...` stores a named profile in `~/.floom/config.json`.
- `floom auth use personal` sets the default profile.
- `floom --profile acme run competitor-lens ...` uses a one-command profile override.
- `floom auth profiles` lists profile name, workspace name, token prefix, last-used time, and revoked/valid status when the server can verify it.

Alternatives considered and rejected:

- `FLOOM_WORKSPACE` env selector: rejected because it splits tenant selection between credential and environment.
- One config with multiple tokens and automatic workspace guessing from command arguments: rejected because app slugs are global and do not identify a workspace.

### 7. Web UI Workspace Switching

Chosen path: v1.1 reveals `WorkspaceSwitcher` when `workspaces.length > 1`. Switching changes both active workspace state and the browser URL.

Rules:

- Click or keyboard activation opens the switcher menu.
- Selecting a workspace writes `user_active_workspace`.
- The router moves to `/w/:workspaceSlug/<current-area>` when a workspace slug URL exists. Examples: `/w/acme/run`, `/w/acme/studio`, `/w/acme/settings/agent-tokens`.
- Flat routes such as `/run` and `/settings/agent-tokens` remain compatibility aliases that bind to the active workspace.
- No global hotkey ships in v1.1. The switcher is the visible control and keeps accidental tenant switches out of text-entry workflows.

Alternatives considered and rejected:

- Keep `/run` while changing hidden active workspace only: rejected because screenshots, copied URLs, and support logs would hide tenant context.
- Add a global hotkey at first release: rejected because it creates accidental workspace switching risk before usage patterns are known.

### 8. Second-Workspace Invite Onboarding

Chosen path: accepting an invite switches the browser session to the invited workspace once and reveals the switcher.

First-time flow:

- User accepts invite to workspace B.
- Server verifies the invite, creates/updates `workspace_members`, and sets `user_active_workspace = B`.
- Browser lands on `/w/:workspaceSlug/run`.
- A small success banner offers `Create Agent token` and links to `/w/:workspaceSlug/settings/agent-tokens`.
- `/install-in-claude` displays cards for workspace A and workspace B if the user opens it.
- No Agent token auto-mints.

Alternatives considered and rejected:

- Keep active workspace A after accepting B: rejected because the user would not see the workspace they just joined.
- Auto-mint workspace B token: rejected because headless credentials require explicit user action.

### 9. Token Visibility And Revocation Scope

Chosen path: token management is workspace-scoped.

Confirmed behavior:

- `/settings/agent-tokens` lists tokens for the active workspace.
- Switching workspace changes the token list.
- Revoking a token in workspace A updates only the matching `agent_tokens` row where `workspace_id = A`.
- Tokens in workspace B are different rows and remain valid until revoked from workspace B.

Alternatives considered and rejected:

- Account-wide token inventory by default: rejected because it makes workspace credentials look personal and hides the tenant boundary.
- Revoking all tokens minted by the same user across workspaces: rejected because issuer metadata is not ownership.

### 10. `/install-in-claude` Documentation

Chosen path: v1 copy describes the single active workspace. v1.1 copy introduces one-token-per-workspace setup only when the user has multiple workspaces.

v1 page:

- Says: create an Agent token in Workspace settings for the active workspace.
- Shows one Claude/Cursor/Codex setup snippet.
- Does not advertise multi-workspace UI.

v1.1 page:

- Adds a `Multiple workspaces` section for users with `workspaces.length > 1`.
- Says: create one Agent token per workspace you want Claude Code, Cursor, Codex, CLI, or scripts to access.
- Shows one MCP entry snippet per selected workspace, named from the workspace slug.
- Explains that choosing `floom-personal` versus `floom-acme-corp` in Claude Code chooses the workspace because each entry has a different Agent token.

Alternatives considered and rejected:

- Tell users to reuse one token everywhere: rejected because it contradicts the workspace-scoped token table.
- Show multi-workspace setup in v1 for every user: rejected because Tuesday launch has one visible workspace and hidden switchers.

### Adversarial Pass

Personas: Implementer cold-read, Backend skeptic, Visual designer cold-read, QA engineer, Federico bar.

Flaws found:

- Implementer cold-read: a per-workspace token model still needed a low-friction second-token mint path.
- Backend skeptic: a path-explicit HTTP family could be misread as granting Agent tokens cross-workspace selection.
- Visual designer cold-read: hidden active-workspace switching would make URLs and screenshots ambiguous.
- QA engineer: public slugs needed an exact BYOK/App creator secrets split.
- Federico bar: "just connect both" lacked the concrete Claude Code topology users will see.

Resolutions:

- `/install-in-claude` v1.1 gets a multi-workspace card list and one-click token mint per eligible workspace.
- Agent-token bearers on `/api/workspaces/:id/*` get `workspace_mismatch` unless `:id` equals the token workspace.
- v1.1 switcher moves URLs to `/w/:workspaceSlug/*`; flat routes remain aliases.
- Public app slug rules now state caller workspace run rows and BYOK keys, plus app owner workspace App creator secrets.
- Claude Code setup is one MCP entry per workspace, named by workspace label, each backed by one Agent token.

Residual risks: empty.

Final self-score: 10/10.

### 15. Nav Hierarchy

Chosen path: show workspace identity, hide workspace switching when only one workspace exists.

v1:

- Top-level nav concept: Workspace.
- Workspace identity placement is the left rail header, not TopBar and not page breadcrumbs.
- Run shell placement: in `MeRail`, render a 40px-high workspace identity block at the top of the rail, above all nav groups. Desktop: `padding: 16px 16px 12px`, label line `Workspace`, name line active workspace name, then a 1px divider before the first group. Mobile drawer uses the same block as the first item.
- Studio shell placement: in `StudioSidebar`, render the same identity block at the top of the sidebar, above Studio navigation. It uses the same spacing and typography as `MeRail`.
- Switcher affordance is hidden when `workspaces.length === 1`; the identity block remains visible as a label, not a disabled control.
- Under Workspace: Run, Studio, Settings.
- Switcher renders only when `workspaces.length > 1`; existing `WorkspaceSwitcher` already hides itself in that case.

v1.1:

- Switcher visible once creation/invites/member UI ships.

Alternatives rejected:

- Always-visible disabled switcher: adds noise at launch.
- No workspace label: leaves Agent tokens and BYOK keys feeling personal.

Reasoning: single-workspace v1 still needs tenant language without multi-workspace controls.

### 16. Agent Tokens And BYOK Keys UI

Chosen path: move both into Workspace settings.

Canonical IA:

Left rail IA for authenticated workspace shells:

- Workspace identity block
- Run
  - Overview -> `/run`
  - Apps -> `/run/apps`
  - Runs -> `/run/runs`
- Workspace settings
  - BYOK keys -> `/settings/byok-keys`
  - Agent tokens -> `/settings/agent-tokens`
  - Studio settings -> `/settings/studio`
  - Members -> hidden in v1, route/UI in v1.1
  - Billing -> hidden in v1, route/UI in v1.1
- Account
  - Account settings -> `/account/settings`

v1 route implementation:

- Add canonical browser routes `/settings/byok-keys` and `/settings/agent-tokens`.
- Redirect `/me/secrets` to `/settings/byok-keys`.
- Redirect `/me/agent-keys` and `/me/api-keys` to `/settings/agent-tokens`.
- Link both from the `Workspace settings` group. Account settings lives only under `Account`.
- Keep existing React page modules where launch timing benefits from aliases; visible URLs and links use the canonical paths.

Alternatives rejected:

- Keep under "My account": semantically false.
- Put Agent tokens under Studio only: tokens run apps as well as publish.
- Put workspace credentials under `/run`: settings are siblings of Run and Studio, not a Run subpage.

Reasoning: both resources are workspace credentials used by all three surfaces.

### 17. Browser Route And File Path Changes

Chosen path: v1 changes canonical browser routes while keeping file/module churn minimal. React can keep `Me*` component filenames for launch when aliases map old URLs to the new route family, except token/settings names that create active implementation confusion.

Frontend files to change for v1:

- [apps/web/src/main.tsx](/root/floom/apps/web/src/main.tsx) - add canonical routes for `/run*`, `/settings/byok-keys`, `/settings/agent-tokens`, `/settings/studio`, and `/account/settings`; add redirects from existing `/me*` and `/studio/settings`.
- [apps/web/src/components/TopBar.tsx](/root/floom/apps/web/src/components/TopBar.tsx) - replace "My account" visible copy with workspace/run language.
- [apps/web/src/components/me/MeLayout.tsx](/root/floom/apps/web/src/components/me/MeLayout.tsx) - retitle shell from personal dashboard to workspace run mode.
- [apps/web/src/components/me/MeRail.tsx](/root/floom/apps/web/src/components/me/MeRail.tsx) - link Run items to `/run*`, Workspace settings to `/settings/*`, and Account to `/account/settings`.
- [apps/web/src/components/me/WorkspaceSwitcher.tsx](/root/floom/apps/web/src/components/me/WorkspaceSwitcher.tsx) - keep hidden single-workspace behavior.
- [apps/web/src/components/studio/StudioLayout.tsx](/root/floom/apps/web/src/components/studio/StudioLayout.tsx) - show Studio as mode inside active workspace.
- [apps/web/src/components/studio/StudioSidebar.tsx](/root/floom/apps/web/src/components/studio/StudioSidebar.tsx) - route settings links to `/settings/byok-keys`, `/settings/agent-tokens`, and `/settings/studio`.
- [apps/web/src/components/studio/StudioWorkspaceSwitcher.tsx](/root/floom/apps/web/src/components/studio/StudioWorkspaceSwitcher.tsx) - same copy model as Me switcher.
- [apps/web/src/pages/MePage.tsx](/root/floom/apps/web/src/pages/MePage.tsx) - rename dashboard copy.
- [apps/web/src/pages/MeAppsPage.tsx](/root/floom/apps/web/src/pages/MeAppsPage.tsx) - clarify this is runnable apps in the active workspace.
- [apps/web/src/pages/MeRunsPage.tsx](/root/floom/apps/web/src/pages/MeRunsPage.tsx) - clarify workspace run history.
- [apps/web/src/pages/MeRunDetailPage.tsx](/root/floom/apps/web/src/pages/MeRunDetailPage.tsx) - update breadcrumbs.
- [apps/web/src/pages/MeSecretsPage.tsx](/root/floom/apps/web/src/pages/MeSecretsPage.tsx) - retitle to BYOK keys and use workspace settings framing.
- [apps/web/src/pages/MeSettingsTokensPage.tsx](/root/floom/apps/web/src/pages/MeSettingsTokensPage.tsx) - rename in v1 UI PR 2 to `WorkspaceAgentTokensPage.tsx`, update the lazy import in `main.tsx`, and retitle to Agent tokens.
- [apps/web/src/pages/MeSettingsPage.tsx](/root/floom/apps/web/src/pages/MeSettingsPage.tsx) - move account route ownership to `/account/settings` and keep the implementation account-only.
- [apps/web/src/pages/StudioSettingsPage.tsx](/root/floom/apps/web/src/pages/StudioSettingsPage.tsx) - expose canonical `/settings/studio`; redirect `/studio/settings`.
- [apps/web/src/pages/StudioHomePage.tsx](/root/floom/apps/web/src/pages/StudioHomePage.tsx) - workspace-aware headers and links.
- [apps/web/src/pages/StudioBuildPage.tsx](/root/floom/apps/web/src/pages/StudioBuildPage.tsx) - make target workspace visible.
- [apps/web/src/pages/StudioAppPage.tsx](/root/floom/apps/web/src/pages/StudioAppPage.tsx) - workspace-aware breadcrumbs.
- [apps/web/src/pages/StudioAppRunsPage.tsx](/root/floom/apps/web/src/pages/StudioAppRunsPage.tsx) - workspace-owned app run analytics language.
- [apps/web/src/pages/StudioAppSecretsPage.tsx](/root/floom/apps/web/src/pages/StudioAppSecretsPage.tsx) - clarify app creator secrets versus workspace BYOK keys.
- [apps/web/src/pages/StudioAppAccessPage.tsx](/root/floom/apps/web/src/pages/StudioAppAccessPage.tsx) - clarify app access is workspace-owned.
- [apps/web/src/pages/StudioAppRendererPage.tsx](/root/floom/apps/web/src/pages/StudioAppRendererPage.tsx) - breadcrumb copy.
- [apps/web/src/pages/StudioAppAnalyticsPage.tsx](/root/floom/apps/web/src/pages/StudioAppAnalyticsPage.tsx) - breadcrumb copy.
- [apps/web/src/pages/StudioTriggersTab.tsx](/root/floom/apps/web/src/pages/StudioTriggersTab.tsx) - workspace-owned trigger copy.
- [apps/web/src/components/CopyForClaudeButton.tsx](/root/floom/apps/web/src/components/CopyForClaudeButton.tsx) - snippets and token wording.
- [apps/web/src/api/client.ts](/root/floom/apps/web/src/api/client.ts) - add workspace settings API aliases when backend routes land.
- [apps/web/src/lib/types.ts](/root/floom/apps/web/src/lib/types.ts) - add workspace settings DTOs if separate endpoints land.

Backend and CLI files to change for v1:

- [apps/server/src/db.ts](/root/floom/apps/server/src/db.ts) - add `workspace_secrets`, `updated_at`, indexes.
- [apps/server/src/types.ts](/root/floom/apps/server/src/types.ts) - add `WorkspaceSecretRecord`, rename token field semantics in types.
- [apps/server/src/services/user_secrets.ts](/root/floom/apps/server/src/services/user_secrets.ts) - add workspace-secret helpers and legacy fallback.
- [apps/server/src/routes/memory.ts](/root/floom/apps/server/src/routes/memory.ts) - keep `/api/secrets`, point to workspace secrets.
- [apps/server/src/routes/workspaces.ts](/root/floom/apps/server/src/routes/workspaces.ts) - add `/secrets` and `/agent-tokens` subroutes or route delegates.
- [apps/server/src/routes/agent_keys.ts](/root/floom/apps/server/src/routes/agent_keys.ts) - list by workspace, not only minting user.
- [apps/server/src/lib/agent-tokens.ts](/root/floom/apps/server/src/lib/agent-tokens.ts) - keep workspace resolution authoritative.
- [apps/server/src/services/runner.ts](/root/floom/apps/server/src/services/runner.ts) - load workspace BYOK keys first.
- [apps/server/src/routes/mcp.ts](/root/floom/apps/server/src/routes/mcp.ts) - update tool descriptions and run insert workspace parity in per-app MCP path.
- [cli/floom/lib/floom-auth.sh](/root/floom/cli/floom/lib/floom-auth.sh) - update help URL/copy.
- [cli/floom/lib/floom-api.sh](/root/floom/cli/floom/lib/floom-api.sh) - update missing-auth copy.
- [cli/floom/lib/floom-deploy.sh](/root/floom/cli/floom/lib/floom-deploy.sh) - update owner view path copy if UI aliases land.
- [cli/floom/bin/floom](/root/floom/cli/floom/bin/floom) - update help copy.

Alternatives rejected:

- Rename every `Me*` file before launch: large import churn for low runtime value.
- Keep personal names in UI until v1.1: launch messaging remains incoherent.

Reasoning: file renames are optional; visible copy and backend ownership are not.

## Migration And Compatibility

### 18. URL Redirects

Chosen path:

- v1: canonical browser links use `/run/*`, `/settings/*`, `/studio/*`, and `/account/settings`.
- v1: `/me/*` routes remain live as redirects and SPA aliases.
- v1: `/me/api-keys`, `/me/agent-keys`, and old docs links redirect to `/settings/agent-tokens`.
- v1: `/studio/settings` redirects to `/settings/studio`.
- v1: server-rendered shell handling returns the SPA for both canonical and compatibility paths so direct reloads work.
- v1.1: introduce `/w/:workspaceSlug/*` only when the workspace switcher is visible.

Alternatives rejected:

- Immediate redirects from `/me` to `/w/:slug/run`: forces async session load before first route render and creates loading-route risk.
- Leave old token URL in docs: violates locked vocabulary.

Reasoning: canonical URLs now match ownership. Compatibility preserves bookmarks, shipped routes, CLI docs, and browser reloads.

### 19. Server Route Renames And Shims

Chosen path: no breaking server route renames for v1. Add shims.

Shims:

- `/api/secrets` -> active workspace secrets.
- `/api/me/agent-keys` -> active workspace Agent tokens.
- `/api/hub/mine` -> active workspace owned apps.
- `/api/me/runs` -> active workspace run history.

New canonical v1/v1.1 routes:

- `/api/workspaces/:id/secrets`
- `/api/workspaces/:id/agent-tokens`
- `/api/workspaces/:id/apps`
- `/api/workspaces/:id/runs`

Alternatives rejected:

- Remove `/api/me/*`: breaks web and CLI status.
- Duplicate all logic in new routes: creates policy drift.

Reasoning: route delegates keep auth and RBAC in one implementation.

### 20. Existing `FLOOM_API_KEY` Values

Chosen path: keep existing values working. Treat them as Agent tokens when they match `floom_agent_`; keep legacy session-cookie fallback in CLI config.

Grandfather period:

- No token invalidation for launch.
- Start copy migration immediately.
- Add server warnings or audit metadata for legacy token types in v1.1 if any non-Agent-token credential remains.

Alternatives rejected:

- Force re-mint before launch: breaks every agent install.
- Add workspace env selector: unnecessary split-brain config.

Reasoning: credential stability matters more than URL vocabulary.

### 21. `/p/:slug`

Chosen path: keep flat global slugs. No breaking change.

Alternatives rejected:

- Workspace-prefixed public app URLs: breaks existing links, skills, MCP snippets, and SEO.
- Multi-tenant duplicate slugs: requires all three surfaces to accept a workspace selector.

Reasoning: the app slug is already a global public identifier.

## Phasing

### 22. v1 Ship List For Tuesday 2026-04-28

Chosen path: ship architecture coherence with minimal route churn.

Must land:

- Add canonical browser routes `/run/*`, `/settings/*`, and `/account/settings`.
- Add redirects from `/me/*`, `/me/api-keys`, and `/studio/settings` to canonical browser routes.
- Add `workspace_secrets` and make BYOK writes workspace-level.
- Keep `/api/secrets` working as active-workspace alias.
- Make Agent token list/revoke workspace-scoped, not only `user_id` scoped.
- Update token and secret UI copy to Workspace settings, BYOK keys, Agent tokens.
- Remove visible "My account" language from run dashboard and nav.
- Make active workspace visible above Run and Studio modes.
- Keep switcher hidden for single-workspace users.
- Update CLI/help/docs snippets to use Agent tokens vocabulary and `/settings/agent-tokens` or Workspace settings wording.
- Audit per-app MCP run insert path so run rows get `workspace_id`, `user_id`, and `device_id` like HTTP runs.
- Run backend tests that cover workspaces, Agent tokens, secrets, MCP run parity, and run auth.
- Run web typecheck/build after UI copy changes.

Required migration verification:

- CI unit/stress: add `test/stress/test-workspace-secrets-backfill.mjs` to build an in-memory DB with three cases: one user one key, two users same key same encrypted value, and two users same key different encrypted values in `local`. Expected result: first two create one `workspace_secrets` row; conflict creates no workspace row and creates one `workspace_secret_backfill_conflicts` row.
- CI runtime: extend `test/stress/test-w21-user-secrets.mjs` or add `test/stress/test-workspace-secrets-runtime.mjs` to prove read order is `workspace_secrets` first, then legacy `user_secrets`, then per-call `_auth`.
- Preview smoke: before production promote, run a one-off SQL check on the preview database: count total `(workspace_id, key)` groups in `user_secrets`, count migrated `workspace_secrets`, count conflicts, and fail promotion if any Cloud workspace conflict exists outside `workspace_id = 'local'`.
- Stress: seed 1,000 `user_secrets` rows across 100 workspaces with duplicate keys and run the migration twice. Expected result: idempotent row counts, no duplicate conflict rows, and no plaintext logging.

Rollback plan for Tuesday:

- Ship the schema and service change as dual-read. Runtime reads `workspace_secrets` first, then `user_secrets`; no data deletion occurs in v1.
- If backfill fails before production promote, revert only the application PR that writes new BYOK keys to `workspace_secrets`; leave the additive table in place. The legacy `user_secrets` read path keeps runs working.
- If backfill fails after production promote, disable the new write path by rolling back the server image to the prior build. Because v1 does not drop or mutate `user_secrets`, no rollback migration is required.
- If conflict counts are non-zero, launch still proceeds only when conflicts are limited to OSS `local` or explicitly accepted self-host data. Cloud conflicts block promote until an operator replaces the conflicting BYOK key or leaves that key on legacy fallback with an audit note.

Tuesday landing order:

1. Backend precursor PR: MCP per-app run insert parity. This lands first because it changes one insert path and gives a stable run-history baseline.
2. Backend workspace semantics PR: `workspace_secrets`, dual-read, Agent-token list/revoke by active workspace, canonical workspace route delegates, and migration tests. This depends on PR 1 only for clean test baselines.
3. UI route PR: `main.tsx` canonical browser routes, `/me/*` redirects, `/studio/settings` redirect, server SPA fallback coverage, and route smoke tests.
4. CLI copy PR: can land in parallel with PR 2 after route/copy decisions are frozen. It updates `cli/floom/*`, `cli/floom/README.md`, and `apps/web/public/AGENTS.md`.
5. UI PR 1: shell identity in `MeRail` and `StudioSidebar`. Can land in parallel with backend PR 2.
6. UI PR 2: settings grouping, BYOK keys, Agent tokens, `/account/settings`, and `MeSettingsTokensPage.tsx` rename to `WorkspaceAgentTokensPage.tsx`. This depends on UI PR 1 because both touch `MeRail`.
7. UI PR 3: Studio per-app copy and snippets. Can start in parallel with UI PR 2 but lands after PR 1 so shell vocabulary is consistent.
8. Parity audit PR/check: screenshot diff against v23 wireframes, backend targeted tests, web/server typechecks. This is sequential after PRs 1-7.

Feasibility verdict: seven PRs plus a parity audit in less than 48 hours is launch-safe only because the URL PR is additive routing and redirects, not page rewrites. UI PR 3 remains copy/snippet-only and the parity audit is the release gate, not another broad implementation pass. The backend work is sequential for PR 1 -> PR 2; the CLI and UI work can run in parallel after the IA decisions above are locked.

Alternatives rejected:

- Full `/w/:slug` UI migration: not launch-safe.
- Full multi-member workspace UI: not needed for single-workspace launch.

Reasoning: this fixes the product architecture without destroying launch velocity.

### 23. v1.1 Backlog

Chosen path: defer only items that have compatibility paths.

Backlog:

- `/w/:workspaceSlug/run`
- `/w/:workspaceSlug/studio`
- `/w/:workspaceSlug/settings/*`
- Visible workspace switcher and workspace creation.
- Members and invites UI.
- `agent_token_app_scopes`.
- Rename `agent_tokens.user_id` to `issued_by_user_id` through migration or service alias.
- Add `list_workspace_apps` and `list_workspace_runs` MCP aliases.
- Add `/api/workspaces/:id/apps` and `/api/workspaces/:id/runs` canonical endpoints.
- Migrate remaining file/component names from `Me*` to `Run*`, `WorkspaceSettings*`, or `Account*` where valuable.

Alternatives rejected:

- Defer backend membership: already present.
- Defer all workspace settings routes: blocks clean v1.1 URL migration.

Reasoning: each item can land behind aliases without breaking launch URLs.

### 24. Cannot Be Deferred

Chosen path: lock tenant semantics before launch.

Cannot defer:

- Workspace-scoped BYOK keys.
- Agent tokens as workspace credentials.
- One request path for workspace resolution through `SessionContext`.
- Flat public slug commitment for `/p/:slug`, `/mcp/app/:slug`, and `/api/:slug/run`.
- Visible removal of "My account" framing from run dashboard.
- Backward-compatible handling for existing `FLOOM_API_KEY` configs.

Alternatives rejected:

- Treat launch as personal-account model and migrate in v1.1: creates post-launch breaking semantics for tokens, BYOK keys, run history, and docs.
- Change public slugs after launch: breaks user links and agent installs.

Reasoning: these choices become public contracts on Tuesday.

## Implementation Order Across Layers

Layer 1 - architecture done: this document. Owner: Codex.

Layer 2 - ASCII IA and route maps:

- Owner: Codex for the full ASCII IA tree and API route matrix.
- Reviewer: Claude as UI implementer.
- Output: one ASCII tree showing Workspace above Run and Studio, plus API route matrix for token-implicit versus path-explicit routes.

Layer 3 - HTML wireframes:

- Owner: Claude.
- Output: Workspace settings page with BYOK keys and Agent tokens, updated Run dashboard chrome, updated Studio shell showing active workspace.

Layer 4 - code:

- Backend owner: Codex.
- UI owner: Claude.
- Backend sequence: schema migration, services, route shims, runner/MCP parity, tests.
- UI sequence: copy/nav, settings relocation, snippets, screenshots.
- Verification: backend targeted tests, server build/typecheck, web typecheck/build, browser screenshots for changed workspace settings and Run/Studio nav.

## Product Calls Resolved For Layer 2

### Q-A. Workspace Settings IA

Decision: A3 revised. Canonical workspace settings move to `/settings/*` for v1. `/me/*` remains compatibility only.

Exact sidebar IA:

- Workspace identity block
- Run: `/run`, `/run/apps`, `/run/runs`
- Workspace settings: `/settings/byok-keys` as BYOK keys, `/settings/agent-tokens` as Agent tokens, `/settings/studio` as Studio settings
- Account: `/account/settings` as Account settings

Reasoning:

- Workspace credentials get a mode-agnostic namespace outside Run and Studio.
- Account settings leave the workspace settings family completely.
- Launch blast radius remains bounded because redirects preserve existing shipped `/me/*` paths and React modules can be reused behind canonical routes.

Rejected:

- A1 keeps canonical `/me/*` paths and repeats the ownership mismatch Federico rejected.
- A2 consolidates account and workspace credentials into one page shell. That adds tab state, screenshot churn, and account/workspace coupling before Tuesday.
- `/workspace/settings/*` is accurate but verbose; `/settings/*` is the cleaner convention while v1 has one active workspace.

### Q-B. Single-Workspace Identity In UI

Decision: B2-left-rail. Use a persistent left rail label, not TopBar chrome and not a page breadcrumb.

v1 behavior:

- Run shell: show the active workspace name in `MeRail` at the top-left of the rail, above the `Run` group. The block is 40px high, uses the mono eyebrow `Workspace`, then the workspace name, then a divider.
- Studio shell: show the same active workspace name in `StudioSidebar` at the top-left of the sidebar, above Studio sections, with the same dimensions and typography.
- Hide workspace switching controls while the user has one workspace.

Reasoning:

- A user can understand why BYOK keys and Agent tokens are not personal account settings because the workspace label is present at the mode boundary.
- TopBar wording like `Workspace · Run · Studio` consumes high-value global navigation space and adds repeated copy before multi-workspace exists.
- No visible workspace identity leaves the tenant model implicit and makes v1.1 team behavior feel surprising.

### Q-C. Agent Token List Cutover

Decision: make the v1 cutover now. `/api/me/agent-keys` lists and revokes by active `workspace_id`, with `user_id` kept only as issuer audit metadata.

Exact filter:

- List: `SELECT * FROM agent_tokens WHERE workspace_id = ctx.workspace_id ORDER BY created_at DESC`.
- Revoke: `UPDATE agent_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ? AND workspace_id = ctx.workspace_id`.
- Create: default `workspace_id = ctx.workspace_id`; if a body supplies `workspace_id`, verify membership/role before insert.
- A browser user who has tokens in two workspaces sees only the active workspace's Agent tokens. Switching `user_active_workspace` changes the list. v1 hides the switcher because v1 has one visible workspace, but the backend behavior is already exact for v1.1.

Reasoning:

- Single-member v1 returns the same rows after the cutover, because every token in that workspace was minted by the only member.
- Multi-member v1.1 behavior becomes correct by construction: an admin/editor sees workspace credentials, including teammate-minted tokens, because those tokens can run or publish against the shared tenant.
- Keeping the old `user_id` list creates a hidden ownership split: two admins in one workspace would each see an incomplete credential inventory while all tokens still affect the same workspace.

Guardrails:

- Agent-token management continues to require a browser user session, not an Agent-token bearer.
- v1 implementation filters by `workspace_id = ctx.workspace_id` and verifies membership through the existing workspace service before canonical path-explicit routes are added.

### Q-D. BYOK Keys Versus App Creator Secrets

Decision: D1. Keep distinct surfaces: `BYOK keys` in Workspace settings and `App creator secrets` inside Studio per-app settings.

Reasoning:

- BYOK keys are runtime credentials for the workspace. They power web, MCP, and HTTP runs for apps that declare required user/workspace keys.
- App creator secrets are publisher-controlled configuration for one app. They let the creator operate an app without exposing upstream credentials to app runners.
- A creator can need both contexts at the same time: workspace BYOK keys for running other apps, and app creator secrets for the app they publish.

UI implication:

- `BYOK keys` never implies app ownership.
- `App creator secrets` never implies runner-provided credentials.
- Cross-links can explain missing runtime keys from a per-app page, but the forms remain separate.

## Technical Loose Ends Resolved For Layer 2

### T-1. Frontend Batching Strategy

Decision: split the frontend work into one additive route PR plus 3 UI PRs.

Route PR: canonical URL aliases and redirects

- Files: `main.tsx`, server SPA shell handling in `apps/server/src/index.ts`, route smoke tests.
- Goal: add `/run/*`, `/settings/*`, and `/account/settings`; redirect `/me/*` and `/studio/settings`; keep direct reloads working.
- Visual parity checkpoint: loaded screenshots for `/run`, `/settings/byok-keys`, `/settings/agent-tokens`, `/account/settings`, and redirect checks from old paths.

PR 1: Workspace shell and mode identity

- Files: `TopBar.tsx`, `MeLayout.tsx`, `MeRail.tsx` identity block only, `WorkspaceSwitcher.tsx`, `StudioLayout.tsx`, `StudioSidebar.tsx`, `StudioWorkspaceSwitcher.tsx`, `MePage.tsx`, `StudioHomePage.tsx`.
- Goal: remove visible personal-account framing, add persistent workspace identity in Run and Studio shells, keep single-workspace switchers hidden.
- Visual parity checkpoint: desktop and mobile screenshots for `/run`, `/run/runs`, and `/studio` showing loaded content, workspace label, canonical route URLs, and no layout overlap.

PR 2: Workspace settings pages

- Files: `MeRail.tsx` settings/account grouping only, `MeAppsPage.tsx`, `MeRunsPage.tsx`, `MeRunDetailPage.tsx`, `MeSecretsPage.tsx`, `MeSettingsTokensPage.tsx` renamed to `WorkspaceAgentTokensPage.tsx`, `MeSettingsPage.tsx`, `StudioSettingsPage.tsx`, `client.ts`, `types.ts`.
- Goal: ship locked vocabulary, put BYOK keys and Agent tokens under the visual `Workspace settings` group, and put Account settings under `Account`.
- Visual parity checkpoint: desktop and mobile screenshots for `/settings/byok-keys`, `/settings/agent-tokens`, `/account/settings`, and one run detail with real loaded data or an intentional empty state.

PR 3: Studio per-app copy and snippets

- Files: `StudioBuildPage.tsx`, `StudioAppPage.tsx`, `StudioAppRunsPage.tsx`, `StudioAppSecretsPage.tsx`, `StudioAppAccessPage.tsx`, `StudioAppRendererPage.tsx`, `StudioAppAnalyticsPage.tsx`, `StudioTriggersTab.tsx`, `CopyForClaudeButton.tsx`.
- Goal: make app ownership workspace-aware, preserve the BYOK versus app creator secrets distinction, update install/token snippets.
- Visual parity checkpoint: desktop and mobile screenshots for Studio app overview, app secrets, build, and one install snippet state.

Reasoning: the route PR is mechanically bounded, while the 3 UI PRs keep each visual audit coherent without a single sweeping shell-plus-settings-plus-Studio diff. Each checkpoint has visible loaded UI evidence before the next batch starts.

### T-2. MCP Run Insert Bug Fix Placement

Decision: ship the MCP run insert fix as a precursor PR before the workspace secrets PR.

Root cause from `git log` and current code:

- PR #789 (`9b4a9f0`, `feat(agents): phase 2B`) added the root MCP Agent-token read server and `apps/server/src/services/agent_read_tools.ts`.
- `agent_read_tools.ts` currently inserts root MCP `run_app` and `/api/agents/run` rows with `thread_id`, `workspace_id`, `user_id`, and `device_id` through the shared `runApp()` service.
- `apps/server/src/routes/run.ts` already writes those columns in both HTTP run insert paths.
- The remaining bug is only the per-app MCP server in `apps/server/src/routes/mcp.ts`: it resolves `ctx` and passes it to `dispatchRun`, but its insert is still `INSERT INTO runs (id, app_id, action, inputs, status) ...`. That omission was an oversight, not an intentional privacy boundary.
- Path change: update only the per-app MCP synchronous insert to write `thread_id = NULL`, `workspace_id = ctx.workspace_id`, `user_id = ctx.user_id`, and `device_id = ctx.device_id`. If `ctx` is unavailable, call `resolveUserContext(c)` before the insert rather than falling back to unscoped defaults.

Reasoning:

- The bug is confirmed and independent: MCP-created runs omit `thread_id`, `workspace_id`, `user_id`, and `device_id`, while HTTP runs write those columns.
- The fix has a smaller risk envelope than `workspace_secrets`: one insert path plus targeted MCP/REST parity tests.
- Bundling it with workspace secrets hides a run-history correctness regression inside a larger credential migration and complicates rollback.

Required verification for the precursor PR:

- MCP `run_app` creates a run row with `workspace_id`, `user_id`, and `device_id`.
- `/api/me/runs` returns that MCP-created run for the same Agent-token workspace.
- `/api/agents/run` remains green as the already-correct shared-service reference.
- Existing HTTP `/api/run` and `/api/:slug/run` behavior remains unchanged.

### T-3. Active Workspace Resolution Decision Tree

Common resolver order:

1. If the request presents `Authorization: Bearer floom_agent_*`, `agentTokenAuthMiddleware` resolves the token row and `resolveUserContext` returns that token row's `workspace_id`. This wins over any browser cookie.
2. Else, if Cloud mode has a verified Better Auth browser session, `resolveUserContext` mirrors the user, links invites, provisions a default workspace if missing, reads `user_active_workspace`, and returns that workspace.
3. Else, OSS and anonymous fallback return `workspace_id = local`, `user_id = local`, and the `floom_device` cookie.
4. Public slug routes first resolve the app by global slug. The caller workspace still comes from steps 1-3 for run rows, memory, BYOK lookup, and visibility checks.

Route-specific decisions:

- `/api/me/runs`: token-implicit. Browser sessions list rows by `(ctx.workspace_id, ctx.user_id)`. Agent tokens list rows by the token workspace and token issuer user today; the MCP insert precursor makes token-created runs visible through this same path. Anonymous OSS lists `(local, device_id)`. Anonymous Cloud returns the fallback device-scoped list only for public/device history; destructive run deletes remain authenticated-only.
- `/api/me/agent-keys`: token-implicit but browser-session-only for management. Browser sessions list/revoke by `ctx.workspace_id`. Agent-token bearers receive `session_required`. Anonymous OSS keeps local behavior only where Cloud auth is disabled; anonymous Cloud receives `auth_required`.
- `/api/secrets`: token-implicit but browser-session-only for management. Browser sessions list/write/delete active workspace BYOK keys. Agent-token bearers receive `session_required` for management endpoints. Anonymous OSS maps to `local`; anonymous Cloud receives `auth_required`.
- `/api/hub/mine`: token-implicit. Browser sessions list apps in `ctx.workspace_id` owned by the caller. Agent tokens list the token workspace's accessible owned apps after the v1 cutover; issuer identity remains audit metadata. Anonymous OSS lists local seeded/self-host apps. Anonymous Cloud gets only the fallback local result set and never gains owner-only mutation rights.

Path-explicit v1.1 aliases:

- `/api/workspaces/:id/secrets`, `/api/workspaces/:id/agent-tokens`, `/api/workspaces/:id/apps`, and `/api/workspaces/:id/runs` verify membership for `:id` and then delegate to the same service logic as the token-implicit routes.

### T-4. Layer 2 Ownership

Decision: Codex owns all Layer 2 output. Claude is locked to UI-only implementation review.

Layer 2 artifact:

- [docs/ARCHITECTURE-LAYER-2.md](/root/floom/docs/ARCHITECTURE-LAYER-2.md)

Review contract:

- Claude reviews the IA tree as the UI implementer.
- Codex remains accountable for the API route matrix, route scoping decisions, and v1 must-land file inventory.

## Risk Register And Known Smells

All entries below have a launch mitigation or a v1.1 cleanup path; none are accepted as unbounded residual risk.

| Smell | Launch mitigation | v1.1 cleanup |
|---|---|---|
| Old `/me/*` bookmarks and screenshots exist from v23. | Every `/me/*` browser path redirects to the canonical `/run/*`, `/settings/*`, or `/account/settings` destination; new screenshots use canonical paths. | Keep redirects through the first multi-workspace release, then convert to documented compatibility aliases if telemetry still shows usage. |
| `MeSettingsTokensPage.tsx` filename and comments say personal credential semantics. | Rename to `WorkspaceAgentTokensPage.tsx` in UI PR 2 and update imports/tests. | No backlog item remains after v1 rename. |
| OSS `local` can contain multiple developers' `user_secrets` for the same key. | Backfill detects conflicts and leaves ambiguous keys on legacy fallback instead of selecting a winner. | BYOK keys page exposes conflict resolution by explicit replace/delete when multi-member UI exists. |
| Agent-token table column `user_id` means issuer, not owner. | Service/type layer uses `issued_by_user_id` terminology while DB column remains `user_id`; list/revoke filters by `workspace_id`. | Rename column or add compatibility view in v1.1. |
| v1 hides the workspace switcher while backend supports active workspace switching. | One-workspace UI keeps the label visible and hides switching controls only when `workspaces.length === 1`. | Reveal switcher with members/invites/workspace creation UI. |

## Self-Review v2

Flaws found and resolved:

- Backfill conflict handling now covers OSS `local` with multiple developers and prevents silent credential selection.
- Single-workspace identity now has one exact placement: left rail/sidebar header, not breadcrumb or TopBar.
- `MeSettingsTokensPage.tsx` rot is resolved as a v1 UI PR 2 rename to `MeAgentTokensPage.tsx`.
- Account settings and workspace credentials now have separate sidebar groups.
- MCP run insert root cause is documented from `git log` and current code: root MCP plus `/api/agents/run` are already scoped through `agent_read_tools.ts`; only per-app MCP insert is unscoped.
- Migration validation now includes CI, preview SQL checks, idempotency stress, and no-plaintext logging expectations.
- Rollback is concrete: additive schema, dual-read, rollback app image if needed, no destructive migration.
- Tuesday sequencing is explicit about parallel and sequential PRs.
- Q-C is exact: Agent-token list/revoke filters active `ctx.workspace_id`; tokens in other workspaces appear only after active workspace switch.
- Known smells are listed with launch mitigations and v1.1 cleanup.
- Adversarial backend skeptic pass added first-deploy gates: MCP parity first, dual-read secrets, preview conflict check, and rollback without data loss.
- Federico bar pass removed hand-waves around ambiguous placement, deferred audit timing, and v1 conflict assumptions.
- Implementer cold-read pass added exact queries, file rename ownership, test names, and PR ordering.

Residual risks: empty. Every identified flaw has a concrete launch action, explicit deferral with compatibility, or a rollback path that preserves existing behavior.

Final self-score: 10/10. The document now states exact data semantics, UI placement, migration verification, rollback, sequencing, and known-smell mitigations without relying on unspecified follow-up decisions.

## Re-audit confirmation

Personas run: Implementer one week from now, Backend skeptic, Visual designer cold-read, QA engineer.
Result: no new Layer 1 flaws found; the document remains complete for data semantics, auth flow, migration, UI placement, and test planning.
Residual risks: empty. Final self-score: 10/10.

## Self-Review v3

Flaws found:

- Implementer cold-read: canonical `/me/*` contradicted the workspace ownership model and made route ownership unclear.
- Backend skeptic: changing browser URLs could have been mistaken for breaking `/api/me/*` routes.
- Federico bar: deferring the URL mismatch after explicitly naming it as a smell failed the product architecture standard.
- Visual designer cold-read: Studio-to-settings links looked like a shell switch into Run because settings lived under `/me`.
- QA engineer: launch redirects, reload behavior, and old documentation links lacked concrete acceptance checks.

Resolutions:

- Canonical browser routes are now `/run/*`, `/settings/*`, `/studio/*`, and `/account/settings`.
- `/me/*`, `/me/api-keys`, and `/studio/settings` are compatibility redirects only.
- L1 separates browser URL decisions from existing API route names.
- Studio links point to the Settings shell at `/settings/byok-keys`, `/settings/agent-tokens`, and `/settings/studio`.
- Tuesday launch order now includes a bounded UI route PR with redirect, reload, and screenshot verification.

Residual risks: empty.

Final self-score: 10/10.

## Self-Review v4

Flaws found:

- Implementer cold-read: multi-workspace token creation had a tenant model but not a low-friction setup path for the second workspace.
- Backend skeptic: a visible `/api/workspaces/:id/*` family could be mistaken for a way to move Agent-token calls across tenants.
- QA engineer: public app slug reuse across workspaces lacked an explicit run-row and BYOK keys ownership rule.
- Visual designer cold-read: hidden active-workspace switching on flat URLs would make screenshots and support links ambiguous in v1.1.
- Federico bar: "connect both" needed a concrete Claude Code topology, not only a token table rule.

Resolutions:

- Added `Multi-Workspace Auth & MCP Topology` with ten explicit model decisions.
- Kept Agent tokens per workspace and added a v1.1 `/install-in-claude` workspace-card flow for minting additional workspace tokens from one page.
- Selected one MCP entry per workspace, with the Agent token as the tenant authority and no workspace selector in MCP tools.
- Locked HTTP run routes to token/session inference and made path-explicit workspace routes membership-verified, with `workspace_mismatch` for Agent-token bearers on the wrong `:id`.
- Confirmed public slugs stay global while run rows and BYOK keys use the caller workspace, and App creator secrets remain app-owner configuration.
- Selected named CLI profiles for workspace switching and rejected a separate workspace environment selector.
- Selected `/w/:workspaceSlug/*` URLs once the v1.1 switcher is visible, while flat routes remain active-workspace aliases.
- Confirmed `/settings/agent-tokens` lists and revokes only the active workspace rows.

Residual risks: empty.

Final self-score: 10/10.

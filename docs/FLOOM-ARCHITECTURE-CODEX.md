# Floom Architecture

Date: 2026-04-27

Sources verified:

- `docs/FLOOM-ARCHITECTURE-DECISIONS.md`
- `docs/V26-IA-SPEC.md`
- `docs/ARCHITECTURE-WORKSPACE.md`
- `docs/ARCHITECTURE-LAYER-2.md`
- `apps/server/src/db.ts`
- `apps/server/src/types.ts`
- `apps/server/src/routes/*`
- `apps/server/src/services/*`

Legend used in flowchart diagrams:

- Tenant: green
- Identity: yellow
- Credential: blue
- Runtime/data: cream
- Surface/entrypoint: warm dark

Sequence diagrams use Mermaid `box` groups with the same palette because Mermaid sequence syntax does not support `classDef`.

## 1. Top-Level Architecture

```mermaid
flowchart TD
  classDef tenant fill:#dff5e5,stroke:#1f8a4c,color:#123b24,stroke-width:1px
  classDef identity fill:#fff2b8,stroke:#b38b00,color:#3f3100,stroke-width:1px
  classDef credential fill:#d8ebff,stroke:#2f6fb3,color:#12365c,stroke-width:1px
  classDef runtime fill:#fff7df,stroke:#c99a2e,color:#4a3510,stroke-width:1px
  classDef surface fill:#3d2f27,stroke:#7a5b45,color:#fff7df,stroke-width:1px

  U["User"]:::identity
  BA["Better Auth<br/>cookie session"]:::identity
  ATB["Authorization: Bearer<br/>floom_agent_*"]:::credential
  OSS["OSS local fallback<br/>workspace_id = local<br/>user_id = local"]:::tenant

  WS["workspaces<br/>id slug name plan wrapped_dek"]:::tenant
  WM["workspace_members<br/>workspace_id user_id role"]:::tenant
  UAW["user_active_workspace<br/>user_id workspace_id"]:::tenant

  APPS["apps<br/>workspace_id slug visibility publish_status"]:::runtime
  RUNS["runs<br/>workspace_id user_id device_id app_id status"]:::runtime
  THREADS["run_threads<br/>workspace_id user_id device_id"]:::runtime
  MEMORY["app_memory<br/>workspace_id app_slug user_id key"]:::runtime
  TRIG["triggers<br/>workspace_id app_id trigger_type"]:::runtime
  CONN["connections<br/>workspace_id owner_kind owner_id provider"]:::runtime

  BYOK["BYOK keys<br/>workspace_secrets<br/>workspace_id key encrypted value"]:::credential
  AGENT["Agent tokens<br/>agent_tokens<br/>workspace_id user_id scope rate_limit_per_minute"]:::credential
  CREATOR["App creator secrets<br/>app_creator_secrets<br/>app_id workspace_id key encrypted value"]:::credential
  POLICIES["app_secret_policies<br/>app_id key policy"]:::credential

  WEB["Web form surface<br/>/p/:slug"]:::surface
  MCP["MCP surface<br/>/mcp and /mcp/app/:slug"]:::surface
  HTTP["HTTP surface<br/>/api/run and /api/:slug/run"]:::surface
  ADMIN["Workspace admin APIs<br/>/api/workspaces/:id/*"]:::surface
  STUDIO["Studio publish APIs<br/>/api/hub/ingest<br/>/api/studio/build/*"]:::surface
  HOOK["Trigger ingress<br/>/hook/:path"]:::surface

  U --> BA
  U --> ATB
  BA --> UAW
  UAW --> WS
  ATB --> AGENT
  AGENT --> WS
  OSS --> WS
  WS --> WM

  WS --> APPS
  WS --> BYOK
  WS --> AGENT
  WS --> RUNS
  WS --> THREADS
  WS --> MEMORY
  WS --> TRIG
  WS --> CONN
  APPS --> CREATOR
  APPS --> POLICIES

  WEB --> APPS
  WEB --> RUNS
  MCP --> APPS
  MCP --> RUNS
  HTTP --> APPS
  HTTP --> RUNS
  ADMIN --> WS
  ADMIN --> BYOK
  ADMIN --> AGENT
  STUDIO --> APPS
  STUDIO --> CREATOR
  HOOK --> TRIG
  TRIG --> RUNS

  RUNS --> BYOK
  RUNS --> CREATOR
  RUNS --> THREADS
  RUNS --> MEMORY
```

Notes:

- Workspace is the tenant boundary.
- v1 exposes one workspace per user in the UI. `workspace_members` and `user_active_workspace` already exist for v1.1.
- Runtime surfaces stay flat: `/p/:slug`, `/mcp/app/:slug`, and `/api/:slug/run` resolve global app slugs, then write runs into the caller workspace.
- Credential families are separate: BYOK keys are workspace runtime credentials, Agent tokens are workspace headless credentials, App creator secrets are publisher-controlled app credentials.

## 2. Authentication And Authorization Flow

```mermaid
flowchart TD
  classDef tenant fill:#dff5e5,stroke:#1f8a4c,color:#123b24,stroke-width:1px
  classDef identity fill:#fff2b8,stroke:#b38b00,color:#3f3100,stroke-width:1px
  classDef credential fill:#d8ebff,stroke:#2f6fb3,color:#12365c,stroke-width:1px
  classDef runtime fill:#fff7df,stroke:#c99a2e,color:#4a3510,stroke-width:1px
  classDef surface fill:#3d2f27,stroke:#7a5b45,color:#fff7df,stroke-width:1px

  REQ["Incoming request"]:::surface
  DEVICE["getOrCreateDeviceId<br/>floom_device cookie"]:::identity
  BEARER{"Authorization header<br/>Bearer floom_agent_*?"}:::credential
  LOOKUP["lookupAgentToken<br/>agent_tokens.hash<br/>revoked_at IS NULL"]:::credential
  TOKENCTX["SessionContext from token<br/>workspace_id = agent_tokens.workspace_id<br/>user_id = agent_tokens.user_id"]:::tenant
  CLOUD{"FLOOM_CLOUD_MODE true?"}:::identity
  LOCALCTX["OSS context<br/>workspace_id = local<br/>user_id = local<br/>is_authenticated = false"]:::tenant
  BETTER["Better Auth getSession"]:::identity
  AUTHED{"Valid verified session?"}:::identity
  MIRROR["Mirror Better Auth user<br/>into users"]:::identity
  ACTIVE["getActiveWorkspaceId<br/>user_active_workspace.workspace_id"]:::tenant
  PROVISION["provisionPersonalWorkspace<br/>workspaces + workspace_members + user_active_workspace"]:::tenant
  REKEY["rekeyDevice<br/>app_memory runs run_threads connections"]:::runtime
  SESSIONCTX["SessionContext from cookie<br/>workspace_id = active workspace<br/>user_id = users.id"]:::tenant

  REQ --> DEVICE --> BEARER
  BEARER -- yes --> LOOKUP
  LOOKUP -- found --> TOKENCTX
  LOOKUP -- missing/revoked --> INVALID["401 invalid_agent_token"]:::surface
  BEARER -- no --> CLOUD
  CLOUD -- no --> LOCALCTX
  CLOUD -- yes --> BETTER
  BETTER --> AUTHED
  AUTHED -- no --> LOCALCTX
  AUTHED -- yes --> MIRROR --> ACTIVE
  ACTIVE -- none --> PROVISION --> REKEY
  ACTIVE -- exists --> REKEY
  REKEY --> SESSIONCTX

  TOKENCTX --> AUTHZ["Authorization gate"]:::surface
  SESSIONCTX --> AUTHZ
  LOCALCTX --> AUTHZ

  AUTHZ --> PATH{"Path-explicit workspace route?<br/>/api/workspaces/:id/*"}:::surface
  PATH -- yes --> ROLE["assertRole(ctx, :id, role)<br/>admin/editor/viewer"]:::tenant
  ROLE --> ALLOWED["Allowed workspace resource"]:::runtime

  PATH -- no --> RUNTIME{"Runtime or slug route?"}:::surface
  RUNTIME -- run/MCP/HTTP --> APP["Lookup apps.slug or apps.id"]:::runtime
  APP --> VIS["checkAppVisibility<br/>apps.visibility<br/>link_share_token<br/>link_share_requires_auth<br/>workspace_id + author"]:::runtime
  VIS --> ALLOWED
  RUNTIME -- hook --> TRIG["Lookup triggers.webhook_url_path<br/>workspace_id from trigger row"]:::runtime
  TRIG --> ALLOWED
```

Rules verified in code:

- Agent bearer wins when present because `resolveUserContext` checks `getAgentTokenContext(c)` before Better Auth cookies.
- Agent tokens resolve directly to `agent_tokens.workspace_id`; MCP tools do not accept a trusted workspace selector.
- Browser sessions use Better Auth, then `user_active_workspace.workspace_id`; first authenticated request provisions a personal workspace when none exists.
- OSS mode returns `workspace_id = 'local'` and `user_id = 'local'`.
- `/api/workspaces/:id/*` verifies membership or role against `workspace_members`.
- Runtime calls infer workspace from the resolved context. Request bodies cannot change tenant context for `/api/run` or `/api/:slug/run`.

## 3. Database ER

```mermaid
erDiagram
  classDef tenant fill:#dff5e5,stroke:#1f8a4c,color:#123b24,stroke-width:1px
  classDef identity fill:#fff2b8,stroke:#b38b00,color:#3f3100,stroke-width:1px
  classDef credential fill:#d8ebff,stroke:#2f6fb3,color:#12365c,stroke-width:1px
  classDef runtime fill:#fff7df,stroke:#c99a2e,color:#4a3510,stroke-width:1px
  classDef surface fill:#3d2f27,stroke:#7a5b45,color:#fff7df,stroke-width:1px

  users ||--o{ workspace_members : joins
  workspaces ||--o{ workspace_members : has
  users ||--|| user_active_workspace : selects
  workspaces ||--o{ user_active_workspace : active_for
  workspaces ||--o{ apps : owns
  workspaces ||--o{ workspace_secrets : stores
  workspaces ||--o{ agent_tokens : mints
  users ||--o{ agent_tokens : issues
  apps ||--o{ app_creator_secrets : has
  workspaces ||--o{ app_creator_secrets : encrypts
  apps ||--o{ runs : executed_as
  workspaces ||--o{ runs : receives
  workspaces ||--o{ run_threads : scopes
  run_threads ||--o{ runs : groups
  workspaces ||--o{ app_memory : stores
  apps ||--o{ triggers : fires
  workspaces ||--o{ triggers : owns
  workspaces ||--o{ connections : owns

  users {
    TEXT id PK
    TEXT workspace_id FK
    TEXT email
    TEXT name
    TEXT auth_provider
    TEXT auth_subject
    TEXT image
    INTEGER is_admin
    TEXT deleted_at
    TEXT delete_at
    TEXT composio_user_id
    TEXT created_at
  }

  workspaces {
    TEXT id PK
    TEXT slug UK
    TEXT name
    TEXT plan
    TEXT wrapped_dek
    TEXT created_at
    TEXT updated_at
  }

  workspace_members {
    TEXT workspace_id PK,FK
    TEXT user_id PK,FK
    TEXT role
    TEXT joined_at
  }

  user_active_workspace {
    TEXT user_id PK
    TEXT workspace_id FK
    TEXT updated_at
  }

  apps {
    TEXT id PK
    TEXT slug UK
    TEXT name
    TEXT description
    TEXT manifest
    TEXT status
    TEXT docker_image
    TEXT code_path
    TEXT category
    TEXT author
    TEXT icon
    TEXT app_type
    TEXT base_url
    TEXT auth_type
    TEXT auth_config
    TEXT openapi_spec_url
    TEXT openapi_spec_cached
    TEXT visibility
    TEXT link_share_token
    INTEGER link_share_requires_auth
    TEXT review_submitted_at
    TEXT review_decided_at
    TEXT review_decided_by
    TEXT review_comment
    INTEGER is_async
    TEXT webhook_url
    INTEGER timeout_ms
    INTEGER retries
    TEXT async_mode
    INTEGER max_run_retention_days
    INTEGER featured
    INTEGER avg_run_ms
    TEXT publish_status
    TEXT thumbnail_url
    INTEGER stars
    INTEGER hero
    TEXT workspace_id FK
    TEXT memory_keys
    TEXT created_at
    TEXT updated_at
    TEXT sharing_visibility "PROPOSED"
    TEXT sharing_grants_json "PROPOSED"
    TEXT rate_limit_scope "PROPOSED"
    INTEGER rate_limit_per_minute "PROPOSED"
  }

  workspace_secrets {
    TEXT workspace_id PK,FK
    TEXT key PK
    TEXT ciphertext
    TEXT nonce
    TEXT auth_tag
    TEXT created_at
    TEXT updated_at
    TEXT created_by_user_id "PROPOSED"
    TEXT sharing_visibility "PROPOSED"
    TEXT sharing_grants_json "PROPOSED"
    TEXT rate_limit_scope "PROPOSED"
    INTEGER rate_limit_per_minute "PROPOSED"
  }

  agent_tokens {
    TEXT id PK
    TEXT prefix
    TEXT hash UK
    TEXT label
    TEXT scope
    TEXT workspace_id FK
    TEXT user_id FK
    TEXT created_at
    TEXT last_used_at
    TEXT revoked_at
    INTEGER rate_limit_per_minute
    TEXT sharing_visibility "PROPOSED"
    TEXT sharing_grants_json "PROPOSED"
    TEXT rate_limit_scope "PROPOSED"
  }

  app_creator_secrets {
    TEXT app_id PK,FK
    TEXT workspace_id FK
    TEXT key PK
    TEXT ciphertext
    TEXT nonce
    TEXT auth_tag
    TEXT created_at
    TEXT updated_at
    TEXT created_by_user_id "PROPOSED"
    TEXT sharing_visibility "PROPOSED"
    TEXT sharing_grants_json "PROPOSED"
  }

  runs {
    TEXT id PK
    TEXT app_id FK
    TEXT thread_id FK
    TEXT action
    TEXT inputs
    TEXT outputs
    TEXT logs
    TEXT status
    TEXT error
    TEXT error_type
    INTEGER upstream_status
    INTEGER duration_ms
    TEXT started_at
    TEXT finished_at
    TEXT workspace_id FK
    TEXT user_id
    TEXT device_id
    INTEGER is_public
  }

  run_threads {
    TEXT id PK
    TEXT title
    TEXT created_at
    TEXT updated_at
    TEXT workspace_id FK
    TEXT user_id
    TEXT device_id
  }

  app_memory {
    TEXT workspace_id PK,FK
    TEXT app_slug PK
    TEXT user_id PK
    TEXT device_id
    TEXT key PK
    TEXT value
    TEXT updated_at
  }

  triggers {
    TEXT id PK
    TEXT app_id FK
    TEXT user_id FK
    TEXT workspace_id FK
    TEXT action
    TEXT inputs
    TEXT trigger_type
    TEXT cron_expression
    TEXT tz
    TEXT webhook_secret
    TEXT webhook_url_path
    INTEGER next_run_at
    INTEGER last_fired_at
    INTEGER enabled
    TEXT retry_policy
    INTEGER created_at
    INTEGER updated_at
  }

  connections {
    TEXT id PK
    TEXT workspace_id FK
    TEXT owner_kind
    TEXT owner_id
    TEXT provider
    TEXT composio_connection_id
    TEXT composio_account_id
    TEXT status
    TEXT metadata_json
    TEXT created_at
    TEXT updated_at
  }

  class workspaces,workspace_members,user_active_workspace tenant
  class users identity
  class workspace_secrets,agent_tokens,app_creator_secrets credential
  class apps,runs,run_threads,app_memory,triggers,connections runtime
```

### Schema Notes

Fields that exist today:

- Tenant and membership: `workspaces.id`, `workspaces.slug`, `workspaces.name`, `workspaces.plan`, `workspaces.wrapped_dek`, `workspace_members.workspace_id`, `workspace_members.user_id`, `workspace_members.role`, `user_active_workspace.user_id`, `user_active_workspace.workspace_id`.
- Identity: `users.id`, `users.email`, `users.name`, `users.auth_provider`, `users.auth_subject`, `users.image`, `users.is_admin`, `users.deleted_at`, `users.delete_at`, `users.composio_user_id`.
- Apps: `apps.workspace_id`, `apps.slug`, `apps.visibility`, `apps.link_share_token`, `apps.link_share_requires_auth`, `apps.publish_status`, `apps.author`, `apps.manifest`, `apps.memory_keys`, `apps.max_run_retention_days`.
- BYOK keys: `workspace_secrets.workspace_id`, `workspace_secrets.key`, `workspace_secrets.ciphertext`, `workspace_secrets.nonce`, `workspace_secrets.auth_tag`.
- Legacy per-user BYOK fallback: `user_secrets.workspace_id`, `user_secrets.user_id`, `user_secrets.key`, `user_secrets.ciphertext`, `user_secrets.nonce`, `user_secrets.auth_tag`.
- Agent tokens: `agent_tokens.workspace_id`, `agent_tokens.user_id`, `agent_tokens.scope`, `agent_tokens.rate_limit_per_minute`, `agent_tokens.revoked_at`, `agent_tokens.last_used_at`, `agent_tokens.hash`.
- App creator secrets: `app_creator_secrets.app_id`, `app_creator_secrets.workspace_id`, `app_creator_secrets.key`, encrypted value columns, plus `app_secret_policies.app_id`, `app_secret_policies.key`, `app_secret_policies.policy`.
- Runs and runtime state: `runs.workspace_id`, `runs.user_id`, `runs.device_id`, `runs.is_public`, `run_threads.workspace_id`, `run_threads.user_id`, `run_threads.device_id`, `app_memory.workspace_id`, `triggers.workspace_id`, `connections.workspace_id`.

Fields to add for the locked visibility and rate-limit model:

- Add `sharing_visibility` to `apps`, `workspace_secrets`, `agent_tokens`, and any future shareable resource. Allowed values: `only_me`, `selected`, `public`.
- Add `sharing_grants_json` for the v1.1 selected state, or replace it with a normalized grants table before multi-member UI ships. The grants payload represents workspace members or external users explicitly selected for access.
- Add `created_by_user_id` to `workspace_secrets` and `app_creator_secrets` so "only me" can be enforced without relying on `workspace_id` alone.
- Add `rate_limit_scope` to `apps`, `workspace_secrets`, and `agent_tokens`. Allowed values: `global`, `per_member`, `per_caller`.
- Reuse existing `agent_tokens.rate_limit_per_minute` for Agent tokens. Add `rate_limit_per_minute` to apps and BYOK resources for the v26 resource pattern.

Migration path:

1. Keep current app sharing fields in place: `apps.visibility`, `apps.link_share_token`, `apps.link_share_requires_auth`, and the current invite/review fields keep public app behavior stable.
2. Add nullable proposed columns in an additive migration. Backfill apps from current state: `private` maps to `only_me`; `link`, `public`, `public_live`, and legacy `public` map to `public`; `invited` maps to `selected`.
3. Backfill Agent tokens with `sharing_visibility = 'only_me'` for v1, `rate_limit_scope = 'global'`, and `rate_limit_per_minute = agent_tokens.rate_limit_per_minute`.
4. Backfill workspace BYOK rows with `sharing_visibility = 'public'` in v1 because current `workspace_secrets` are workspace-level and have no creator column. New rows can set `created_by_user_id`.
5. Keep `user_secrets` as the legacy private fallback until all BYOK keys have an owner and sharing state. Then remove the fallback only after a migration report shows no unresolved `workspace_secret_backfill_conflicts`.
6. v1 ships `only_me` plus `public` and `global` rate limits. v1.1 turns on `selected`, `per_member`, and `per_caller` after members and selected-grants UI ship.

## 4. Visibility And Rate-Limit Model

```mermaid
flowchart TD
  classDef tenant fill:#dff5e5,stroke:#1f8a4c,color:#123b24,stroke-width:1px
  classDef identity fill:#fff2b8,stroke:#b38b00,color:#3f3100,stroke-width:1px
  classDef credential fill:#d8ebff,stroke:#2f6fb3,color:#12365c,stroke-width:1px
  classDef runtime fill:#fff7df,stroke:#c99a2e,color:#4a3510,stroke-width:1px
  classDef surface fill:#3d2f27,stroke:#7a5b45,color:#fff7df,stroke-width:1px

  RESOURCE["Shareable resource"]:::runtime
  APP["App<br/>apps.id"]:::runtime
  BYOK["BYOK key<br/>workspace_secrets.workspace_id + key"]:::credential
  TOKEN["Agent token<br/>agent_tokens.id"]:::credential
  CREATOR["App creator secret<br/>app_creator_secrets.app_id + key"]:::credential

  VIS["sharing_visibility"]:::runtime
  ONLY["only_me<br/>creator/member only"]:::identity
  SELECTED["selected<br/>explicit grants<br/>v1.1"]:::identity
  PUBLIC["public<br/>workspace-wide or global app"]:::identity

  RATE["rate_limit_scope"]:::runtime
  GLOBAL["global<br/>v1 active"]:::tenant
  MEMBER["per_member<br/>v1.1"]:::tenant
  CALLER["per_caller<br/>v1.1"]:::tenant

  EXISTING["Current implementation"]:::surface
  APPFIELDS["apps.visibility<br/>link_share_token<br/>link_share_requires_auth<br/>publish_status"]:::runtime
  TOKENFIELD["agent_tokens.rate_limit_per_minute"]:::credential
  PROCESS["process-local limiter<br/>ip user app agent_token mcp_ingest"]:::runtime

  RESOURCE --> APP
  RESOURCE --> BYOK
  RESOURCE --> TOKEN
  RESOURCE --> CREATOR
  RESOURCE --> VIS
  VIS --> ONLY
  VIS --> SELECTED
  VIS --> PUBLIC
  RESOURCE --> RATE
  RATE --> GLOBAL
  RATE --> MEMBER
  RATE --> CALLER

  EXISTING --> APPFIELDS
  EXISTING --> TOKENFIELD
  EXISTING --> PROCESS
  APPFIELDS --> APP
  TOKENFIELD --> TOKEN
  PROCESS --> GLOBAL
```

v1 contract:

- Visibility levels exposed: `only_me` and `public`.
- Rate-limit mode exposed: `global`.
- Existing app sharing continues through `apps.visibility`, `link_share_token`, and `link_share_requires_auth`.
- Agent tokens already have per-token throttling through `agent_tokens.rate_limit_per_minute` and the `agent_token` process-local bucket.

v1.1 contract:

- Visibility level added: `selected`, backed by explicit selected users or members.
- Rate-limit modes added: `per_member` and `per_caller`.
- Workspace switcher and members UI make selected access meaningful.
- Optional app-scoped Agent token bindings can land as a separate extension.

## 5. Run Lifecycle

```mermaid
sequenceDiagram
  autonumber
  box rgb(61, 47, 39) Surface
    participant Caller as Caller<br/>Web MCP HTTP
  end
  box rgb(255, 242, 184) Identity
    participant Auth as resolveUserContext
  end
  box rgb(255, 247, 223) Runtime
    participant App as apps lookup
    participant Gate as visibility + rate gates
    participant DB as SQLite
    participant Runner as dispatchRun
  end
  box rgb(216, 235, 255) Credentials
    participant BYOK as workspace_secrets<br/>user_secrets fallback
    participant Creator as app_creator_secrets<br/>app_secret_policies
  end

  Caller->>Auth: request with cookie or floom_agent_* bearer
  Auth-->>Caller: SessionContext(workspace_id, user_id, device_id)
  Caller->>App: app_slug or app_id
  App->>DB: SELECT * FROM apps WHERE slug/id
  DB-->>App: AppRecord(workspace_id, visibility, manifest)
  App->>Gate: checkAppVisibility + runGate
  Gate->>Gate: check process-local buckets<br/>ip user app agent_token
  Gate-->>Caller: 401/403/404/429 when blocked
  Gate-->>Caller: allowed
  Caller->>DB: INSERT runs(id, app_id, action, inputs, status, workspace_id, user_id, device_id)
  Caller->>Runner: dispatchRun(app, manifest, runId, action, inputs, perCallSecrets, ctx)
  Runner->>DB: SELECT app_secret_policies WHERE app_id
  Runner->>Creator: load creator_override keys<br/>using app.workspace_id
  Creator-->>Runner: decrypted creator secrets
  Runner->>BYOK: load user_vault keys<br/>using ctx.workspace_id
  BYOK-->>Runner: workspace BYOK or user_secrets fallback
  Runner->>Runner: per-call _auth overrides persisted secrets
  Runner->>DB: UPDATE runs SET status = running
  Runner->>Runner: run proxied app or Docker action
  Runner->>DB: UPDATE runs SET outputs/error/status/duration_ms/finished_at
  Caller->>DB: GET /api/run/:id or stream
  DB-->>Caller: owner/full view or public redacted output
```

Facts verified in code:

- `/api/run` and `/api/:slug/run` insert `workspace_id`, `user_id`, and `device_id` into `runs`.
- `dispatchRun` loads creator override secrets from the app owner workspace, then user-vault secrets from the caller workspace, then applies per-call `_auth`.
- `runs.is_public` only affects redacted output sharing for a run. It does not expose inputs, logs, or upstream diagnostics.
- MCP root read tools and `/api/agents/run` share `agent_read_tools.runApp`; per-app MCP also inserts scoped runs in `routes/mcp.ts`.

## 6. URL To Resource Resolution

```mermaid
flowchart TD
  classDef tenant fill:#dff5e5,stroke:#1f8a4c,color:#123b24,stroke-width:1px
  classDef identity fill:#fff2b8,stroke:#b38b00,color:#3f3100,stroke-width:1px
  classDef credential fill:#d8ebff,stroke:#2f6fb3,color:#12365c,stroke-width:1px
  classDef runtime fill:#fff7df,stroke:#c99a2e,color:#4a3510,stroke-width:1px
  classDef surface fill:#3d2f27,stroke:#7a5b45,color:#fff7df,stroke-width:1px

  URL["Request URL"]:::surface
  AUTHURL{"/auth/* ?"}:::identity
  PUBLIC{"Public page or asset?<br/>/ /apps /docs /pricing /skill.md"}:::surface
  PURL{"/p/:slug<br/>or /p/:slug/skill.md ?"}:::surface
  WORKSPACE{"/api/workspaces/:id/* ?"}:::surface
  SESSION{"/api/session/* ?"}:::identity
  RUN{"/api/run<br/>/api/:slug/run<br/>/api/:slug/jobs ?"}:::surface
  MCP{"/mcp<br/>/mcp/search<br/>/mcp/app/:slug ?"}:::surface
  ME{"/api/me/* compatibility API ?"}:::surface
  STUDIO{"/api/hub/*<br/>/api/studio/build/* ?"}:::surface
  HOOK{"/hook/:path ?"}:::surface
  RENDER{"/renderer/:slug/*<br/>/og/:slug.svg ?"}:::surface
  OTHER["Other admin/public utilities<br/>health metrics waitlist feedback stripe"]:::surface

  CTX["resolveUserContext<br/>token, cookie, or local"]:::identity
  PATHWS["Use :id<br/>verify workspace_members role"]:::tenant
  ACTIVEWS["Use ctx.workspace_id"]:::tenant
  APPROW["Lookup apps.slug"]:::runtime
  APPWS["App owner workspace<br/>apps.workspace_id"]:::tenant
  RUNWS["Run owner workspace<br/>ctx.workspace_id"]:::tenant
  TRIGGERROW["Lookup triggers.webhook_url_path"]:::runtime
  TRIGGERWS["Trigger workspace<br/>triggers.workspace_id"]:::tenant
  STATICAPP["Lookup app asset by slug<br/>no run workspace"]:::runtime

  URL --> AUTHURL
  AUTHURL -- yes --> BETTER["Better Auth callback/session tables"]:::identity
  AUTHURL -- no --> PUBLIC
  PUBLIC -- yes --> STATIC["No tenant required unless UI calls /api/session/me"]:::runtime
  PUBLIC -- no --> PURL

  PURL -- yes --> APPROW
  APPROW --> APPWS
  APPROW --> CTX
  CTX --> RUNWS
  PURL -- no --> WORKSPACE

  WORKSPACE -- yes --> CTX --> PATHWS
  WORKSPACE -- no --> SESSION
  SESSION -- yes --> CTX
  SESSION -- no --> RUN

  RUN -- yes --> CTX
  RUN --> APPROW
  RUN --> RUNWS
  RUN -- no --> MCP

  MCP -- yes --> CTX
  MCP --> APPROW
  MCP --> RUNWS
  MCP -- no --> ME

  ME -- yes --> CTX
  ME --> ACTIVEWS
  ME -- no --> STUDIO

  STUDIO -- yes --> CTX
  STUDIO --> ACTIVEWS
  STUDIO --> APPROW
  STUDIO -- no --> HOOK

  HOOK -- yes --> TRIGGERROW --> TRIGGERWS
  HOOK -- no --> RENDER

  RENDER -- yes --> STATICAPP
  RENDER -- no --> OTHER
```

Resolution rules:

- Browser IA uses `/run/*`, `/studio/*`, `/settings/*`, and `/account/settings`. Older `/me/*` browser paths remain redirects or compatibility aliases.
- Runtime APIs keep flat slugs: `/p/:slug`, `/mcp/app/:slug`, `/api/:slug/run`.
- Flat app slug lookup uses `apps.slug`, which is globally unique today.
- Runs are inserted into the caller workspace, not the app owner workspace.
- BYOK keys load from the caller workspace. App creator secrets load from `apps.workspace_id`.
- Webhooks and callbacks use stable flat URLs, then resolve workspace from the target row (`triggers.workspace_id`, build rows, Stripe rows).

## Route Surface Snapshot

Primary mounted route families verified in `apps/server/src/index.ts`:

- Public/utility: `/api/health`, `/api/gh-stars`, `/api/metrics`, `/api/waitlist`, `/api/deploy-waitlist`, `/skill.md`, `/p/:slug/skill.md`, `/openapi.json`.
- App store and Studio: `/api/hub`, `/api/hub/ingest`, `/api/hub/:slug`, `/api/hub/:slug/runs`, `/api/hub/:slug/triggers`, `/api/studio/build/*`.
- Runtime: `/api/run`, `/api/:slug/run`, `/api/:slug/jobs`, `/api/:slug/quota`, `/api/agents/*`, `/mcp`, `/mcp/search`, `/mcp/app/:slug`.
- Workspace admin: `/api/workspaces`, `/api/workspaces/:id`, `/api/workspaces/:id/secrets`, `/api/workspaces/:id/agent-tokens`, `/api/workspaces/:id/members`, `/api/workspaces/:id/invites`.
- Compatibility workspace APIs: `/api/me/runs`, `/api/me/agent-keys`, `/api/secrets`, `/api/memory/:app_slug`, `/api/me/apps/:slug/*`, `/api/me/triggers`.
- External callbacks: `/hook/:path`, `/api/studio/build/github-webhook`, `/api/stripe/webhook`.

## ADR Coverage Checklist

- ADR-001 creator analytics: run data remains private by default; public run sharing is opt-in through `runs.is_public`.
- ADR-002 source visibility: app visibility and source visibility are separate axes; current schema has app sharing fields, source-specific UI remains separate from runtime auth.
- ADR-003 workspaces and roles: `workspace_members.role` keeps `admin`, `editor`, and `viewer`.
- ADR-008 app sharing: current app states are modeled in `apps.visibility` plus review and link fields; v1.1 selected sharing extends the same resource pattern.
- ADR-009 agents-native: Agent tokens are workspace credentials used by MCP, HTTP, CLI, and agent APIs.
- ADR-014 abuse posture: process-local rate limits cover IP, user, app, Agent token, write routes, and MCP ingest.
- ADR-017 Shadcn: UI-only, no backend schema impact.
- V26 point 11: resource sharing and rate limits are represented as a mandatory pattern across apps, BYOK keys, and Agent tokens.

## Self-Review

Flaws found during review:

- The initial ER shape risked hiding existing app sharing fields behind proposed names. This version lists `apps.visibility`, `link_share_token`, `link_share_requires_auth`, and `publish_status` explicitly, then marks proposed additions with `PROPOSED`.
- `workspace_secrets` cannot currently enforce "only me" because the table has no `created_by_user_id` and its primary key is `(workspace_id, key)`. The migration notes call this out and keep `user_secrets` as the private fallback until ownership is migrated.
- Mermaid sequence diagrams do not parse `classDef`. The run lifecycle uses `box rgb(...)` grouping with the same palette and documents that syntax limit.
- `run_threads` is present in the schema with workspace columns, but `routes/thread.ts` has an audit note in Layer 2 that its route handlers are still being tightened. The ER reflects schema state, not a claim that every thread route path is already fully scoped.
- The proposed visibility/rate-limit fields are not in `src/db.ts` today. They are deliberately marked `PROPOSED` and isolated in the schema notes and ER.

Verification performed:

- Source files and architecture docs listed at the top were read before writing.
- Route families were checked against `apps/server/src/index.ts` and `apps/server/src/routes/*`.
- Schema field names were checked against `apps/server/src/db.ts` and `apps/server/src/types.ts`.
- Mermaid parsing was run against every Mermaid block in this document with Mermaid 11.14.0.

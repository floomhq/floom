# Floom Workspace Architecture Layer 2

Date: 2026-04-27  
Launch constraint: Tuesday 2026-04-28  
Scope: ASCII IA tree, API route matrix, and v1 must-land file inventory.

## A. ASCII IA Tree

```text
Floom
|-- Public surfaces
|   |-- /                       Landing
|   |-- /apps                   Public app directory
|   |-- /p/:slug                Public app run surface
|   |-- /p/:slug/skill.md       Public app skill markdown
|   |-- /install-in-claude      Claude install helper page
|   |-- /login                  Auth entry
|   |-- /signup                 Auth entry
|   |-- /auth/*                 Better Auth callbacks and forms
|   `-- /skill.md               Global skill markdown
|
`-- Workspace
    |-- Identity
    |   |-- Active workspace name visible in Run shell
    |   |-- Active workspace name visible in Studio shell
    |   `-- Workspace switcher hidden until workspaces.length > 1
    |
    |-- Run mode
    |   |-- /run
    |   |   `-- Workspace Run dashboard
    |   |-- /run/apps
    |   |   `-- Runnable apps in active workspace
    |   |-- /run/apps/:slug
    |   |   |-- App overview for runner context
    |   |   |-- /run
    |   |   `-- /secrets
    |   |-- /run/runs
    |   |   `-- Active workspace run history
    |   |-- /run/runs/:id
    |   |   `-- Run detail
    |   `-- /run/install
    |       `-- Authenticated install helper
    |
    |-- Studio mode
    |   |-- /studio
    |   |   `-- Apps list and Studio dashboard
    |   |-- /studio/build
    |   |   `-- Build or ingest an app into active workspace
    |   |-- /studio/apps/:slug
    |   |   |-- Overview
    |   |   |-- Runs
    |   |   |-- Secrets
    |   |   |   `-- App creator secrets
    |   |   |-- Access
    |   |   |-- Renderer
    |   |   |-- Analytics
    |   |   `-- Triggers
    |   `-- /studio/settings
    |       `-- Redirect to /settings/studio
    |
    `-- Settings
        |-- Workspace settings
        |   |-- /settings/byok-keys
        |   |   `-- BYOK keys
        |   |-- /settings/agent-tokens
        |   |   `-- Agent tokens
        |   |-- /settings/studio
        |   |   `-- Studio-local General/GitHub configuration
        |   |-- Members [v1.1]
        |   `-- Billing [v1.1]
        `-- Account
            `-- /account/settings
                `-- Account settings

Compatibility redirects:

- `/me` -> `/run`
- `/me/apps*` -> `/run/apps*`
- `/me/runs*` -> `/run/runs*`
- `/me/install` -> `/run/install`
- `/me/secrets` -> `/settings/byok-keys`
- `/me/agent-keys` and `/me/api-keys` -> `/settings/agent-tokens`
- `/me/settings` -> `/account/settings`
- `/studio/settings` -> `/settings/studio`
```

## B. API Route Matrix

Legend:

- `Auth`: route-level requirement after global middleware. In self-host, `FLOOM_AUTH_TOKEN` can gate `/api/*`, `/mcp/*`, and `/p/*` except documented exemptions.
- `Workspace resolution`: how the handler selects tenant context.
- `Implicit/Explicit`: `Token-implicit` means credential or session selects workspace. `Path-explicit` means a route path carries the workspace id. `Slug-explicit` means app slug is global and workspace is read from the app row plus caller context.

| Route | Method | Auth | Workspace resolution | Token-implicit / Path-explicit | v1 status | v1.1 plan |
|---|---:|---|---|---|---|---|
| `/api/health` | GET | Public | None | No workspace | Keep | Keep |
| `/api/gh-stars` | GET | Public | None | No workspace | Keep | Keep |
| `/api/metrics` | GET | `METRICS_TOKEN` when configured | None | No workspace | Keep | Keep |
| `/api/admin/apps/:slug/publish-status` | POST | Admin | App slug row | Slug-explicit | Keep admin-only | Keep |
| `/api/admin/review-queue` | GET | Admin | None | No workspace | Keep admin-only | Keep |
| `/api/admin/review-queue/:slug` | GET | Admin | App slug row | Slug-explicit | Keep admin-only | Keep |
| `/api/admin/review-queue/:slug/approve` | POST | Admin | App slug row | Slug-explicit | Keep admin-only | Keep |
| `/api/admin/review-queue/:slug/reject` | POST | Admin | App slug row | Slug-explicit | Keep admin-only | Keep |
| `/api/admin/apps/:slug/takedown` | POST | Admin | App slug row | Slug-explicit | Keep admin-only | Keep |
| `/api/admin/audit-log` | GET | Admin | Audit rows | No workspace | Keep admin-only | Add workspace filter when needed |
| `/api/admin/audit-log/:id` | GET | Admin | Audit row | No workspace | Keep admin-only | Add workspace filter when needed |
| `/api/admin/pending-deletes` | GET | Admin | User rows | No workspace | Keep admin-only | Keep |
| `/api/session/me` | GET | Optional browser or Agent token | `resolveUserContext` | Token-implicit | Keep | Include richer workspace list for switcher |
| `/api/session/switch-workspace` | POST | Browser session | Membership check then `user_active_workspace` | Token-implicit | Keep hidden in single-workspace UI | Used by visible switcher |
| `/api/workspaces` | GET | Browser session in Cloud, local in OSS | Membership list for user | Path family | Keep | Keep |
| `/api/workspaces` | POST | Browser session in Cloud, local in OSS | New workspace plus membership | Path family | Backend live, UI hidden | Expose creation UI |
| `/api/workspaces/:id` | GET | Member | `:id` verified by membership | Path-explicit | Keep | Keep |
| `/api/workspaces/:id` | PATCH | Admin/editor | `:id` verified by role | Path-explicit | Keep | Use for settings General |
| `/api/workspaces/:id` | DELETE | Admin | `:id` verified by role | Path-explicit | Keep guarded | Expose only with deletion UX |
| `/api/workspaces/:id/runs` | DELETE | Admin/editor | `:id` verified by role | Path-explicit | Keep backend utility | Add GET alias for run history |
| `/api/workspaces/:id/members` | GET | Member | `:id` verified by membership | Path-explicit | Backend live, UI hidden | Members UI |
| `/api/workspaces/:id/members/:user_id` | PATCH | Admin | `:id` verified by role | Path-explicit | Backend live, UI hidden | Members UI |
| `/api/workspaces/:id/members/:user_id` | DELETE | Admin | `:id` verified by role | Path-explicit | Backend live, UI hidden | Members UI |
| `/api/workspaces/:id/members/invite` | POST | Admin/editor | `:id` verified by role | Path-explicit | Backend live, UI hidden | Invites UI |
| `/api/workspaces/:id/invites` | GET | Admin/editor | `:id` verified by role | Path-explicit | Backend live, UI hidden | Invites UI |
| `/api/workspaces/:id/invites/:invite_id` | DELETE | Admin/editor | `:id` verified by role | Path-explicit | Backend live, UI hidden | Invites UI |
| `/api/workspaces/:id/members/accept-invite` | POST | Browser session | Invite token maps to workspace | Path-explicit | Backend live | Invites UI |
| `/api/workspaces/:id/secrets` | GET/POST/DELETE | Browser session plus role | `:id` verified by role | Path-explicit | Add as canonical alias | Settings canonical route |
| `/api/workspaces/:id/agent-tokens` | GET/POST/REVOKE | Browser session plus role | `:id` verified by role | Path-explicit | Add as canonical alias | Settings canonical route |
| `/api/workspaces/:id/apps` | GET | Member | `:id` verified by membership | Path-explicit | Defer | Alias for `/api/hub/mine` |
| `/api/workspaces/:id/runs` | GET | Member | `:id` verified by membership | Path-explicit | Defer | Alias for `/api/me/runs` |
| `/api/me/agent-keys` | GET | Browser session, no Agent-token management | Active workspace from context | Token-implicit | Change list to `workspace_id` | Alias to workspace token route |
| `/api/me/agent-keys` | POST | Browser session, no Agent-token management | Active workspace or body `workspace_id` after access check | Token-implicit | Keep, mint workspace token | Alias to workspace token route |
| `/api/me/agent-keys/:id/revoke` | POST | Browser session, no Agent-token management | Active workspace from context | Token-implicit | Change revoke to `workspace_id` | Alias to workspace token route |
| `/api/secrets` | GET | Browser session in Cloud, local in OSS | Active workspace from context | Token-implicit | Change to workspace BYOK list | Alias to workspace secrets route |
| `/api/secrets` | POST | Browser session in Cloud, local in OSS | Active workspace from context | Token-implicit | Change to workspace BYOK upsert | Alias to workspace secrets route |
| `/api/secrets/:key` | DELETE | Browser session in Cloud, local in OSS | Active workspace from context | Token-implicit | Change to workspace BYOK delete | Alias to workspace secrets route |
| `/api/memory/:app_slug` | GET | Context scoped | Active workspace plus app slug | Token-implicit | Keep | Keep |
| `/api/memory/:app_slug` | POST | Context scoped | Active workspace plus app slug | Token-implicit | Keep | Keep |
| `/api/memory/:app_slug/:key` | DELETE | Context scoped | Active workspace plus app slug | Token-implicit | Keep | Keep |
| `/api/hub` | GET | Public | Public app rows | No workspace | Keep | Keep |
| `/api/hub/:slug` | GET | Public or app visibility gated | Global app slug plus caller context | Slug-explicit | Keep | Keep flat slugs |
| `/api/hub/mine` | GET | Context scoped | Active workspace from context | Token-implicit | Change semantics to workspace-owned apps | Alias to `/api/workspaces/:id/apps` |
| `/api/hub/detect` | POST | Browser session in Cloud, local in OSS | Active workspace only for auth gate | Token-implicit | Keep | Keep |
| `/api/hub/detect/hint` | POST | Public | None | No workspace | Keep | Keep |
| `/api/hub/detect/inline` | POST | Browser session in Cloud, local in OSS | Active workspace only for auth gate | Token-implicit | Keep | Keep |
| `/api/hub/ingest` | POST | Browser session or publish Agent token | Active workspace from context | Token-implicit | Keep | Keep |
| `/api/hub/:slug/runs` | GET | Owner/member context | App slug plus active caller scope | Slug-explicit | Keep | Keep |
| `/api/hub/:slug/runs-by-day` | GET | Owner/member context | App slug plus active caller scope | Slug-explicit | Keep | Keep |
| `/api/hub/:slug` | PATCH | Owner/member context | App slug row workspace plus caller context | Slug-explicit | Keep | Keep |
| `/api/hub/:slug` | DELETE | Owner/member context | App slug row workspace plus caller context | Slug-explicit | Keep | Keep |
| `/api/hub/:slug/renderer` | POST | Owner/member context | App slug row workspace plus caller context | Slug-explicit | Keep | Keep |
| `/api/hub/:slug/renderer` | DELETE | Owner/member context | App slug row workspace plus caller context | Slug-explicit | Keep | Keep |
| `/api/run` | POST | Context scoped, app visibility gated | Active workspace for run row, app slug from body | Token-implicit | Keep | Keep |
| `/api/run/:id` | GET | Context scoped | Active workspace plus user/device scope | Token-implicit | Keep | Keep |
| `/api/run/:id/stream` | GET | Context scoped | Active workspace plus user/device scope | Token-implicit | Keep | Keep |
| `/api/run/:id/share` | POST | Context scoped | Active workspace plus user/device scope | Token-implicit | Keep | Keep |
| `/api/:slug/run` | POST | Context scoped, app visibility gated | Global app slug plus active workspace for run row | Slug-explicit | Keep | Keep flat |
| `/api/:slug/quota` | GET | Public/context optional | Global app slug plus device/user quota context | Slug-explicit | Keep | Keep |
| `/api/:slug/jobs` | POST | Context scoped, app visibility gated | Global app slug plus active workspace for job/run | Slug-explicit | Keep | Keep |
| `/api/:slug/jobs/:job_id` | GET | Context scoped | Global app slug plus job ownership | Slug-explicit | Keep | Keep |
| `/api/:slug/jobs/:job_id/cancel` | POST | Context scoped | Global app slug plus job ownership | Slug-explicit | Keep | Keep |
| `/api/me/runs` | GET | Context scoped | Active workspace plus user/device scope | Token-implicit | Keep after MCP insert fix | Alias to `/api/workspaces/:id/runs` |
| `/api/me/runs` | DELETE | Browser session in Cloud, local in OSS | Active workspace plus owner scope | Token-implicit | Keep | Keep |
| `/api/me/runs/:id` | GET | Context scoped | Active workspace plus user/device scope | Token-implicit | Keep | Keep |
| `/api/me/runs/:id` | DELETE | Browser session in Cloud, local in OSS | Active workspace plus owner scope | Token-implicit | Keep | Keep |
| `/api/me/invites` | GET | Browser session | User invite rows | Token-implicit | Keep | Members UI in v1.1 |
| `/api/me/invites/:invite_id/accept` | POST | Browser session | Invite maps user to workspace | Token-implicit | Keep | Members UI in v1.1 |
| `/api/me/invites/:invite_id/decline` | POST | Browser session | Invite maps user to workspace | Token-implicit | Keep | Members UI in v1.1 |
| `/api/me/studio/stats` | GET | Context scoped | Active workspace | Token-implicit | Keep | Keep |
| `/api/me/studio/activity` | GET | Context scoped | Active workspace | Token-implicit | Keep | Keep |
| `/api/agents/apps` | GET | Agent token or browser context | Active workspace from context | Token-implicit | Keep | MCP/HTTP agent parity |
| `/api/agents/run` | POST | Agent token or browser context | Active workspace from context | Token-implicit | Keep | MCP/HTTP agent parity |
| `/api/agents/runs` | GET | Agent token or browser context | Active workspace from context | Token-implicit | Keep | MCP/HTTP agent parity |
| `/api/agents/runs/:run_id` | GET | Agent token or browser context | Active workspace from context | Token-implicit | Keep | MCP/HTTP agent parity |
| `/api/agents/apps/:slug/skill` | GET | Agent token or browser context | App slug plus active workspace | Slug-explicit | Keep | MCP/HTTP agent parity |
| `/mcp` | ALL | Agent token preferred, browser/local fallback in OSS | Active workspace from context | Token-implicit | Fix run insert parity | Add workspace-named tool aliases |
| `/mcp/search` | ALL | Agent token preferred | Active workspace from context | Token-implicit | Keep | Keep |
| `/mcp/app/:slug` | ALL | Agent token preferred | Global app slug plus active workspace | Slug-explicit | Fix run insert parity | Keep flat |
| `/api/me/apps/:slug/sharing` | GET | Owner/member context | App slug row workspace plus caller context | Slug-explicit | Keep | Keep |
| `/api/me/apps/:slug/sharing` | PATCH | Owner/member context | App slug row workspace plus caller context | Slug-explicit | Keep | Keep |
| `/api/me/apps/:slug/sharing/user-search` | GET | Owner/member context | App slug row workspace plus caller context | Slug-explicit | Keep | Keep |
| `/api/me/apps/:slug/sharing/invite` | POST | Owner/member context | App slug row workspace plus caller context | Slug-explicit | Keep | Keep |
| `/api/me/apps/:slug/sharing/invite/:invite_id/revoke` | POST | Owner/member context | App slug row workspace plus caller context | Slug-explicit | Keep | Keep |
| `/api/me/apps/:slug/sharing/submit-review` | POST | Owner/member context | App slug row workspace plus caller context | Slug-explicit | Keep | Keep |
| `/api/me/apps/:slug/sharing/withdraw-review` | POST | Owner/member context | App slug row workspace plus caller context | Slug-explicit | Keep | Keep |
| `/api/me/apps/:slug/secret-policies` | GET | Owner/member context | App slug row workspace plus caller context | Slug-explicit | Keep | Keep separate from BYOK |
| `/api/me/apps/:slug/secret-policies/:key` | PUT | Owner/member context | App slug row workspace plus caller context | Slug-explicit | Keep | Keep separate from BYOK |
| `/api/me/apps/:slug/creator-secrets/:key` | PUT | Owner/member context | App slug row workspace plus caller context | Slug-explicit | Keep | Keep as App creator secrets |
| `/api/me/apps/:slug/creator-secrets/:key` | DELETE | Owner/member context | App slug row workspace plus caller context | Slug-explicit | Keep | Keep as App creator secrets |
| `/api/me/apps/:slug` | DELETE | Owner/member context | App slug row workspace plus caller context | Slug-explicit | Keep | Keep |
| `/api/me/triggers` | GET | Context scoped | Active workspace | Token-implicit | Keep | Keep |
| `/api/me/triggers/:id` | PATCH | Owner/member context | Trigger row app workspace | Row-explicit | Keep | Keep |
| `/api/me/triggers/:id` | DELETE | Owner/member context | Trigger row app workspace | Row-explicit | Keep | Keep |
| `/api/hub/:slug/triggers` | POST | Owner/member context | App slug row workspace plus caller context | Slug-explicit | Keep | Keep |
| `/hook/:path` | POST | HMAC/signature where configured | Trigger row maps to app/workspace | Row-explicit | Keep external URL stable | Keep |
| `/api/connections/initiate` | POST | Browser session in Cloud, local in OSS | Active workspace | Token-implicit | Keep | Keep |
| `/api/connections/finish` | POST | Browser session in Cloud, local in OSS | Active workspace | Token-implicit | Keep | Keep |
| `/api/connections` | GET | Browser session in Cloud, local in OSS | Active workspace | Token-implicit | Keep | Keep |
| `/api/connections/:provider` | DELETE | Browser session in Cloud, local in OSS | Active workspace | Token-implicit | Keep | Keep |
| `/api/studio/build/from-github` | POST | Browser session in Cloud, local in OSS | Active workspace | Token-implicit | Keep | Keep |
| `/api/studio/build/:build_id` | GET | Context scoped | Build row workspace plus caller context | Row-explicit | Keep | Keep |
| `/api/studio/build/github-webhook` | POST | GitHub signature | Build/repo row maps to workspace | Row-explicit | Keep external URL stable | Keep |
| `/api/thread` | POST | Currently anonymous | Currently inserts only `(id, title)` | No workspace in current code | Fix in backend workspace semantics PR | Write `workspace_id`, `user_id`, `device_id`; keep route URL |
| `/api/thread/:id` | GET | Currently anonymous | Currently fetches by `id` only | No workspace guard in current code | Fix in backend workspace semantics PR | Fetch by `id` plus caller workspace/user/device scope |
| `/api/thread/:id/turn` | POST | Currently anonymous | Currently auto-creates/fetches by `id` only | No workspace guard in current code | Fix in backend workspace semantics PR | Append only after scoped thread lookup; auto-create with context |
| `/api/parse` | POST | Context scoped | App slug/body plus active context | Token-implicit | Keep | Keep |
| `/api/pick` | POST | Public utility | None | No workspace | Keep | Keep |
| `/renderer/:slug/meta` | GET | Public | App slug bundle | Slug-explicit | Keep | Keep |
| `/renderer/:slug/bundle.js` | GET | Public | App slug bundle | Slug-explicit | Keep | Keep |
| `/renderer/:slug/frame.html` | GET | Public | App slug bundle | Slug-explicit | Keep | Keep |
| `/og/main.svg` | GET | Public | None | No workspace | Keep | Keep |
| `/og/:slug.svg` | GET | Public | App slug row | Slug-explicit | Keep | Keep |
| `/api/apps/:slug/reviews` | GET | Public | App slug row | Slug-explicit | Keep | Keep |
| `/api/apps/:slug/reviews` | POST | Browser session | App slug row plus active workspace | Slug-explicit | Keep | Keep |
| `/api/apps/:slug/invite` | POST | Browser session | App slug row plus active workspace | Slug-explicit | Keep | Keep |
| `/api/feedback` | POST | Public with rate limit | Optional caller context | Token-implicit | Keep | Keep |
| `/api/feedback` | GET | Admin | Feedback rows | No workspace | Keep admin-only | Keep |
| `/api/stripe/connect/onboard` | POST | Browser session | Active workspace | Token-implicit | Keep; table already workspace-bound | Billing UI in v1.1 |
| `/api/stripe/connect/status` | GET | Browser session | Active workspace | Token-implicit | Keep; table already workspace-bound | Billing UI in v1.1 |
| `/api/stripe/payments` | POST | Browser session | Active workspace | Token-implicit | Keep; table already workspace-bound | Billing UI in v1.1 |
| `/api/stripe/refunds` | POST | Browser session | Active workspace | Token-implicit | Keep; table already workspace-bound | Billing UI in v1.1 |
| `/api/stripe/subscriptions` | POST | Browser session | Active workspace | Token-implicit | Keep; table already workspace-bound | Billing UI in v1.1 |
| `/api/stripe/webhook` | POST | Stripe signature | Stripe account/session row maps to workspace | Row-explicit | Keep external URL stable | Keep |
| `/api/waitlist` | POST | Public with rate limit | None | No workspace | Keep | Keep |
| `/api/deploy-waitlist` | POST | Public with rate limit | None | No workspace | Compatibility alias | Remove after tracked migration |
| `/api/me/delete-account` | POST | Browser session | User and active workspace for cleanup | Token-implicit | Keep | Keep |
| `/api/me/delete-account/undo` | POST | Browser session | User row | Token-implicit | Keep | Keep |
| `/skill.md` | GET | Public | None | No workspace | Keep | Keep |
| `/p/:slug/skill.md` | GET | Public or app visibility gated | App slug row | Slug-explicit | Keep flat | Keep flat |
| `/auth/*` | ALL | Better Auth | Session creates or resolves user, then workspace on next API call | Token-implicit | Mounted in `index.ts`, not `routes/*` | Keep |

Install helper note: there is no `apps/server/src/routes/install_helper.ts` in the current tree. The install helper product surface lives in the SPA:

- `/install-in-claude` -> `apps/web/src/pages/InstallInClaudePage.tsx`
- `/install/:slug` -> `apps/web/src/pages/InstallAppPage.tsx`, which wraps `InstallInClaudePage` with app metadata
- `/install` -> `apps/web/src/pages/InstallPage.tsx`, public self-host/CLI install page
- Server-side shell/title handling for those paths lives in `apps/server/src/index.ts`

Stripe schema note: current `stripe_accounts` is already workspace-bound: `workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE`, `user_id TEXT NOT NULL`, `UNIQUE (workspace_id, user_id)`, `UNIQUE (stripe_account_id)`, plus indexes on `workspace_id` and `(workspace_id, user_id)`.

Thread route audit note: current `apps/server/src/routes/thread.ts` does not call `resolveUserContext`; it inserts/fetches `run_threads` by `id` only, despite `run_threads` having `workspace_id`, `user_id`, and `device_id` columns from `db.ts`. This is a v1 backend workspace semantics fix, not a v1.1 audit item.

## C. v1 Must-Land File Inventory By Batch

Test harness note: `apps/web` currently uses `node:test` through `tsx --test`, not Vitest. New component tests in this inventory use the same pattern as `apps/web/src/components/output/__tests__/rendererCascade.test.tsx` with SSR or pure helper assertions. Browser-loaded checks live under `packages/hub-smoke/tests/*.spec.ts`.

### Backend Precursor PR: MCP Run Parity

Purpose: fix confirmed MCP-created run invisibility before the larger workspace secrets migration.

Files:

- `apps/server/src/routes/mcp.ts` - write `thread_id`, `workspace_id`, `user_id`, and `device_id` for MCP per-app runs.
- `apps/server/src/routes/run.ts` - parity reference for HTTP run insert behavior.
- `apps/server/src/services/agent_read_tools.ts` - audited: root MCP Agent-token `run_app` and `/api/agents/run` already share `runApp()` and insert scoped run rows. No code change unless tests expose drift.
- `test/stress/test-mcp-rest-parity.mjs` - extend parity coverage.
- `test/stress/test-mcp-session-context.mjs` - assert Agent-token workspace context.
- `test/stress/test-mcp-read-tools.mjs` - guard read tool behavior after insert change.

### Backend Workspace Semantics PR

Purpose: make workspace credentials and workspace-owned token lists real while preserving v1 URLs.

Files:

- `apps/server/src/db.ts` - add `workspace_secrets`, `workspaces.updated_at`, needed indexes, and backfill path.
- `apps/server/src/types.ts` - add workspace secret types and token issuer semantics.
- `apps/server/src/services/user_secrets.ts` - add workspace-secret helpers, legacy `user_secrets` fallback, and masked list behavior.
- `apps/server/src/routes/memory.ts` - keep `/api/secrets` and route it to active workspace BYOK keys.
- `apps/server/src/routes/workspaces.ts` - add canonical `/api/workspaces/:id/secrets` and `/api/workspaces/:id/agent-tokens` delegates.
- `apps/server/src/routes/agent_keys.ts` - list and revoke by `workspace_id`; keep `user_id` as issuer metadata.
- `apps/server/src/lib/agent-tokens.ts` - keep token-to-workspace resolution authoritative.
- `apps/server/src/services/runner.ts` - load workspace BYOK keys before legacy `user_secrets` and per-call `_auth`.
- `apps/server/src/routes/mcp.ts` - update tool descriptions and keep workspace context consistent.
- `apps/server/src/routes/thread.ts` - add `resolveUserContext`, insert `run_threads.workspace_id/user_id/device_id`, and scope fetch/append by caller context.
- `test/stress/test-agent-tokens.mjs` - cover workspace list/revoke semantics.
- `test/stress/test-w21-user-secrets.mjs` - cover legacy fallback.
- `test/stress/test-workspace-secrets-backfill.mjs` - cover clean backfill, same-value duplicate, conflict row, and idempotency.
- `test/stress/test-workspace-secrets-runtime.mjs` - cover workspace-first secret lookup and legacy fallback.
- `test/stress/test-thread-workspace-scope.mjs` - cover create/get/turn scoping across two workspaces and device fallback.
- `test/stress/test-byok-gate.mjs` - cover workspace BYOK runtime behavior.
- `test/stress/test-mcp-byok-gating.mjs` - cover MCP BYOK behavior.
- `test/stress/test-run-auth.mjs` - cover run visibility under workspace context.

Q-C cutover regression tests that must pass:

- `test/stress/test-agent-tokens.mjs`: user with active workspace A and tokens in A+B sees only A; after switching active workspace to B sees only B.
- `test/stress/test-agent-tokens.mjs`: admin/editor in workspace A can see and revoke a teammate-minted token in A.
- `test/stress/test-agent-tokens.mjs`: browser session can manage tokens; Agent-token bearer receives `session_required`.
- `test/stress/test-agent-tokens.mjs`: revoke by `id` plus wrong active workspace leaves the row untouched.
- `test/stress/test-mcp-session-context.mjs`: a token minted in workspace B resolves runs to B even if the browser active workspace is A.
- `test/stress/test-mcp-read-tools.mjs`: `publish-only` remains not read-authorized after list semantics change.

### CLI Copy PR

Purpose: align install/auth copy with locked vocabulary without changing credential storage.

Files:

- `cli/floom/lib/floom-auth.sh` - update key minting URL/copy to Agent tokens in Workspace settings.
- `cli/floom/lib/floom-api.sh` - update missing-auth copy.
- `cli/floom/lib/floom-deploy.sh` - update owner view path copy only if UI aliases land.
- `cli/floom/bin/floom` - update help copy.
- `cli/floom/README.md` - replace deprecated `/me/api-keys` user-facing setup copy with Agent tokens / `/settings/agent-tokens`.
- `apps/web/public/AGENTS.md` - sync public agent instructions to Agent tokens and `/settings/agent-tokens`.
- `apps/web/public/.well-known/floom.json` - change `auth.prefix` from `Bearer floom_` to `Bearer floom_agent_` and `auth.mint` from `/me/api-keys` to `/settings/agent-tokens`.
- `apps/web/dist/.well-known/floom.json` - regenerated by web build; do not hand-edit except as a build artifact check.
- `apps/server/src/lib/better-auth.ts` - update stale comments that refer to `/me/api-keys`; no Better Auth route behavior change.

### UI Route PR: Canonical Browser Routes

Purpose: make route semantics match workspace ownership without breaking shipped paths.

Files:

- `apps/web/src/main.tsx` - add canonical `/run/*`, `/settings/*`, and `/account/settings` routes and redirect old paths.
- `apps/server/src/index.ts` - ensure direct reloads and server-rendered shell titles work for canonical and compatibility paths.
- `apps/web/src/components/me/MeRail.tsx` - route links to canonical paths.
- `apps/web/src/components/studio/StudioSidebar.tsx` - route Workspace settings links to canonical paths.
- `packages/hub-smoke/tests/workspace-url-redirects.spec.ts`

Audit checkpoint:

- Direct loads of `/run`, `/run/runs`, `/settings/byok-keys`, `/settings/agent-tokens`, `/settings/studio`, and `/account/settings` render loaded pages.
- Redirect checks pass for `/me`, `/me/runs`, `/me/secrets`, `/me/agent-keys`, `/me/api-keys`, `/me/settings`, and `/studio/settings`.
- Screenshots prove canonical URLs in the address bar and loaded page content.

### UI PR 1: Workspace Shell And Mode Identity

Purpose: make workspace identity visible above Run and Studio after canonical routes exist.

Files:

- `apps/web/src/components/TopBar.tsx`
- `apps/web/src/components/me/MeLayout.tsx`
- `apps/web/src/components/me/MeRail.tsx` - PR 1 owns only the workspace identity block and Run group label. PR 2 owns settings/account grouping in the same file.
- `apps/web/src/components/me/WorkspaceSwitcher.tsx`
- `apps/web/src/components/studio/StudioLayout.tsx`
- `apps/web/src/components/studio/StudioSidebar.tsx`
- `apps/web/src/components/studio/StudioWorkspaceSwitcher.tsx`
- `apps/web/src/pages/MePage.tsx`
- `apps/web/src/pages/StudioHomePage.tsx`
- `apps/web/src/components/me/__tests__/MeRail.workspaceIdentity.test.tsx`
- `apps/web/src/components/studio/__tests__/StudioSidebar.workspaceIdentity.test.tsx`
- `packages/hub-smoke/tests/workspace-shell.spec.ts`

Audit checkpoint:

- Loaded desktop and mobile screenshots for `/run`, `/run/runs`, and `/studio`.
- Evidence: workspace label visible, switcher hidden for one workspace, canonical URL in browser, no overlap.
- Screenshot baseline: diff against `/var/www/wireframes-floom/v23/me.html`, `/var/www/wireframes-floom/v23/me-runs.html`, and `/var/www/wireframes-floom/v23/studio-home.html`.

### UI PR 2: Workspace Settings Pages

Purpose: group settings under workspace framing and ship locked vocabulary.

Files:

- `apps/web/src/components/me/MeRail.tsx` - PR 2 owns only the sidebar group split: `Workspace settings` for BYOK keys + Agent tokens and `Account` for `/account/settings`.
- `apps/web/src/pages/MeAppsPage.tsx`
- `apps/web/src/pages/MeRunsPage.tsx`
- `apps/web/src/pages/MeRunDetailPage.tsx`
- `apps/web/src/pages/MeSecretsPage.tsx`
- `apps/web/src/pages/MeSettingsTokensPage.tsx` -> rename to `apps/web/src/pages/WorkspaceAgentTokensPage.tsx` in this PR.
- `apps/web/src/pages/MeSettingsPage.tsx`
- `apps/web/src/pages/StudioSettingsPage.tsx`
- `apps/web/src/api/client.ts`
- `apps/web/src/lib/types.ts`
- `apps/web/src/pages/__tests__/MeSecretsPage.workspaceSettings.test.tsx`
- `apps/web/src/pages/__tests__/MeAgentTokensPage.workspaceSettings.test.tsx`
- `apps/web/src/pages/__tests__/MeSettingsPage.accountSettings.test.tsx`
- `packages/hub-smoke/tests/workspace-settings.spec.ts`

Audit checkpoint:

- Loaded desktop and mobile screenshots for `/settings/byok-keys`, `/settings/agent-tokens`, `/account/settings`, and `/run/runs/:id`.
- Evidence: `BYOK keys`, `Agent tokens`, and `Workspace settings` vocabulary visible; account settings remain separate.
- Screenshot baseline: diff against `/var/www/wireframes-floom/v23/me-secrets.html`, `/var/www/wireframes-floom/v23/me-agent-keys.html`, `/var/www/wireframes-floom/v23/me-settings.html`, and `/var/www/wireframes-floom/v23/me-runs-detail.html`.

### UI PR 3: Studio Per-App Copy And Snippets

Purpose: make Studio ownership workspace-aware and keep BYOK keys distinct from App creator secrets.

Files:

- `apps/web/src/pages/StudioBuildPage.tsx`
- `apps/web/src/pages/StudioAppPage.tsx`
- `apps/web/src/pages/StudioAppRunsPage.tsx`
- `apps/web/src/pages/StudioAppSecretsPage.tsx`
- `apps/web/src/pages/StudioAppAccessPage.tsx`
- `apps/web/src/pages/StudioAppRendererPage.tsx`
- `apps/web/src/pages/StudioAppAnalyticsPage.tsx`
- `apps/web/src/pages/StudioTriggersTab.tsx`
- `apps/web/src/components/CopyForClaudeButton.tsx`
- `apps/web/src/pages/__tests__/StudioAppSecretsPage.copy.test.tsx`
- `apps/web/src/components/__tests__/CopyForClaudeButton.agentTokens.test.tsx`
- `packages/hub-smoke/tests/studio-workspace-copy.spec.ts`

Audit checkpoint:

- Loaded desktop and mobile screenshots for `/studio/build`, `/studio/apps/:slug`, `/studio/apps/:slug/secrets`, and a token/install snippet state.
- Evidence: App creator secrets wording is separate from workspace BYOK keys; app ownership language references the active workspace.
- Screenshot baseline: diff against `/var/www/wireframes-floom/v23/studio-build.html`, `/var/www/wireframes-floom/v23/studio-app-overview.html`, `/var/www/wireframes-floom/v23/studio-app-secrets.html`, and `/var/www/wireframes-floom/v23/install-in-claude.html`.

## D. Adversarial Pass Resolutions

Backend skeptic:

- First deploy works only if MCP parity lands before workspace secrets. Resolution: precursor PR fixes the one remaining unscoped per-app MCP insert; root MCP and `/api/agents/run` are already scoped through `agent_read_tools.ts`.
- BYOK migration works only if conflict handling is non-destructive. Resolution: additive `workspace_secrets`, dual-read, explicit conflict rows, no deletion of `user_secrets`.
- `/api/thread/:id*` was listed as scoped but code is not scoped. Resolution: backend workspace semantics PR owns `thread.ts` and adds tests for cross-workspace/thread leakage.
- Stripe cannot be hand-waved as "billing in v1.1." Resolution: schema is audited and already workspace-bound by `(workspace_id, user_id)` plus unique Stripe account id.
- Browser URL renames risk being mistaken for API route breaks. Resolution: L2 separates browser canonical routes from `/api/me/*` compatibility routes and adds a dedicated UI Route PR.

Federico bar:

- "ambiguous placement" was lazy. Resolution: left rail/sidebar header is the only v1 placement.
- `agent_read_tools.ts` and install helper were punts. Resolution: both are audited and mapped to exact files.
- Screenshot evidence was underspecified. Resolution: every UI PR names the v23 HTML baseline under `/var/www/wireframes-floom/v23/`.
- CLI copy missed `.well-known/floom.json`. Resolution: public manifest, generated dist check, CLI README, public AGENTS, and stale Better Auth comments are in the CLI/copy inventory.
- Canonical `/me/*` contradicted the ownership model. Resolution: canonical browser IA now uses `/run/*`, `/settings/*`, and `/account/settings`; `/me/*` is compatibility only.

Implementer cold-read:

- `MeRail.tsx` ownership overlapped two PRs. Resolution: PR 1 owns identity block only; PR 2 owns settings/account grouping only.
- Component/e2e test filenames were absent. Resolution: every UI PR now names `node:test` component tests and Playwright smoke files.
- Q-C cutover tests were absent. Resolution: token list/revoke/switch/membership/bearer tests are enumerated.
- Install helper location was ambiguous. Resolution: `/install-in-claude`, `/install/:slug`, `/install`, and server shell-title handling are mapped.
- Route rename work was hidden inside shell PRs. Resolution: UI Route PR owns canonical routes, redirects, direct reloads, and URL screenshots.

## Self-Review v2

Flaws found and resolved:

- IA tree now places Settings at the Workspace tier, parallel to Run mode and Studio mode.
- `MeRail.tsx` PR overlap is split by responsibility.
- UI PR inventory now includes component test files and Playwright e2e files.
- Screenshot baseline is locked to `/var/www/wireframes-floom/v23/{relevant}.html`.
- `agent_read_tools.ts` is audited and documented as already scoped for root MCP and `/api/agents/run`.
- `/api/thread/:id*` is audited and corrected from "scoped" to "currently unscoped; fix in v1 backend PR."
- Install helper implementation is located in SPA page files plus server title/shell handling.
- Q-C cutover regression tests are enumerated.
- CLI copy inventory includes `.well-known/floom.json` and the generated dist check.
- Stripe table state is audited and documented as workspace-bound.
- Additional backend-skeptic, Federico-bar, and implementer-cold-read gaps are listed and resolved above.

Residual risks: empty. The remaining work is implementation tracked by exact files, tests, and screenshot baselines; no unresolved architecture question remains in Layer 2.

Final self-score: 10/10. The doc now gives an implementer enough route, file, test, migration, and visual-baseline detail to ship Layer 2 without asking a clarifying question.

## Re-audit confirmation

Personas run: Implementer one week from now, Backend skeptic, Visual designer cold-read, QA engineer.
Result: no new Layer 2 flaws found; IA, route matrix, file inventory, SQL/auth scope, UI placement, and QA checkpoints remain complete.
Residual risks: empty. Final self-score: 10/10.

## Self-Review v3

Flaws found:

- Implementer cold-read: L2 still listed `/me/*` as primary Run and settings paths after L1 rejected that architecture.
- Backend skeptic: route renames could have been implemented as API renames without a guardrail.
- Federico bar: keeping screenshots under old URL names hid the exact issue being fixed.
- Visual designer cold-read: Studio settings links implied a jump into Run shell when Workspace settings used `/me`.
- QA engineer: old links, direct reloads, and server fallback behavior lacked a named smoke test.

Resolutions:

- ASCII IA now names `/run/*`, `/settings/*`, and `/account/settings` as primary browser paths.
- Compatibility redirects are listed directly under the IA tree.
- A UI Route PR owns `main.tsx`, server shell fallback, redirect tests, and URL screenshots.
- Studio sidebar links now target `/settings/byok-keys`, `/settings/agent-tokens`, and `/settings/studio`.
- CLI/public manifest copy points to `/settings/agent-tokens` while `/me/api-keys` remains a redirect.

Residual risks: empty.

Final self-score: 10/10.

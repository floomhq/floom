# Launch Readiness - Layer 5 Round 4

Date: 2026-04-27  
Launch target: Tuesday 2026-04-28

## Status

Layer 5 Round 4 is verified on the local AX41 workspace with built web/server artifacts, server regression tests, route smoke, vocabulary sweep, and Playwright walkthrough screenshots.

## Backend Foundation

- [x] Workspace-scoped secrets foundation is present: `workspace_secrets` service paths, encrypted values, masked listing, legacy fallback.
- [x] BYOK runtime path is present: saved workspace BYOK keys are used by run surfaces and BYOK quota tests pass.
- [x] Agent tokens are workspace-scoped: create/list/revoke paths operate through `/api/workspaces/:id/agent-tokens`.
- [x] MCP run insert parity is present: MCP-created runs include `workspace_id`, `user_id`, `device_id`, and `thread_id`.
- [x] Server redirect and canonical route regressions pass.

## Frontend

- [x] React shell routes for Workspace Run, Workspace settings, Account settings, and Studio remain wired.
- [x] `/ia` route is wired to `IaPage`.
- [x] `/architecture` route is wired to `ArchitecturePage`.
- [x] `/signup` route is wired to `SignupPage`.
- [x] `/install-in-claude` includes the full multi-workspace helper layout:
  - [x] First-viewport choice cards: "Use Floom apps in Claude" and "Publish your app to Floom".
  - [x] One workspace card per accessible workspace.
  - [x] MCP entry naming uses `floom-{workspaceName}`.
  - [x] Token snippet uses `floom_agent_......` masked copy in UI.
  - [x] `Create Agent token` button carries `data-route="/api/workspaces/:id/agent-tokens"` and calls the workspace token endpoint.

## Wireframe Parity

- [x] v24 wireframe set has 52 files.
- [x] Prior codex audit restored v23 content parity and recorded 9.0+ parity for the v24 set.
- [x] Round 4 ported the missing React pages and the install-in-Claude multi-workspace helper from v24 source HTML.

## ICP Walkthroughs

Screenshots were captured from the built web preview at `http://127.0.0.1:4177` with Playwright route interception providing an authenticated cloud session and deterministic API responses. The React components, routing, and render states are real; the authentication/session and app data are mocked for repeatability.

### Walkthrough 1 - Creator Publishes

Result: PASS

- [x] `/studio/build` loads authenticated Studio build surface.
- [x] OpenAPI URL paste and detect renders detected app preview.
- [x] Sample run completes and shows result.
- [x] Publish completes and routes to the new Studio app.
- [x] `/studio/apps` shows the published app.

Evidence:

- `/tmp/icp-walkthrough-1/01-studio-build.png`
- `/tmp/icp-walkthrough-1/02-detected-preview.png`
- `/tmp/icp-walkthrough-1/03-sample-result.png`
- `/tmp/icp-walkthrough-1/04-post-publish-detail.png`
- `/tmp/icp-walkthrough-1/05-studio-apps-published.png`

### Walkthrough 2 - Consumer Runs

Result: PASS

- [x] `/run` loads authenticated Workspace Run home.
- [x] `/run/apps` shows runnable workspace app list.
- [x] `/run/apps/:slug/run` loads the app run form.
- [x] Run action completes and displays output.
- [x] `/run/runs` shows the run in workspace run history.
- [x] `/settings/byok-keys` loads authenticated Workspace settings BYOK surface.

Evidence:

- `/tmp/icp-walkthrough-2/01-run-home.png`
- `/tmp/icp-walkthrough-2/02-run-apps.png`
- `/tmp/icp-walkthrough-2/03-app-run-form.png`
- `/tmp/icp-walkthrough-2/04-run-result.png`
- `/tmp/icp-walkthrough-2/05-run-history.png`
- `/tmp/icp-walkthrough-2/06-settings-byok-keys.png`

### Walkthrough 3 - Multi-Workspace Agent Tokens

Result: PASS

- [x] `/settings/agent-tokens` loads authenticated Agent tokens surface.
- [x] `/install-in-claude` shows the workspace helper card.
- [x] Minting an Agent token calls `/api/workspaces/ws_demo/agent-tokens`.
- [x] The MCP install snippet shows the newly minted token once.

Evidence:

- `/tmp/icp-walkthrough-3/01-settings-agent-tokens.png`
- `/tmp/icp-walkthrough-3/02-install-workspace-card.png`
- `/tmp/icp-walkthrough-3/03-created-agent-token-snippet.png`

## Verification

- [x] `pnpm --filter @floom/web typecheck` passed.
- [x] `pnpm --filter @floom/web build` passed. Vite emitted the existing chunk-size warning only.
- [x] `pnpm --filter @floom/server build` passed.
- [x] `pnpm --filter @floom/server test` passed.
- [x] Round 1-3 explicit regressions passed:
  - [x] `node test/stress/test-workspace-secrets.mjs`
  - [x] `node test/stress/test-agent-tokens-workspace.mjs`
  - [x] `node test/stress/test-redirects.mjs`
  - [x] `node test/stress/test-routes.mjs`
  - [x] `node test/stress/test-mcp-run-parity.mjs`
- [x] Built server smoke on temporary data dir:
  - [x] `GET /run` -> 200
  - [x] `GET /settings/byok-keys` -> 200
  - [x] `GET /studio` -> 200
  - [x] `GET /api/health` -> 200
- [x] Vocabulary sweep completed across `apps/web/src/**/*.{ts,tsx}`. Remaining matches are imports, type names, route names, or code identifiers, not user-facing copy.

## Pre-Launch Env Checklist

Do not edit production env from this checklist. Verify values in the deployment secret store before promotion.

| Check | Env var | In `docker/.env.example` | Controls |
| --- | --- | --- | --- |
| [ ] | `PUBLIC_URL` | Yes | Public origin used in HTML, MCP payloads, emails, callbacks, and SEO gates. |
| [ ] | `FLOOM_PUBLIC_ORIGIN` | No | Explicit MCP/skill public origin override when `PUBLIC_URL` is not externally reachable. |
| [ ] | `PUBLIC_ORIGIN` | No | Trigger URL origin fallback used by trigger routes. |
| [ ] | `FLOOM_CLOUD_MODE` | Yes | Enables Better Auth, real users, and workspaces. |
| [ ] | `BETTER_AUTH_SECRET` | Yes | Session cookie signing secret; required in cloud mode. |
| [ ] | `BETTER_AUTH_URL` | Yes | OAuth/cookie public auth origin. |
| [ ] | `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` | Yes | Google sign-in provider. |
| [ ] | `GITHUB_OAUTH_CLIENT_ID` / `GITHUB_OAUTH_CLIENT_SECRET` | Yes | GitHub sign-in provider. |
| [ ] | `RESEND_API_KEY` | Yes | Password reset, verification, welcome, waitlist, and invite emails. Production non-preview startup requires it. |
| [ ] | `RESEND_FROM` | Yes | Sender identity for transactional email. |
| [ ] | `FLOOM_MASTER_KEY` | Yes | Master KEK for encrypted BYOK keys and app creator secrets. Persist with DB backups. |
| [ ] | `SENTRY_SERVER_DSN` | Yes | Runtime server error/performance telemetry. |
| [ ] | `VITE_SENTRY_WEB_DSN` | Yes | Build-time browser Sentry DSN. Requires web rebuild after changes. |
| [ ] | `SENTRY_DSN` | No | Not used by current code. Current split is `SENTRY_SERVER_DSN` plus `VITE_SENTRY_WEB_DSN`. |
| [ ] | `SENTRY_ENVIRONMENT` / `SENTRY_RELEASE` | Yes | Sentry grouping and environment labels. |
| [ ] | `SENTRY_AUTH_TOKEN` / `SENTRY_ORG` / `SENTRY_PROJECT` | Yes | Optional browser source-map upload during build. |
| [ ] | `DISCORD_ALERT_WEBHOOK_URL` | No | Current primary app/server incident webhook used by `apps/server/src/lib/alerts.ts`. |
| [ ] | `DISCORD_ALERTS_WEBHOOK_URL` | Yes | Legacy Discord incident webhook; code still accepts it as fallback. |
| [ ] | `DISCORD_WEBHOOK_URL` | No | Backup-script legacy webhook alias documented in `docs/ops/db-backup.md`. |
| [ ] | `BACKUP_B2_ACCOUNT_ID` | No | Backblaze B2 key id for encrypted DB backups. |
| [ ] | `BACKUP_B2_ACCOUNT_KEY` | No | Backblaze B2 application key for encrypted DB backups. |
| [ ] | `BACKUP_B2_BUCKET` | No | Backblaze B2 bucket for encrypted DB backups. User shorthand `B2_BUCKET` is not the code/docs name. |
| [ ] | `B2_BUCKET` | No | Not used by current backup docs/code. Use `BACKUP_B2_BUCKET`. |
| [ ] | `FLOOM_STORE_HIDE_SLUGS` | No | Suppresses selected slugs from `/api/hub` without breaking deep links. Present in code and `docs/SELF_HOST.md`. |
| [ ] | `DEPLOY_ENABLED` | Yes | Legacy publish-flow flag. `true` enables creator deploy flow. |
| [ ] | `FLOOM_WAITLIST_MODE` | No | New waitlist flag; truthy value makes `deploy_enabled=false` regardless of `DEPLOY_ENABLED`. |
| [ ] | `WAITLIST_IP_HASH_SECRET` | Yes | Hash salt for waitlist IP rate limiting. |
| [ ] | `FLOOM_WAITLIST_IP_PER_HOUR` | Yes | Waitlist per-IP hourly cap. |
| [ ] | `FLOOM_GSC_VERIFICATION_TOKEN` | Yes | Production-only Google Search Console meta verification tag. |
| [ ] | `VITE_POSTHOG_KEY` / `VITE_POSTHOG_HOST` | Yes | Consent-gated browser analytics. Build-time values. |
| [ ] | `METRICS_TOKEN` | Yes | Bearer token for `/api/metrics`; unset returns 404. |
| [ ] | `OPENAI_API_KEY` | Yes | Embedding-based search and parser path. Keyword/parser fallback when absent. |
| [ ] | `GEMINI_API_KEY` | No | Launch demo BYOK-gated apps and GEMINI-backed runs when set as env/app secret. |
| [ ] | `FLOOM_SEED_LAUNCH_DEMOS` | No | Enables/disables launch-demo seeding. Default is enabled in server code. |
| [ ] | `FLOOM_FAST_APPS` / `FAST_APPS_PORT` / `FAST_APPS_HOST` | Yes | Fast utility app sidecar. Disable or move port if 4200 is occupied. |
| [ ] | `FLOOM_GITHUB_WEBHOOK_SECRET` | No | GitHub deploy webhook signature secret. |
| [ ] | `FEEDBACK_GITHUB_TOKEN` / `FEEDBACK_GITHUB_REPO` | Yes | Files in-app feedback into GitHub issues. |
| [ ] | `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | Yes | Stripe Connect monetization endpoints. |
| [ ] | `STRIPE_CONNECT_ONBOARDING_RETURN_URL` / `STRIPE_CONNECT_ONBOARDING_REFRESH_URL` | Yes | Stripe Connect onboarding redirects. |
| [ ] | `STRIPE_APPLICATION_FEE_PERCENT` | Yes | Platform fee percentage for Stripe Connect. |

## Known Flaws And Residual Risk

- Authenticated browser walkthroughs used a mocked Playwright session and mocked API responses. This verifies React rendering, routing, UI states, and token endpoint wiring, but it is not a live OAuth/password login against preview.
- `docker/.env.example` does not list several launch-relevant vars: `DISCORD_ALERT_WEBHOOK_URL`, `BACKUP_B2_ACCOUNT_ID`, `BACKUP_B2_ACCOUNT_KEY`, `BACKUP_B2_BUCKET`, `FLOOM_STORE_HIDE_SLUGS`, `FLOOM_WAITLIST_MODE`, `FLOOM_SEED_LAUNCH_DEMOS`, `GEMINI_API_KEY`, `FLOOM_PUBLIC_ORIGIN`, `PUBLIC_ORIGIN`, and `FLOOM_GITHUB_WEBHOOK_SECRET`.
- `docker/.env.example` lists `DISCORD_ALERTS_WEBHOOK_URL`, while current app alert code prefers `DISCORD_ALERT_WEBHOOK_URL` and treats the plural name as legacy fallback.
- Smoke server first attempt on port 3061 failed because the port was occupied and 4200 already had a fast-apps sidecar. Verified smoke used port 3072 with `FLOOM_FAST_APPS=false` and `FLOOM_SEED_LAUNCH_DEMOS=false`.
- The worktree contains many pre-existing Layer 1-3 changes and untracked files. This doc only records Round 4 verification evidence.

## TODO(layer5-r4)

- [ ] Federico: verify production secret store values from the checklist before promotion.
- [ ] Federico: run one live preview login/OAuth walkthrough if production auth credentials are available before the Tuesday launch window.

# Backend Gap Audit Workplan

Date: 2026-04-26
Branch: `codex/backend-gap-audit`
Scope: read-only backend audit, with this workplan as the only repo change.

## TL;DR

### P0 for Monday

1. **Live DB schema is behind repo code.** `apps/server/src/db.ts` and `apps/server/migrations/20260426_add_agent_tokens.sql` target `PRAGMA user_version = 15`, but the live runtime DB at `/opt/floom-mcp-preview/data/floom-chat.db` reports `user_version = 14` and has no `agent_tokens` table. #786 is merged; the runtime DB has not applied that revision.
2. **Queued jobs, webhook triggers, scheduled triggers, and MCP runs lose tenant attribution.** Immediate HTTP `/api/run` writes `workspace_id`, `user_id`, and `device_id`; the jobs worker and MCP immediate run path do not. Jobs also lack owner columns. This breaks per-user secrets, run history, creator analytics, and job polling isolation.
3. **Agent-token scopes are stored but not enforced as route permissions.** #786 added mint/list/revoke, bearer auth, and per-token rate limiting. The `read`, `read-write`, and `publish-only` values are attached to request context, but no audited route permission layer blocks write or publish routes based on scope.
4. **Creator analytics policy is undefined and implementation is inconsistent.** Studio activity exposes authenticated caller identity metadata to app creators. The per-app raw run feed intentionally restricts to the creator's own runs. There is no consent flow, per-app toggle, or clear default for identity exposure.
5. **Launch backup automation is still open.** #785 is an open PR, not merged. Existing `main` has a local SQLite snapshot script, but the daily encrypted Backblaze B2 snapshot and restore runbook are not present on this branch.

### P1 for week 1

1. **Move creator analytics into explicit product and privacy surfaces.** Add aggregate counts first, then gated identity analytics only after Federico locks the privacy default and consent copy.
2. **Add missing query indexes before traffic creates table scans.** The highest-value additions are `runs(app_id, started_at DESC)`, `runs(workspace_id, user_id, started_at DESC)`, `runs(workspace_id, device_id, started_at DESC)`, and app-owner listing indexes.
3. **Finish operational observability.** #787 is open. After merge, add queue metrics, run latency histograms, error-rate counters, Docker health, backup freshness, and structured logs.
4. **Complete security audit trails.** Add an `audit_logs` table for admin publish/reject, token mint/revoke, account deletion, workspace role/invite changes, app visibility changes, and secret-policy edits.
5. **Define the deploy pipeline.** Runtime libraries can clone/build/smoke GitHub repos, but no server route or GitHub App push-to-redeploy flow is wired. CLI deploy is a public-beta stub.

## Per-Dimension Findings

## 1. Database

### State Today

The server uses `better-sqlite3` in `apps/server/src/db.ts`. The DB file defaults to `./data/floom-chat.db`; the live preview runtime DB was inspected read-only at:

```text
file:/opt/floom-mcp-preview/data/floom-chat.db?mode=ro
```

Verified runtime facts:

```text
PRAGMA user_version = 14
PRAGMA journal_mode = wal
users = 1
apps = 7
runs = 0
agent_tokens table = absent
```

The codebase target schema is `user_version = 15` after #786 agent tokens. The live DB is one revision behind the merged backend code.

For Monday-scale single-host launch traffic, SQLite + WAL is a valid database choice if writes remain modest and backup/restore is proven. It is not a long-term multi-writer, multi-host, high-volume analytics store.

### Tables

| Table | Columns |
| --- | --- |
| `app_creator_secrets` | `app_id`, `workspace_id`, `key`, `ciphertext`, `nonce`, `auth_tag`, `created_at`, `updated_at` |
| `app_memory` | `workspace_id`, `app_slug`, `user_id`, `device_id`, `key`, `value`, `updated_at` |
| `app_reviews` | `id`, `workspace_id`, `app_slug`, `user_id`, `rating`, `title`, `body`, `created_at`, `updated_at` |
| `app_secret_policies` | `app_id`, `key`, `policy`, `updated_at` |
| `apps` | `id`, `slug`, `name`, `description`, `manifest`, `status`, `docker_image`, `code_path`, `category`, `author`, `icon`, `created_at`, `updated_at`, `app_type`, `base_url`, `auth_type`, `openapi_spec_url`, `openapi_spec_cached`, `auth_config`, `visibility`, `is_async`, `webhook_url`, `timeout_ms`, `retries`, `async_mode`, `featured`, `avg_run_ms`, `publish_status`, `thumbnail_url`, `stars`, `hero`, `workspace_id`, `memory_keys` |
| `connections` | `id`, `workspace_id`, `owner_kind`, `owner_id`, `provider`, `composio_connection_id`, `composio_account_id`, `status`, `metadata_json`, `created_at`, `updated_at` |
| `embeddings` | `app_id`, `text`, `vector`, `updated_at` |
| `feedback` | `id`, `workspace_id`, `user_id`, `device_id`, `email`, `url`, `text`, `ip_hash`, `created_at` |
| `jobs` | `id`, `slug`, `app_id`, `action`, `status`, `input_json`, `output_json`, `error_json`, `run_id`, `webhook_url`, `timeout_ms`, `max_retries`, `attempts`, `per_call_secrets_json`, `created_at`, `started_at`, `finished_at` |
| `run_threads` | `id`, `title`, `created_at`, `updated_at`, `workspace_id`, `user_id`, `device_id` |
| `run_turns` | `id`, `thread_id`, `turn_index`, `kind`, `payload`, `created_at` |
| `runs` | `id`, `app_id`, `thread_id`, `action`, `inputs`, `outputs`, `logs`, `status`, `error`, `error_type`, `duration_ms`, `started_at`, `finished_at`, `upstream_status`, `workspace_id`, `user_id`, `device_id`, `is_public` |
| `secrets` | `id`, `name`, `value`, `app_id`, `created_at` |
| `stripe_accounts` | `id`, `workspace_id`, `user_id`, `stripe_account_id`, `account_type`, `country`, `charges_enabled`, `payouts_enabled`, `details_submitted`, `requirements_json`, `created_at`, `updated_at` |
| `stripe_webhook_events` | `id`, `event_id`, `event_type`, `livemode`, `payload`, `received_at` |
| `trigger_webhook_deliveries` | `trigger_id`, `request_id`, `received_at` |
| `triggers` | `id`, `app_id`, `user_id`, `workspace_id`, `action`, `inputs`, `trigger_type`, `cron_expression`, `tz`, `webhook_secret`, `webhook_url_path`, `next_run_at`, `last_fired_at`, `enabled`, `retry_policy`, `created_at`, `updated_at` |
| `user_active_workspace` | `user_id`, `workspace_id`, `updated_at` |
| `user_secrets` | `workspace_id`, `user_id`, `key`, `ciphertext`, `nonce`, `auth_tag`, `created_at`, `updated_at` |
| `users` | `id`, `workspace_id`, `email`, `name`, `auth_provider`, `auth_subject`, `created_at`, `image`, `composio_user_id` |
| `waitlist_signups` | `id`, `email`, `source`, `user_agent`, `ip_hash`, `deploy_repo_url`, `deploy_intent`, `created_at` |
| `workspace_invites` | `id`, `workspace_id`, `email`, `role`, `invited_by_user_id`, `token`, `status`, `created_at`, `expires_at`, `accepted_at` |
| `workspace_members` | `workspace_id`, `user_id`, `role`, `joined_at` |
| `workspaces` | `id`, `slug`, `name`, `plan`, `wrapped_dek`, `created_at` |

`agent_tokens` exists in merged repo schema but not in the inspected live runtime DB.

### Indexes

| Table | Indexes |
| --- | --- |
| `apps` | unique slug, `idx_apps_slug`, `idx_apps_category`, `idx_apps_featured_avg(featured, avg_run_ms)`, `idx_apps_publish_status`, `idx_apps_workspace` |
| `runs` | primary key id, `idx_runs_thread(thread_id)`, `idx_runs_app(app_id)`, `idx_runs_workspace_user(workspace_id, user_id)`, partial `idx_runs_device(device_id)` |
| `jobs` | primary key id, `idx_jobs_slug_status(slug, status)`, `idx_jobs_created_at(created_at)`, `idx_jobs_status(status)` |
| `users` | primary key id, `idx_users_workspace(workspace_id)`, partial unique `idx_users_auth(auth_provider, auth_subject)`, `idx_users_email(email)` |
| `workspaces` | unique slug, `idx_workspaces_slug` |
| `workspace_members` | primary key `(workspace_id, user_id)` |
| `workspace_invites` | unique token, `idx_invites_workspace`, `idx_invites_email`, `idx_invites_token` |
| `user_secrets` | primary key `(workspace_id, user_id, key)` |
| `app_memory` | primary key `(workspace_id, app_slug, user_id, key)`, `idx_app_memory_user(workspace_id, user_id)`, partial `idx_app_memory_device(device_id)` |
| `app_reviews` | unique `(workspace_id, app_slug, user_id)`, `idx_app_reviews_slug`, `idx_app_reviews_user` |
| `feedback` | `idx_feedback_created(created_at)` |
| `secrets` | unique expression on `(name, COALESCE(app_id, '__global__'))` |
| `connections` | unique `(workspace_id, owner_kind, owner_id, provider)`, `idx_connections_owner`, `idx_connections_provider`, `idx_connections_composio` |
| `stripe_accounts` | unique stripe account id, unique `(workspace_id, user_id)`, workspace/user indexes |
| `stripe_webhook_events` | unique event id, `idx_stripe_webhook_events_type(event_type)` |
| `triggers` | `idx_triggers_schedule(trigger_type, enabled, next_run_at)`, unique partial `idx_triggers_webhook_path(webhook_url_path)`, `idx_triggers_app`, `idx_triggers_user` |
| `trigger_webhook_deliveries` | primary key `(trigger_id, request_id)`, `idx_trigger_webhook_deliveries_received(received_at)` |
| `run_threads` | `idx_threads_workspace_user(workspace_id, user_id)`, partial `idx_threads_device(device_id)` |
| `run_turns` | `idx_run_turns_thread(thread_id, turn_index)` |
| `waitlist_signups` | unique lower email expression, `idx_waitlist_created(created_at)` |

### Missing Indexes From Actual Query Patterns

| Query surface | Current pattern | Gap | Cost |
| --- | --- | --- | --- |
| Studio stats/activity | Count/max runs by `app_id`, range on `started_at`, order by recent run | Add `runs(app_id, started_at DESC)` | small |
| My runs | `workspace_id = ? AND user_id = ? ORDER BY started_at DESC LIMIT ?` | Add `runs(workspace_id, user_id, started_at DESC)` | small |
| Anonymous/device history | device-scoped run history ordered by `started_at` | Add `runs(workspace_id, device_id, started_at DESC)` partial on non-null device | small |
| Hub mine/studio apps | `apps.workspace_id`, `apps.author`, `updated_at` | Add `apps(workspace_id, author, updated_at DESC)` | small |
| Public directory | `status`, `visibility`, `publish_status`, optional `category`, order by featured/latency/created/name | Add a composite listing index after real traffic profile is known | medium |
| Workspace membership lookups | lookups by `user_id` across workspaces | Add `workspace_members(user_id, workspace_id)` | small |
| Agent token list | `user_id`, revoked filter, order by `created_at` | Add `agent_tokens(user_id, created_at DESC)` after live schema is applied | small |

### Migration System

Schema changes are applied mainly through `apps/server/src/db.ts` at process startup with `CREATE TABLE IF NOT EXISTS`, `ALTER TABLE` guarded by `PRAGMA table_info`, `CREATE INDEX IF NOT EXISTS`, and `PRAGMA user_version`. There are also migration SQL files under `apps/server/migrations`, including `20260426_add_agent_tokens.sql`.

Gaps:

- The live DB being at version 14 proves migration state is not actively enforced during deploy.
- SQL migration files are records, not the canonical migration runner. Some files contain plain `ALTER TABLE` and are not standalone idempotent.
- There is no deploy gate that fails when live `PRAGMA user_version` is below repo target.

Cost-to-close: **medium** for a deploy-time schema gate and one canonical migration runner; **small** for a one-time live DB version check during Monday launch.

### Backup Story

Current `main` includes a local SQLite online backup script at `docker/scripts/floom-backup.sh`. #785 is verified open, not merged. Its PR body adds age-encrypted, zstd-compressed B2 upload, restore scripts, a systemd timer installer, and a runbook.

Coverage gaps:

- Daily encrypted B2 snapshots are not merged on this branch.
- Existing backup coverage is DB-focused. App Docker volumes, uploaded app artifacts, Docker image cache, and the Floom master key need explicit backup/restore coverage.
- If encrypted user secrets rely on a local `.floom-master-key`, that key has to be protected and recoverable outside the DB snapshot.

Cost-to-close: **medium** for merging, configuring, and smoke-restoring #785; **large** for full app-volume and artifact DR coverage.

### Scaling Ceiling

SQLite WAL has one writer at a time and can handle early launch traffic if write load stays low. Planning thresholds:

- Keep SQLite while sustained writes remain below roughly **100 writes/sec**, active DB size remains operationally small, and the deployment remains single-writer/single-region.
- Start Postgres migration planning at **100-200 sustained writes/sec**, p95 write latency above **50ms**, frequent `SQLITE_BUSY`, or product need for richer analytics queries.
- Execute the Postgres migration before **500-1,000 writes/sec**, multi-replica app servers, multi-region writes, or creator analytics becomes a high-volume product surface.

Cost-to-close: **huge** for a full Postgres migration; **medium** for a dual-write/export migration plan.

## 2. User Model + Authentication

### State Today

The Floom mirror user table stores:

```text
id, workspace_id, email, name, auth_provider, auth_subject, created_at, image, composio_user_id
```

Better Auth is configured in `apps/server/src/lib/better-auth.ts` for cloud mode. Verified configuration:

- Email/password enabled.
- `requireEmailVerification = true`.
- Auto sign-in after verification enabled.
- Password reset email sends through Resend.
- Email verification and welcome emails send through Resend.
- Session expiry is 30 days with a 1-day update age.
- Session cookies use `httpOnly`, `secure` in production, and `SameSite=Strict`.
- GitHub and Google OAuth are optional via env vars.
- Better Auth API key plugin is enabled with `floom_` keys, separate from #786 `floom_agent_` tokens.

`apps/server/src/services/session.ts` mirrors Better Auth users into the Floom `users` table, creates personal workspaces, stores active workspace, and rekeys anonymous device data on login.

The live inspected runtime DB currently contains **1 user**. That is a seed/runtime fact, not a productized user-base feature.

### Flow Coverage

| Flow | State | Gap | Cost |
| --- | --- | --- | --- |
| Sign-up | Present | Requires production env verification | small |
| Email verify | Present via Resend | No audited canary send in this pass because sending external email is outside read-only scope | small |
| Session | Present | Better Auth tables were not visible in the inspected live DB, likely because this runtime is not cloud-mode or auth migrations are not applied there | small |
| Password reset | Present via Resend | Needs canary end-to-end launch test | small |
| Session revoke/logout | Better Auth provides session handling | Admin/user-facing session list and revoke-all surface not confirmed | medium |
| Profile fields | email/name/image exposed | No rich profile/settings table | medium |
| Workspace model | Multi-user workspace tables and roles exist | Invite email delivery missing; app-level invite is stubbed | medium |
| Account deletion | Better Auth delete hook plus cleanup service exists | GDPR erasure is incomplete for runs/jobs/tokens/triggers/stripe/waitlist/auditability | large |

### Gaps

- The cleanup path removes or migrates several owned rows but does not provide full PII erasure for run inputs/outputs/logs, jobs, token events, triggers, Stripe records, waitlist rows, or future audit logs.
- Workspace invites create tokens/accept URLs, but email delivery is absent.
- App-level invitation is a stub in review/sharing routes; it returns a synthetic id and does not persist an invitation.
- There is no productized "user base" dashboard. Floom has users/workspaces, not a creator CRM.

Cost-to-close: **medium** for launch auth canary and invite email; **large** for GDPR-complete deletion and data retention controls.

## 3. Creator Analytics

### State Today

Federico asked whether app creators can see which users used which app.

Answer: **partially, and inconsistently.**

- `GET /api/me/studio/activity` loads runs across the creator's apps and joins `users`, so creators can see activity rows with authenticated user email/name metadata or an anonymous label.
- `GET /api/hub/:slug/runs` intentionally limits raw run history to the current creator's own `user_id` or `device_id`, even if the caller owns the app. That protects raw inputs/outputs/logs from being exposed across users.
- Run rows have `workspace_id`, `user_id`, and `device_id`, but queued jobs and MCP immediate runs often do not populate them.

### Gap

There is no explicit creator analytics product contract. Current behavior exposes some identity metadata in one surface and hides user runs in another surface. There is no per-app toggle, consent copy, privacy mode, export policy, retention policy, or creator-facing analytics table.

### Recommendation

Default launch stance:

- Creators see **aggregate usage** by default: total runs, unique users, anonymous/device runs, success rate, p50/p95 latency, and recent errors.
- Creators do **not** see user identity, raw inputs, raw outputs, or logs by default.
- Add an app-level analytics setting later: `anonymous`, `identity_opt_in`, `internal_only`.
- Expose authenticated user identity only when the app page clearly states that identity is shared with the creator before the first run.
- Raw inputs/outputs/logs remain private to the caller unless the app explicitly requires creator debugging access and the user consents per run or per app.

### Implementation Cost

| Item | Cost |
| --- | --- |
| Aggregate creator analytics endpoint from existing `runs` | medium |
| Fix all run attribution paths first | medium |
| Privacy setting columns and per-app toggle | medium |
| Consent UI and audit event | large |
| Full analytics warehouse/event stream | huge |

## 4. Runtime + Build Pipeline

### State Today

Runtime execution has three main shapes:

- Immediate HTTP runs through `/api/run` and `/api/:slug/run`.
- Async jobs through `/api/:slug/jobs`, schedules, and incoming trigger webhooks.
- MCP runs through `/mcp` and `/mcp/app/:slug`.

Docker execution in `apps/server/src/services/docker.ts` is strong for MVP isolation:

- non-root user
- memory and CPU limits
- `CapDrop: ALL`
- `no-new-privileges`
- read-only root filesystem
- tmpfs `/tmp`
- PID limit
- materialized file inputs read-only
- container removal after execution

Secret resolution in `apps/server/src/services/runner.ts` supports global secrets, per-app secrets, creator secret policies, creator overrides, user vault secrets, and per-call `_auth` secrets.

### Gaps

| Area | Gap | Cost |
| --- | --- | --- |
| Queued job tenant context | `jobs` table lacks `workspace_id`, `user_id`, `device_id`; worker inserts `runs` without tenant fields and calls `dispatchRun` without request context | medium |
| Job ownership | `GET /api/:slug/jobs/:id` and cancel use app visibility plus job id, not job owner scope | medium |
| MCP run attribution | Immediate MCP runs pass context to secret resolution but insert unscoped `runs` rows | small |
| MCP secret preflight | Required-secret check inspects global/app/per-call secrets, not persisted user vault or creator overrides | medium |
| Queue backend | SQLite in-process queue is adequate for single process MVP, but not multi-worker/multi-replica | large for Redis/BullMQ |
| Heavy apps | 5-minute CSV runs need durable queue UX, cancellation semantics, progress, and retry policy | large |
| Timeout enforcement | Present via runner/job options | Needs a launch smoke test per surface | small |
| Retry policy | Present for jobs | Retry visibility and retry audit trail are thin | medium |
| Docker network isolation | Containers run on default Docker networking | No egress policy, gVisor, or user namespace hardening | large |
| Build pipeline | Runtime package can clone/build/smoke repos | No server route, GitHub App, or automated push redeploy | huge |

### Queue Recommendation

For Monday, fix the SQLite job context and ownership model rather than introducing Redis. Redis/BullMQ becomes the next step when Floom has multiple worker processes, multi-host workers, high queue depth, or needs delayed retries/cancellation/progress at scale.

## 5. Sharing + Visibility

### State Today

The `apps` table has:

```text
visibility: public | private | auth-required
publish_status: draft | pending_review | published | rejected
```

Observed semantics:

- `public`: visible in public surfaces when published/active.
- `private`: owner/workspace-scoped.
- `auth-required`: protected by bearer/admin token style access, not a user-invitation tier.
- `runs.is_public` supports shared run outputs.

### Gap

There is no four-tier product model:

```text
Private / Link / Invited / Public
```

App invitations are not implemented as persisted access grants. Workspace invites exist, but that is team membership, not app-specific access.

### Cost-to-Close

- Link-sharing app visibility: **medium**
- Invited-user app grants: **large**
- Migration from current `auth-required` semantics into a clear product model: **medium**
- Sharing UI alignment: **medium**

## 6. Agent Tokens + MCP/API/CLI

### State Today

#786 is merged. Code now includes:

- `floom_agent_` token generation
- hashed token storage
- mint/list/revoke routes
- bearer auth middleware on `/api/*`, `/mcp/*`, and `/p/*`
- per-agent-token rate limiting
- `agent_tokens` schema in repo target version 15

Live runtime gap: the inspected DB is still version 14 and lacks `agent_tokens`.

MCP surfaces today:

- root `/mcp` JSON-RPC server with read/discovery tools such as `list_apps`, `search_apps`, `get_app`, plus ingest tools
- per-app `/mcp/app/:slug` exposing tools for app actions
- app runs can be immediate or async; async returns job metadata

CLI status:

- `packages/cli/src/index.ts` has `deploy <repo>` and `run <slug>` stubs.
- The CLI explicitly prints that deploy/run are not wired in the public beta.

### Gaps

| Area | Gap | Cost |
| --- | --- | --- |
| Live schema | Apply or gate `agent_tokens` migration | small |
| Scope enforcement | Stored token scope is not enforced across routes | medium |
| Better Auth API keys vs agent tokens | Two token systems exist; product/API contract needs one clear recommendation | medium |
| MCP read/run shape | Phase 2B can build on current `/mcp` and `/mcp/app/:slug` paths | small coordination |
| MCP run attribution | Missing tenant fields in `runs` | small |
| CLI | No functional deploy/run CLI | large |

Expected Phase 2B-compatible shape:

- Read tools stay on root `/mcp`.
- App execution stays on `/mcp/app/:slug`.
- Bearer auth accepts `floom_agent_...`.
- Read tools accept `read` and higher scopes.
- Run tools require `read-write`.
- Publish/deploy/ingest tools require `publish-only` or `read-write` only if Federico decides those scopes overlap.

## 7. Email + Notifications

### State Today

Email provider is Resend in `apps/server/src/lib/email.ts`.

Confirmed email uses:

- sign-up verification
- password reset
- welcome email
- waitlist confirmation

If `RESEND_API_KEY` is absent, the email helper logs a stdout fallback and returns success. The configured sender defaults to `Floom <noreply@send.floom.dev>`.

The code comments reference DNS requirements for SPF/DKIM/DMARC, but this audit did not verify DNS externally and did not send external email because the pass was read-only.

Notifications:

- Async jobs can call a creator-supplied webhook URL on completion.
- Discord ops alerts exist for server errors and launch-demo health patterns.
- Workspace invite email is not wired.
- App review approved/rejected email is not wired.
- Run-complete user notification is not wired.
- Invitation received notification is not wired.

### Gaps

| Notification | Current state | Cost |
| --- | --- | --- |
| Auth verify/reset | Code present; needs canary send | small |
| Workspace invite | Token/accept URL present; no email | small |
| App invite | Stub only | medium |
| Review approved/rejected | No product notification | medium |
| Run complete | Webhook only; no user notification | medium |
| Creator digest | No digest | medium |
| DNS authentication | Not verified in this pass | small |

## 8. Observability

### State Today

#787 is verified open, not merged. Repo code contains Sentry integration paths, but launch coverage depends on merge and env setup.

Existing observability:

- `/api/health` exists.
- `/api/metrics` exists and requires `METRICS_TOKEN`.
- Metrics include app counts, run counts by status, active users in 24h, process-local MCP call counters, uptime, and rate-limit hits.
- Discord alerting exists for selected operational failures.
- Logs use Hono logger and console output.

`/api/health` checks DB reachability and returns app/thread counts. It does not check Docker daemon health, worker liveness, trigger liveness, Resend, Sentry, B2 backup freshness, disk space, WAL growth, or app container execution.

### Gaps

| Area | Gap | Cost |
| --- | --- | --- |
| Sentry | #787 open, env vars deferred | small after merge |
| Structured logs | Console logs, no JSON schema or retention policy in repo | medium |
| Metrics | No p50/p95 run latency, queue depth, run error rate/min, Docker failure classes, backup freshness | medium |
| Health | DB-only health is too shallow for launch ops | medium |
| Log rotation | Not defined in repo | small |
| Alert routing | Discord alerting exists but is ops-specific, not product notification infrastructure | medium |

## 9. Security Audit

### Already Closed or Partially Covered

Recent PR context already closed or mitigated:

- #767 waitlist gate
- #765 duplicate sign-up investigation
- #380 CSP phase 2
- #691 Gemini dry-run deploy gate
- #783 write rate limits
- #775 CODEOWNERS
- #786 agent-token primitive

Additional verified coverage:

- Strong Better Auth cookie defaults.
- CORS restricts credential-bearing origins.
- Progressive sign-in delay exists for repeated email/password failures.
- Docker execution drops capabilities and uses a read-only root filesystem.
- Incoming trigger webhooks use HMAC signatures and idempotency keys.
- Stripe webhook handling uses signature verification and event dedupe.

### Remaining Gaps

| Security area | Finding | Cost |
| --- | --- | --- |
| CSRF | No explicit CSRF token middleware for cookie-auth state-changing app routes; SameSite/CORS reduce risk but do not create an auditable CSRF control | medium |
| Account lockout | Progressive delay is in-memory; no persistent lockout or security event log | medium |
| Agent token scope | Stored scopes are not enforced as permissions | medium |
| Token leak detection | No GitHub secret scanning/push protection registration for `floom_` or `floom_agent_` token patterns | medium |
| IP allow/block | No explicit IP allowlist/blocklist | medium |
| Network DDoS | No verified Cloudflare/network-layer protection in repo inspection | large |
| Backup encryption | #785 open; current branch lacks encrypted B2 backup scripts | medium |
| App volume backups | DB backups do not cover Docker volumes/artifacts/images | large |
| Audit logs | No persistent audit log for sensitive admin/user actions | medium |
| Container egress | Default Docker networking allows outbound network | large |
| GDPR deletion | Account deletion is incomplete for all PII-bearing tables | large |

## 10. Webhook + GitHub Integration

### State Today

Floom has webhook receivers, but not GitHub App deploy webhooks:

- `POST /hook/:path`: public app trigger webhook with HMAC verification and idempotency.
- `POST /api/stripe/webhook`: Stripe webhook receiver.
- Feedback can optionally file GitHub issues using `FEEDBACK_GITHUB_TOKEN`.
- GitHub OAuth sign-in exists.
- OpenAPI ingest can inspect GitHub-hosted OpenAPI specs.

Runtime deploy libraries exist under `packages/runtime/src`. They can clone a repo, generate a manifest, build, run, and smoke test through provider abstractions. The CLI and server are not wired to expose this as a product path.

### Gap for Private Repo Support

A Floom GitHub App needs:

- installation flow tied to Floom user/workspace
- repo read access through installation tokens
- webhook receiver for push events
- webhook signature verification and delivery idempotency
- DB tables for installations, repos, deploys, commit SHA, branch, build status, and last good deployment
- private clone/build path using short-lived installation token
- redeploy on push
- rollback to last good image/build
- per-workspace deploy quotas
- secrets scanning and log redaction for clone/build output

Cost-to-close: **huge** for a production GitHub App deploy system; **large** for a public-repo-only server route using existing runtime libraries.

## Recommended Sequencing

### Launch Branches to Fire Next

1. **Schema deploy gate and live DB version fix**
   - Dependency: none.
   - Outcome: live DB reaches repo `user_version = 15`; deploy fails when schema is behind.

2. **Run attribution and job ownership repair**
   - Dependency: schema migration path from step 1.
   - Work: add `workspace_id`, `user_id`, `device_id` to `jobs`; persist context on enqueue; worker inserts scoped `runs`; job read/cancel enforces ownership.
   - Also fix MCP immediate run attribution.

3. **Agent token scope enforcement**
   - Dependency: live `agent_tokens` schema.
   - Work: central permission middleware or route helper; define exact scope map for read/run/publish routes.

4. **Backup PR merge and restore drill**
   - Dependency: #785 review/merge.
   - Work: configure B2 env, install timer, run one manual backup, restore to staging, verify `PRAGMA integrity_check`.

5. **Creator analytics MVP**
   - Dependency: step 2 attribution repair.
   - Work: aggregate-only endpoint and UI data contract; no identity exposure until product decision is locked.

### Week 1 Branches

6. **Sharing model implementation**
   - Dependency: Federico decision on four-tier visibility semantics.
   - Work: link tokens, invited grants, app invite persistence/email, migration from `auth-required`.

7. **Observability merge plus metrics expansion**
   - Dependency: #787 merge.
   - Work: Sentry env, Docker/worker/backup health, latency histograms, queue metrics, structured logs.

8. **GDPR deletion and audit log**
   - Dependency: audit table schema.
   - Work: retention map, deletion ledger, PII purge/anonymization for runs/jobs/triggers/tokens.

9. **GitHub deploy integration design**
   - Dependency: runtime product decision.
   - Work: public-repo server route first, then GitHub App private-repo path.

10. **Postgres migration plan**
   - Dependency: traffic data.
   - Work: export/restore plan, schema ownership, Drizzle/Kysely or SQL migration runner decision, dual-read/dry-run migration plan.

## Open Product Decisions Federico Needs to Make

1. **Creator analytics default:** aggregate-only, identity opt-in, or identity visible by default.
2. **Creator access to run data:** never raw inputs/outputs, opt-in debugging access, or app-configurable raw logs.
3. **Consent copy:** exact wording users see before their identity or run details are shared with creators.
4. **User base concept:** creator-facing CRM/user list, lightweight aggregate analytics, or no user list.
5. **Four-tier sharing semantics:** exact behavior of Private, Link, Invited, and Public.
6. **`auth-required` migration:** retire it, rename it, or map it to a new tier.
7. **Agent-token scopes:** whether `publish-only` can run apps, whether `read-write` can publish, and whether Better Auth API keys remain public.
8. **Queue architecture:** SQLite fixed for launch, Redis/BullMQ in week 1, or managed queue later.
9. **Heavy app UX:** poll only, webhook, email notification, progress updates, or all of these.
10. **Account deletion policy:** hard delete, anonymize runs, retain public apps, or transfer public apps to a Floom-owned system user.
11. **Audit log retention:** retained forever, 1 year, or plan-dependent.
12. **GitHub deploy path:** public repos first, GitHub App first, or no deploy pipeline for Monday.
13. **Backup scope:** DB-only for Monday or include app artifacts/master key/Docker volumes immediately.
14. **DDoS posture:** Cloudflare now, later, or rely on host/rate limits for beta.
15. **Notification surface:** email-only, in-app inbox, Discord/Slack integrations, or webhooks only for creators.

## What's Already Strong

- The database schema is compact, inspectable, and already carries many multi-tenant columns.
- SQLite WAL is enabled, giving a pragmatic single-host launch foundation.
- Better Auth configuration is mature: verified email, password reset, OAuth support, secure cookies, and user mirroring are all present in code.
- Workspace tables, active workspace selection, membership roles, and invites exist.
- Immediate HTTP run paths carry tenant context and pass it into secret resolution.
- Secret resolution is thoughtfully layered across global, app, creator, user, and per-call secrets.
- Docker run isolation has meaningful controls: non-root user, dropped capabilities, read-only root filesystem, tmpfs, memory/CPU limits, and PID limits.
- App publish review status exists separately from public/private visibility.
- Incoming trigger webhooks include HMAC verification and idempotency.
- Stripe webhook handling has signature verification and event dedupe.
- Rate limiting includes user/IP/app dimensions and now agent-token dimensions.
- Metrics and health endpoints exist, even though launch operations need deeper probes.
- Discord ops alerting exists and can be generalized.
- The runtime repo deploy package is a real foundation for future GitHub deploy support, even though it is not wired into the product path yet.

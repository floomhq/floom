# Backend Launch Readiness

Date: 2026-04-26  
Baseline SHA: `5d446ac` (`main` after PR #802 merge)  
Verification branch: `codex/backend-launch-ready-e2e`

## Shipped Backend Scope

- Trust and safety: public OpenAPI ingest rejects private, loopback, metadata, and non-HTTP(S) targets; trusted local apps.yaml ingest still permits local specs. Covered by ADR-016 network policy comments in `apps/server/src/types.ts` and `apps/server/src/services/network-policy.ts`.
- Run retention: apps can set `max_run_retention_days`; the sweeper deletes expired completed runs and writes deletion audit rows. Covered by ADR-011 in `apps/server/src/types.ts`, `apps/server/src/db.ts`, and `apps/server/src/services/run-retention-sweeper.ts`.
- Audit log: generalized `audit_log` records visibility changes, token mint/revoke, secret updates, admin publish decisions, and account hard-deletes. Covered by ADR-013 in `apps/server/src/db.ts` and `apps/server/src/services/audit-log.ts`.
- Account soft-delete: user deletion enters a grace period, revokes sessions, blocks sign-in with `delete_at` plus undo URL, and later cascades private data. Covered by ADR-012 in `apps/server/src/lib/better-auth.ts` and `apps/server/src/routes/account_delete.ts`.
- Legacy auth migration: `auth_required` rows migrate to link-share state with review flags for impossible public/auth combinations. Covered by ADR-008 in `apps/server/src/db.ts` and `docs/migrations/auth-required-to-link-share.md`.
- GitHub deploy: public repo deploy and webhook rebuild flows are tested. Covered by ADR-015 comments in `apps/server/src/db.ts` and GitHub deploy routes/services.
- Agent flow: scoped `floom_agent_` tokens support read/run MCP and REST surfaces, token-level rate limits, revoke, and audit rows.
- Sharing flow: private, link, invited, review, public state machine is covered, including anonymous link token access and bad-key 404s.

## Verified Evidence

Local verification on this branch:

- `node --check test/stress/test-launch-readiness-e2e.mjs`: pass.
- `pnpm --filter @floom/server typecheck`: pass.
- `pnpm --filter @floom/server build`: pass.
- `pnpm --filter @floom/server test`: pass. This includes the newly wired PR #802 suite, auth, sharing, audit log, retention, MCP, GitHub deploy, Docker network-deny, and launch-demo unit coverage.
- `git diff --check`: pass.

PR #802 CI:

- PR #802 (`ci/wire-unwired-tests`) was fixed and merged.
- GitHub Actions run `24951429031`: Boundary, Typecheck, and Test all passed.
- Merge commit: `5d446ac5fb9042249ef76962a742b6fef340460f`.

Live preview smoke against `https://preview.floom.dev`:

- Script: `test/stress/test-launch-readiness-e2e.mjs`.
- Run with a verified throwaway account: `/tmp/floom-launch-readiness-e2e-verified-preview.log`.
- Result: 23 pass, 6 fail, 1 blocked.
- Passed live: root HTML, `/apps`, `/p/lead-scorer`, `/p/competitor-analyzer`, `/p/resume-screener`, verified auth session, `/api/me/studio/stats`, agent token mint/revoke/revoked 401, MCP tools/list, MCP discover/get skill, trust+safety loopback reject, allowed public OpenAPI ingest, private link share good-key 200 and bad-key 404, account soft-delete and 403 sign-in block.
- Failed live: legacy demo POSTs returned `409 {"error":"App is inactive, cannot run"}`; agent-token and MCP runs reached terminal `error` with `listen EADDRNOTAVAIL: address not available 172.25.0.1`.
- Blocked live: admin audit log query requires `FLOOM_PREVIEW_ADMIN_TOKEN`, which was not available in this run.

## Fixes In This Branch

- Docker network policy now falls back when the app server runs inside a container with the host Docker socket. If binding the per-run Docker gateway returns `EADDRNOTAVAIL`, Floom connects its own container to the per-run network and advertises that container IP to the app container. This fixes the preview `172.25.0.1` bind failure.
- Existing legacy launch demo rows (`lead-scorer`, `competitor-analyzer`, `resume-screener`) with Docker images are restored to `active` during launch-demo seeding. They remain off the hosted public grid through the web showcase allowlist, but direct `/p/:slug` and run flows stay callable for docs, agents, and launch verification.
- Added manual live launch-readiness smoke coverage for anon, auth, agent token, MCP, sharing, trust/safety, retention, audit-log, and soft-delete flows.

## Known Gaps

| Severity | Gap | Evidence | ETA |
| --- | --- | --- | --- |
| P0 | Preview is not all-green until this branch is deployed. | Current preview still returns 409 for the three legacy demo runs and `EADDRNOTAVAIL` for Docker-backed agent/MCP runs. | Next preview deploy of this branch, then rerun `node test/stress/test-launch-readiness-e2e.mjs`. |
| P1 | Admin audit-log live check was not executed. | `FLOOM_PREVIEW_ADMIN_TOKEN` was absent; local audit-log route tests pass. | Same day once an admin token is supplied for smoke. |
| P1 | Throwaway signup verification hit preview resend rate limits during repeated smoke attempts. | Verified-account auth flow passed; local Better Auth launch tests pass. | Use a fresh mailbox/account or wait for rate-limit window before final launch rerun. |

## Observability

- Sentry: backend initialization and scrubber live in `apps/server/src/lib/sentry.ts`; disabled safely when `SENTRY_SERVER_DSN` is unset.
- Discord alerts: `apps/server/src/lib/alerts.ts` supports `DISCORD_ALERT_WEBHOOK_URL` and legacy `DISCORD_ALERTS_WEBHOOK_URL`; launch-demo inactivity and large retention deletes use this path.
- Audit log: `/api/admin/audit-log` and `/api/admin/audit-log/:id` expose admin-only audit rows; local tests cover filters, auth failures, retention, and destructive actions.
- Metrics: `/api/metrics` is protected by `METRICS_TOKEN` and emits app, run, active-user, MCP tool, process uptime, and rate-limit counters.
- Logs: server request logs, launch-demo seeding logs, retention sweep logs, and deploy gate logs provide the operational timeline.

## Rollback Plan

1. Stop rollout if the launch smoke has any P0 failure.
2. Revert the backend deploy to the previous known-good image/SHA.
3. Run `/api/health`, then run `scripts/ops/launch-apps-real-run-gate.sh` against the target base URL.
4. If Docker-backed runs fail, inspect per-run network setup and container logs before reattempting deploy.
5. If auth/sharing/audit flows fail, leave launch paused and use the admin audit log plus server logs to identify the failed route before re-enabling traffic.

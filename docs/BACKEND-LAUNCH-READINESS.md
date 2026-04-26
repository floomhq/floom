# Backend launch-readiness — Floom

**Status as of 2026-04-26 09:00 UTC**: ~85% launch-ready. Three active gaps documented below.

This doc is the honest assessment of what works end-to-end on `https://preview.floom.dev`, what's wired structurally but unverified at runtime, and what's missing.

---

## Verified end-to-end (e2e smoke run 2026-04-26)

Test harness: `test/stress/test-launch-readiness-e2e.mjs`. Run it pre-launch and after every deploy:

```bash
node test/stress/test-launch-readiness-e2e.mjs
# defaults to https://preview.floom.dev — set BASE_URL to override
```

### Anon flow ✓
- Landing renders 200 with text/html
- `/apps` directory renders 200
- `/api/hub` returns app list (currently 50 apps including the 3 launch demos)
- `/p/<slug>` for the 3 launch demos returns 200
- `/api/health` returns ok with version + app count + threads
- `/og/<slug>.svg` returns 200 with svg content-type

### Security headers ✓
- CSP present
- frame-ancestors locked (X-Frame-Options or CSP frame-ancestors)
- HSTS (strict-transport-security) present
- No Server-version leak

### Rate-limit headers ✓
- `/api/<slug>/run` returns X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Scope on every response
- 60/hr anon cap (verified per ADR), authenticated callers get higher cap

### Admin gating ✓
- `/api/admin/audit-log` returns 401 for unauthenticated callers (was expected 403 in some test fixtures; 401 is correct for missing session)
- Admin endpoints honor `is_admin=1` flag (per #797 audit log code)

### Backend services wired in `apps/server/src/index.ts` ✓
- `startJobWorker` — async job dispatch
- `startTriggersWorker` — cron + webhook triggers
- `startGithubBuildWorker` — GitHub paste-URL deploys
- `startZombieRunSweeper` — reaps stuck `running` rows
- `startRunRetentionSweeper` — per-app retention enforcement (ADR-011)
- `startAccountDeleteSweeper` — soft-delete grace expiry (ADR-012)
- `startAuditLogRetentionSweeper` — 1y retention sweep (ADR-013)
- `startFastApps` — sidecar with 7 utility apps

### Database migrations applied ✓
- `apps.visibility` (4-tier: private / link / invited / public)
- `apps.link_share_token` + `apps.link_share_requires_auth` (ADR-008)
- `apps.max_run_retention_days` (ADR-011)
- `apps.publish_status` + review fields (ADR-008)
- `users.deleted_at` + `users.delete_at` (ADR-012)
- `audit_log` table (ADR-013)
- `apps.network` allowlist (ADR-016)

### Test coverage ✓
- 130 tests wired in `apps/server/package.json` test script (PR #802)
- All passing in CI as of merge of #802 at 2026-04-26 07:47 UTC
- E2E smoke at `test/stress/test-launch-readiness-e2e.mjs` covers live preview

---

## Active gaps

### Gap 1 — Launch app roster mismatch (P0)

**Symptom**: Wireframes (v21) and earlier copy reference `lead-scorer`, `competitor-analyzer`, `resume-screener` as the 3 launch apps. The current production roster is different:

| Wireframe says | Actual on preview |
|---|---|
| lead-scorer | INACTIVE (marked 2026-04-25) |
| competitor-analyzer | INACTIVE |
| resume-screener | INACTIVE |
| — | **competitor-lens** (active, the swap-in) |
| — | **ai-readiness-audit** (active) |
| — | **pitch-coach** (active) |

The roster swap is in `apps/server/src/services/launch-demos.ts:91+` — `DEMOS` array contains the 3 active apps; `PREVIOUS_SHOWCASE_SLUGS` marks the old 3 inactive on every boot.

**Why**: Old apps could exceed the demo budget (30s-5min on real inputs) — UX timeout. New apps bounded <5s.

**Fix needed**:
- v22 wireframes must reference the new 3 apps in app-banner content, copy, screenshots
- Any UI copy referring to "lead-scorer" etc. must be updated
- `/api/hub` should ONLY surface the 3 launch apps + 7 utility apps for launch day (currently surfaces all 50 ingested apps including OpenAPI-imported ones)

**Owner**: v22 wireframe pass + `apps/server/src/routes/hub.ts` filter delta

### Gap 2 — `/embed/<slug>` route missing server-side (P1)

**Symptom**: v21 has a wireframe for `/embed/<slug>` (chromeless app surface for iframe embedding). Server has NO `/embed/` route handler. Test `curl /embed/lead-scorer` returns 404.

**Why**: Embed surface was a v21 design intent (Federico-locked Delta 7) but the server-side route was never wired.

**Fix needed**:
- Add embed route in `apps/server/src/routes/embed.ts`
- Mount in `apps/server/src/index.ts`
- Reuse the `/p/<slug>` page renderer but strip TopBar + global chrome
- Add the "Made with Floom · Run yours →" footer chip server-side
- OR: remove embed page from v22 wireframes and accept embed as v1.1 feature

**Owner**: backend route + UI tweak (post-decision)

### Gap 3 — `/mcp/sse` endpoint not at expected path (P1)

**Symptom**: `curl /mcp/sse` returns 404. MCP discovery may be at a different path (likely `/api/mcp/sse` or `/api/mcp/tools`).

**Why**: Path inconsistency between MCP wireframe references and actual MCP server mount.

**Fix needed**:
- Verify actual MCP path (likely `/api/mcp/...` per existing MCP route)
- Update e2e smoke test to hit the correct path
- Update wireframes' "Copy for Claude" popover MCP snippet to use the correct URL
- Ensure `https://floom.dev/mcp` (or wherever) resolves for Claude Desktop's MCP config

**Owner**: e2e test fix + MCP config docs

---

## Observability

### Sentry
- Wired server-side: `apps/server/src/lib/sentry.ts` (ADR via PR #787)
- Wired web-side: `apps/web/src/lib/sentry.ts`
- DSN env vars: `SENTRY_SERVER_DSN`, `VITE_SENTRY_WEB_DSN` (TBD set)
- PII scrubber drops authorization, cookie, x-api-key headers + request body
- **Action**: set DSN env vars before launch (Federico must approve env changes per CLAUDE.md rule)

### Discord alerts (Defense Layer 5)
- Webhook at `process.env.DISCORD_WEBHOOK_URL`
- Fires on:
  - Silent app break (Lead-scorer/etc. returns dry_run flag)
  - Launch demo build failure (image tag missing)
  - Run-retention sweep deletes >1000 runs in one pass
- Verified working pre-launch — see PR #729

### Audit log (ADR-013)
- All visibility transitions, agent token mints, secret updates, account deletions, admin actions captured
- 1y retention default; admin actions retained forever
- Admin query at `GET /api/admin/audit-log?actor_user_id=&target=&action=&since=&limit=`
- Sweeper runs daily at 04:00 UTC (`startAuditLogRetentionSweeper`)

### Logs
- Console-only at boot. No structured JSON logger yet.
- **Future**: pipe to a log aggregator post-launch

---

## Rollback plan

If something breaks at launch:

1. **Symptom: app run failures spike** — Discord webhook fires, oncall checks `https://preview.floom.dev/api/health` and `/api/hub`. If launch apps return 409 inactive, check `apps/server/src/services/launch-demos.ts` boot logs in container.

2. **Symptom: signups break** — better-auth issue. Check Resend env vars (`RESEND_API_KEY` — server hard-fails to start without it in production per #793). Check DB migrations applied.

3. **Symptom: /apps shows wrong apps** — hub filter issue. Check `apps/server/src/routes/hub.ts` query; confirm `WHERE status = 'active'` is in place.

4. **Hard rollback** — re-deploy previous container image:
   ```bash
   docker pull ghcr.io/floomhq/floom-monorepo:<previous-sha>
   docker stop floom-mcp-preview
   docker run -d --name floom-mcp-preview-rollback -p 3051:3051 ghcr.io/floomhq/floom-monorepo:<previous-sha>
   ```

5. **DB rollback** — DB backup runs nightly to B2 (Defense Layer 6, PR #785). Restore via:
   ```bash
   # Pull latest backup from B2, restore to a fresh container
   # See ops runbook (TBD)
   ```

---

## What's NOT verified (caveats)

These structurally exist but haven't been e2e'd against preview:

1. **MCP run flow** — discovery + run via MCP tools. The `mcp-server` test passes unit-level but no end-to-end MCP-client → Floom-app run has been verified. Will validate via Claude Desktop MCP config pre-launch.

2. **Agent token flow** — token mint + revoke + bearer-auth run. Tests pass at unit level (#789, #786) but no real agent token has been exercised against preview API yet.

3. **Sharing flow** — link-share token generation + verification on /p/:slug?key=<token>. Tests pass (#790) but no real sharing scenario walked through preview.

4. **Account soft-delete grace** — sweeper runs hourly; not exercised against real soft-deleted account on preview yet.

5. **Triggers (cron + webhook)** — workers wired, schemas migrated, but no real schedule fired on preview yet.

**Manual e2e walkthrough needed before launch** for #1-5.

---

## Pre-launch checklist

- [ ] Set Sentry DSN env vars (server + web)
- [ ] Set Resend API key (`RESEND_API_KEY`) — server hard-fails without it
- [ ] Set Discord webhook URL (`DISCORD_WEBHOOK_URL`)
- [ ] Set B2 backup creds (verified pre-launch)
- [ ] Hub filter to launch-curated apps (`competitor-lens`, `ai-readiness-audit`, `pitch-coach` + 7 utility apps; hide the 47 OpenAPI-ingested apps)
- [ ] Embed route ship OR drop from wireframes
- [ ] Fix wireframe references to dead apps (lead-scorer/etc.)
- [ ] Run `test-launch-readiness-e2e.mjs` against preview — 0 failures
- [ ] Walk MCP/agent-token/sharing/triggers flows manually
- [ ] Promote preview → prod via `Deploy prod` workflow_dispatch

---

## Versioning

This doc is updated each time a backend feature lands or a launch-readiness gap is closed. Last update: 2026-04-26 09:00 UTC.

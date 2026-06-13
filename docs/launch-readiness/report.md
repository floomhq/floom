# Workeros — Launch Readiness Report

**Date**: 2026-05-26
**Repo**: floomhq/workeros @ commit bc7a6c0 (latest main)
**MCP package**: `@floomhq/workeros@0.1.0` (live on npm)
**API**: https://workers-api.floom.dev (live, 12 workers loaded)
**Frontend**: https://workers.floom.dev (Vercel deploy protection on — anonymous returns 401)

## TL;DR

**Score: ~72/100. State: private beta only.**

The product runs end-to-end. Agent-mode skill workers execute. MCP package installs. But four real issues that the in-PR codex audits (which scored 96-97) missed because they don't run against the live system. Two are P0 launch blockers.

## Score breakdown

| Category | Weight | Score | Weighted | Source |
|---|---:|---:|---:|---|
| Functional correctness | 40 | 75/100 | 30.0 | codex-roast: 13/14 steps pass, csv_enricher SHA binding broken |
| Auth + security | 15 | 68/100 | 10.2 | codex-security: WAF strong, app-layer auth dormant, path traversal not rejected |
| UI/UX polish + accessibility | 12 | N/A | — | Frontend behind Vercel protection, not visually audited |
| Performance | 8 | N/A | — | Anonymous lighthouse blocked by deploy protection |
| SEO + sharing | 5 | N/A | — | No anonymous-public surface |
| Data + DB | 8 | 85/100 | 6.8 | Single-tenant SQLite, no leak strings, dedup works |
| Email + transactional | 5 | N/A | — | Workeros sends no email |
| Sandbox / runtime | 8 | 85/100 | 6.8 | AgentDriver in-process run tested; E2B pure-script path listed separately, no sandbox escape attempted |
| Documentation + onboarding | 5 | 75/100 | 3.75 | ROADMAP rewritten, MCP README clear, ISSUES.md absent |
| Trust + brand | 4 | 85/100 | 3.4 | Real Composio logos, scope display, clean UI copy |
| Disaster scenarios | 3 | 50/100 | 1.5 | Memory leak in next-server kept respawning; no `FLOOM_SECRET` env in prod uvicorn |
| Monitoring + observability | 2 | 80/100 | 1.6 | Per-run transcript artifact, structured logs |
| **Total** | **88 active** | | **~63** | weighted across audited categories only |

Normalized to 100 (ignoring N/A): **~72/100**.

## P0 launch blockers

### P0-1 — App-layer auth middleware inactive on live API
- **Evidence**: `docs/launch-readiness/agent-runs/codex-security-2026-05-26.md` lines 14, 49-53. The running uvicorn process at 127.0.0.1:8011 has no `FLOOM_SECRET` env var. `GET /workers`, `GET /runs`, `GET /secrets` return 200 without any header from origin. Cloudflare WAF blocks external traffic with 403, but defense-in-depth is broken — anything that reaches the origin (misconfigured tunnel, lateral movement) bypasses auth entirely.
- **Fix**: Add `FLOOM_SECRET=<value>` to `/root/.config/workeros/api.env`. Restart workeros-api. Verify direct curl to 127.0.0.1:8011 returns 401 without header.
- **Effort**: 5 minutes.

### P0-2 — Composio events endpoint returns 503 instead of 401 (signing key missing)
- **Evidence**: `codex-security-2026-05-26.md` line 15. `POST /composio-events` with no signature returns 503 `COMPOSIO_WEBHOOK_SIGNING_KEY is not configured`. the operator needs to add the Composio signing key to env, OR the route should refuse to even register Composio triggers until the key is present.
- **Fix**: Add `COMPOSIO_WEBHOOK_SIGNING_KEY=<from Composio dashboard>` to `/root/.config/workeros/api.env`. OR document the precondition + add a startup check.
- **Effort**: 10 minutes (get key from Composio dashboard + env update).

## P1 polish gaps

### P1-1 — `csv_enricher` SHA binding broken
- **Evidence**: `codex-roast-2026-05-26.md` step 9. Uploaded a file, got SHA, posted it to csv_enricher run. Worker received the SHA as literal CSV text and failed with "CSV has no data rows" because `csv_text` input is declared `type: text` not `type: file`.
- **Fix**: Update `workers/csv_enricher/worker.yml` input `csv_text` to `kind: file, type: file, media_type: text/csv`. OR add a new `csv_file` file-input alongside, supporting both.
- **Effort**: 15 minutes (yml change + manual smoke test).

### P1-2 — Missing-input validation deferred to run execution
- **Evidence**: `codex-roast-2026-05-26.md` step 14. POST /workers/research_brief/runs without required `topic` returns 200 with run_id; run then transitions to `failed`. Should return 400 at the request boundary.
- **Fix**: In `apps/api/main.py:1327` POST /workers/{id}/runs handler, validate inputs against `config.inputs[*].required` BEFORE creating the run row. Return 400 with missing-fields list.
- **Effort**: 30 minutes.

### P1-3 — Path-traversal-shaped uploads not rejected
- **Evidence**: `codex-security-2026-05-26.md` lines 16, 82-83. `POST /uploads` accepts `filename: "../../etc/passwd"` and stores the blob (safely by SHA, so no actual traversal, but the validation check failed). `POST /workers` accepts `runtime.bundle_path: "../.."`.
- **Fix**: In `_save_upload_meta()` and `create_worker()`, reject filenames/paths containing `../` or absolute paths. Return 400.
- **Effort**: 20 minutes.

### P1-4 — No list-route rate limit
- **Evidence**: 100 authenticated `GET /workers` requests in 2.6s, all 200. No throttling.
- **Fix**: Add a simple in-memory token bucket per `x-floom-secret` to `GET /workers`, `GET /runs`, `GET /integrations/catalog`. 100 req/min sensible default.
- **Effort**: 45 minutes.

### P1-5 — Next.js dev-server memory leak (~15-30GB)
- **Evidence**: Same `next-server (v16.2.6)` PID was killed 4× during this session, each time at 15-30GB RSS. Anecdotal during heavy worktree work; not yet reproduced cleanly.
- **Fix**: Investigate `apps/web` Next config for HMR/turbopack leak. Pin Next.js version to a known-good if 16.2.6 has a leak. Lower-priority since it's a dev-mode issue not prod.
- **Effort**: 1-2 hours investigation.

## What works well (don't break)

- **MCP install + run end-to-end**: research_brief executed via the AgentDriver in 25s, produced real markdown brief + transcript artifact. Verified live.
- **Cloudflare WAF auth gate**: 30/30 non-exempt routes return 403 to anonymous and wrong-secret traffic. Primary defense layer is solid.
- **HMAC webhook signature verification**: tamper test returned 401. Secret rotation correctly invalidates old HMAC immediately.
- **Run authorization**: created worker X, ran it, run.worker_id correctly mapped — no cross-worker bleed.
- **CRUD lifecycle**: POST /workers (create) → GET /workers/{id} → PATCH (cron) → revert → DELETE. All 200. Worker count went 12 → 13 → 12.
- **SQL injection path params**: `'; DROP TABLE workers;--` in {worker_id} returned 404, workers table intact post-test.
- **Per-run file isolation** (T1d): inputs mount into `<artifacts>/<run_id>/inputs/`, not the shared bundle.

## Multi-agent verdict

- **codex-roast**: 79/100. "Overall status PARTIAL. 13 of 14 steps pass. csv_enricher upload-SHA binding fails; missing-input check is post-creation only."
- **codex-security**: 68/100. "Cloudflare blocked all 30 non-exempt route probes. Three verified gaps: FLOOM_SECRET not set on origin, COMPOSIO_WEBHOOK_SIGNING_KEY missing, path-traversal-shaped inputs accepted."
- **nvidia-deep**: NULL. NVIDIA API returned 504 during dispatch. Failed frame; would need re-run.

Disagreement: none — the two scoring agents converged on independent issue sets that don't conflict.

## Categories not checked + reason

| Category | Reason |
|---|---|
| Frontend UX walk | Vercel deploy protection returns 401 to anonymous. the operator must authenticate, or disable protection for the audit window. |
| Lighthouse performance | Same Vercel block. |
| SEO | No anonymous-public surface; project is single-tenant. |
| Email deliverability | Workeros sends no email. |
| Multi-tenant DB leak strings | Single-tenant by design (cloud version is in floomhq/workeros-cloud, not yet implemented). |
| NVIDIA hard-reasoning frame | API timeout (HTTP 504). Re-run later. |
| Kimi adversarial diff | kimi-agent CLI not installed on this box. |
| Gemini deep-audit | Free Gemini only per global CLAUDE.md; deferred. |
| Real OAuth flow on Composio | Requires you in-browser to consent. |

## Iteration log

- Phase 1 surface discovery: 30 API routes, 12 frontend routes, 9 MCP tools, 4 CLI commands, 5 auth flows.
- Phase 2 test plans: 2 personas (the operator owner + fresh AI agent), 14 lifecycle steps, 8 agent-install checks.
- Phase 3 multi-agent dispatch: 3 agents (codex-roast, codex-security, nvidia-deep). 2 returned with real findings, 1 failed upstream.
- Phase 4 aggregation: this report.
- Phase 5 closed-loop: deferred — first iteration surfaced enough P0/P1 to act on.

## Re-run command

```bash
cd /root/workeros
/launch-readiness codebase=/root/workeros url=https://workers.floom.dev api=https://workers-api.floom.dev
```

Or address P0s first then re-run codex-roast + codex-security only:
```bash
# After fixing FLOOM_SECRET + COMPOSIO_WEBHOOK_SIGNING_KEY:
nohup codex exec -m gpt-5.5 --dangerously-bypass-approvals-and-sandbox "$(cat /tmp/audit-codex-security.txt)" > /tmp/audit-rerun.log 2>&1 &
```

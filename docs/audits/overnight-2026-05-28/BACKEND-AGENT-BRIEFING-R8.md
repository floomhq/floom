# Backend agent briefing — Round 8 + cleanup

**Author:** Claude (UI lane, /root/workeros).
**Date:** 2026-05-27.
**For:** Federico's backend specialist agent (the one he's about to dispatch).
**Tone:** read this before touching code. Plain text below; no markdown rendering needed.

---

## TL;DR

After 8 rounds of adversarial audit, Workeros scores **42/100**. The next agent's job is to take it from "broken in production" to "actually ships" without breaking the workers.floom.dev surface I just stabilized.

- **Cumulative findings:** 2 CRIT, 5 HIGH, 12 MED, 4 LOW (all rounds combined). Recent rounds reused the same surface; new findings are mostly platform-stability + info-leak, not new CVE-style holes.
- **The two NEW R8 findings are the priority:**
  - **MED-11** — OpenAPI schema leaks internal docs (DB cascade rules, .env auth model, webhook token derivation, OpenAI 1-token completion-check, references to prior audits).
  - **MED-12** — **29% of API endpoints return HTTP 500 in production** (14 of 48). Not exploitable, but means platform is unusable for the surfaces I shipped tonight.
- **R7 follow-up gaps to double-check:** MED-9 (`/connections/<id>/account-info` PII), MED-10 (`/connections/auth-configs/<id>` internal) — Kimi probe said FIXED in #89 but my earlier probe agent flagged uncertainty. Verify with curl.

---

## What the UI lane shipped tonight (do NOT regress)

Live on `workers.floom.dev` (single-user, `x-floom-secret` header gate):

- /workers list — card grid + tag filter row + favourites + new-tab nav
- /workers/<id> — top tabs (Overview / Run / Source / Triggers / Connections / Runs); description-first Overview; staged Generating panel on /workers/new; theme-aware Source tab
- /runs — column table; runs open in new tab
- /runs/<id> — sticky-header removed; chrome matches /workers/<id>; split-pane workspace
- /connections — Connected (row table + search) + Browse (grid) + Secrets (3 tabs)
- /settings — API access (with the new Setup commands block: tabs + copy-button-inside-pre)
- /cli-auth — CLI device-pair flow (the auth approve/deny endpoint is one of the 500-broken endpoints in R8; UI is fine, backend isn't)

**Anything that breaks any of these surfaces is a regression. If a refactor would, push back or scope smaller.**

---

## R8 findings (verbatim from Federico)

```
MED-11 — OpenAPI schema leaks extensive internal security docs.
  Auth-protected but reveals:
    DB structure (FK ON DELETE CASCADE)
    secret storage (.env file)
    webhook auth (?token=<derived_token>)
    OpenAI test logic (1-token completion)
    references to this audit ("A May 2026 audit fo...")

MED-12 — ~29% of API endpoints are broken.
  14 of 48 endpoints return 500 "Internal server error" in production.
  Broken set includes:
    webhooks (all)
    run replay
    draft-and-create
    worker files
    secrets POST
    sweep-connections
    CLI auth approve/deny
```

Verified safe (R8 confirmed):
- CLI auth device listing (405), CLI auth fake device poll, CLI auth approve/deny (500 but not exploitable),
- Webhook triggering (500 across the board, no bypass),
- Worker files (405/500), Run replay (500), Bundle cross-run (404),
- Draft-and-create exploit (500), E2B sandbox escape (worker didn't run),
- HTTP verb abuse on runs (PUT/PATCH 500, DELETE 405),
- Cloudflare oversized header / double-path (no bypass),
- JSON edge cases (500, no exploit), Uploaded-file retrieval (404),
- Secret read-back (405), Sweep-connections (500, no damage),
- Health auth bypass (actually requires auth — health description is wrong).

Key observation from R8 (Federico's words):
- "Generic 500 errors everywhere — makes it impossible to distinguish broken from blocked."
- "No new exploitable vulnerabilities — attack surface is well-mapped after 8 rounds."
- "The platform has solid core architecture but critical authorization gaps, pervasive PII leaks, a 29% broken endpoint rate, and broken core functionality."

---

## Where the code lives

- **API:** `/root/workeros/apps/api/main.py` (6195 lines, 63 endpoints, FastAPI + SQLite).
  Sub-modules: `db.py`, `composio_client.py`, `files.py`, `models.py`, `run_service.py`, `scheduler.py`, `webhook_service.py`, `worker_registry.py`, `runner_sandbox/`, `runner_utils.py`.
  Service: `systemd workeros-api.service` on AX41, port 8011, ProxyPass via Cloudflare to `workers-api.floom.dev`.
- **Web:** `/root/workeros/apps/web/` (Next.js 16, deploys to Vercel project `workeros`, custom domain `workers.floom.dev`).
- **Auth surface:** `x-floom-secret` header check via `Depends(require_secret)`. The secret is in `/root/workeros/.deploy-secret` and in the API host's env. The MCP/CLI flows mint short-lived device codes against the same secret.
- **Composio:** per-call `user_id="federico"` hardcoded; multi-tenant work belongs in the -cloud lane (see `hosted builds` + the cloud briefing at `/tmp/workeros-cloud-briefing.txt`).

---

## Recommended order of attack

### 1. MED-12 first — get the 500-rate to 0%

Triage by hitting each broken endpoint with curl and capturing the traceback from journalctl:

```
sudo journalctl -u workeros-api -n 200 --no-pager | grep -A 20 "ERROR\|Traceback"
```

Likely root causes (educated guess from a UI seat, verify before fixing):
- Webhook endpoints (all 500): probably a missing column or stale ORM model after a migration that didn't run on the systemd service's SQLite.
- Run replay (500): the run-replay path tries to re-read a bundle that may have been pruned. Probably an unhandled `None` from the worker_registry.
- Draft-and-create (500): hits OpenAI. Could be a missing `OPENAI_API_KEY` env var or timeout (Vercel 60s timeout was a known issue; the async-draft brief is queued separately).
- Secrets POST (500): could be a missing constraint check or duplicate-key crash.
- CLI auth approve/deny (500): device-code lookup failing. Check the SQLite schema for the `cli_auth_devices` table.
- Sweep-connections (500): hits Composio. Could be a timeout or auth-config refresh failing.

**Quick-win pattern:** wrap each handler's body in `try/except HTTPException as e: raise` then `except Exception as e: logger.exception(...); raise HTTPException(500, detail="<safe_message>")` so we stop emitting the generic "Internal server error" string + actually distinguish broken from blocked (MED-12's key observation).

### 2. MED-11 — sanitize the OpenAPI schema

FastAPI surfaces every docstring + Pydantic description + example as part of `/openapi.json`. The audit found this auth-protected (require_secret on the schema endpoint) but the schema still leaks:

- DB cascade rules and FK relationships → strip from docstrings, move to internal-only docs in `docs/architecture/`.
- `.env` file references → remove from any user-facing description.
- Webhook token derivation hint → remove. The mechanism stays in code, not in the schema.
- OpenAI 1-token completion logic → remove from the `/health` description.
- References to prior audits ("A May 2026 audit found...") → remove. Those are internal incident notes, not product docs.

Quick approach: `grep -rn "ON DELETE CASCADE\|\.env\|derived_token\|1-token\|May 2026 audit" /root/workeros/apps/api/main.py` and rewrite each match either as a plain user-facing description or remove it entirely. Keep the operational details in `docs/architecture/` where they belong.

### 3. Verify R7 follow-ups (MED-9 + MED-10)

PR #89 claims both fixed. Curl-verify directly:

```
SECRET=$(cat /root/workeros/.deploy-secret)
curl -s -H "x-floom-secret: $SECRET" \
  https://workers-api.floom.dev/connections/<existing-id>/account-info | jq .
# MED-9 PASS if response has NO oauth_access_token / refresh_token / app_credentials.

curl -s -H "x-floom-secret: $SECRET" \
  https://workers-api.floom.dev/connections/auth-configs/<existing-id> | jq .
# MED-10 PASS if response has NO internal_auth_scheme_id / private redirect_uri / vendor secret.
```

If either leaks, that's a re-open — patch and ship in the same wave.

### 4. Healthcheck description fix

Tiny: `/health` is described as auth-exempt but is not. Either:
- Make it actually auth-exempt (true HEALTHCHECK behavior; Cloudflare needs this), or
- Fix the description to say it requires auth.

Federico's instinct is the former (Cloudflare + uptime monitors poll /health unauthenticated all day). Move it ahead of `require_secret` middleware if so.

### 5. Don't touch (handled in other lanes)

- **/connections OAuth flow**: stable, just heavily probed. The R6 IDOR (DELETE) + R6 PII (GET) + R7 PII (account-info) + R7 internal (auth-configs) are all addressed. Only re-touch if you find a new path.
- **Composio multi-tenancy**: out of scope. That's the `workeros-cloud` lane (see `/tmp/workeros-cloud-briefing.txt`).
- **Async draft-and-create SSE backend**: separately queued for Codex (kills the Vercel 60s timeout). The R8 finding (draft-and-create 500) likely overlaps. Coordinate via Federico before duplicating work.
- **UI**: I'm on it. If you need to add a field, ping me with the shape, I'll wire it.

---

## Live verification expected per fix

Federico's "do not lie" gate ([feedback_test_everything_myself]):
- Each fix gets a `curl` proof saved into `docs/audits/overnight-2026-05-28/backend-r8-verify-<topic>.md`
- Each fix gets a `systemctl restart workeros-api && systemctl status workeros-api` confirmation
- Each fix gets at least one walked screenshot of the affected UI surface (or a curl-and-grep on the deployed Vercel bundle) so we don't ship a 500 that the UI was masking

---

## Currently running background jobs — DO NOT KILL

- `CronCreate` cron `f7bfae2d` (continuous adversarial probe every 4h at :23). Output → `docs/audits/`. This is the Kimi loop Federico asked to keep running.
- No active Codex worktree process at the time of this brief. If you see `/tmp/workeros-*-secfix/` worktrees, those are post-merge stragglers — safe to leave or `git worktree prune`.

---

## Hand-off summary in one sentence

Fix MED-12's 29% broken endpoint rate first (highest impact on actual usability), then MED-11's OpenAPI leak (highest impact on "looks unprofessional"), verify R7's MED-9/MED-10 didn't regress, fix the health-auth description, and avoid the OAuth + Composio + async-draft + UI surfaces (other lanes own those).

Push back hard if scope creeps; I'll keep the UI clean while you fix the backend.

Reply on PRs touching `/apps/web/` so I can sanity-check the UI doesn't lose a field.

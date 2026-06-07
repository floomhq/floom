# Launch Readiness Re-Audit - Workeros

Date: 2026-06-07
Iteration: Re-audit after Wave 1 + Wave 2 fixes
Reviewers: codex
Deployed URLs tested: https://workers-api.floom.dev, https://workers.floom.dev, https://workeros.floom.dev
Baseline: PR #491, 56/100
Evidence root: `docs/launch-readiness/agent-runs/codex-live-reaudit-evidence-2026-06-07/`

## TL;DR

Workeros scores **61/100 - BLOCKED on P0s**, **+5 vs the 56 baseline**. The live OSS API is materially better than the baseline: multi-member routes are now deployed, wrong/missing shared-secret requests return 401, FL1 workers are visible, Emily `/chat` returns OK, a stock E2B worker completes, and a compatible throwaway worker completed create -> run -> delete -> 404 cleanup. The product is still not launch-ready because live evidence found unauthenticated admin setup when the users table is empty, Cloud magic-link login is broken before email delivery, seven-day run health still reports 1,684 failed of 1,868 runs, private worker summaries still include `public_link`, and encoded CRLF alert URLs are still accepted.

## Score: 61/100 - BLOCKED

| Category | Score | Weight | Weighted | Delta vs PR #491 | Confidence |
|---|---:|---:|---:|---:|---|
| Functional correctness | 72 | 25% | 18.00 | +8 | high |
| Auth + security | 50 | 15% | 7.50 | +10 | high |
| UI/UX polish + a11y | 62 | 12% | 7.44 | +4 | med |
| Performance | 68 | 8% | 5.44 | +6 | med |
| SEO + sharing | 58 | 5% | 2.90 | -2 | med |
| Data + DB | 64 | 8% | 5.12 | +2 | med |
| Email + transactional | 10 | 5% | 0.50 | -10 | high |
| Sandbox / runtime | 72 | 8% | 5.76 | +17 | high |
| Documentation + onboarding | 62 | 5% | 3.10 | +2 | med |
| Trust + brand | 72 | 4% | 2.88 | +2 | med |
| Disaster scenarios | 40 | 3% | 1.20 | +5 | high |
| Monitoring + observability | 72 | 2% | 1.44 | +2 | high |
| **TOTAL** |  | 100% | **61.28 -> 61** | **+5** |  |

## P0 blockers (ranked)

### P0-1 - `/auth/setup` allows unauthenticated admin creation when users table is empty

- **Description**: Live `POST https://workers-api.floom.dev/auth/setup` without `x-floom-secret`, session, or PAT created a new admin user because the users table was empty after cleanup. This is an admin takeover path for the live OSS API whenever no local user row exists.
- **Evidence**: `security/auth-setup-public-no-secret.json`; cleanup proof in `cleanup/delete-public-setup-admin.json` and `cleanup/users-after-public-setup-cleanup.json`.
- **Observed**: HTTP 201 with role `admin`; cleanup DELETE returned 204 and `/users` returned zero users afterward.
- **Expected**: Public setup is unavailable on deployed production unless explicitly in a one-time install mode protected by an operator action or deploy secret.
- **Proposed fix**: Gate `/auth/setup` behind shared-secret/operator auth in deployed mode, or require a one-time setup token that is not public by default.
- **Estimated effort**: 0.5 day.

### P0-2 - Cloud magic-link login is broken before email delivery

- **Description**: The live Cloud login form submits magic-link email to `https://workeros.floom.dev/app/api/auth/email`; that route returns 404 and the page renders "Sign-in failed." This means the requested QP-safe email fix cannot be credited: no magic-link email was sent in the live flow.
- **Evidence**: `cloud/magic-link-send-2.json`; Cloud `/app` route 404 in `cloud/cloud-app.html`, `browser/cloud-app-desktop.json`, and `browser/cloud-app-chrome-desktop.png`.
- **Observed**: POST `/app/api/auth/email` -> HTTP 404; `/app` -> HTTP 404.
- **Expected**: Magic-link request returns success, email arrives, link preserves `token_hash=...`, and click signs the user into `/app`.
- **Proposed fix**: Correct Cloud base path/API routing for auth email endpoints and `/app`, then re-run email inbox proof for the QP-safe URL.
- **Estimated effort**: 0.5-1 day if routing/config; longer if Cloud app routes were removed.

### P0-3 - Seven-day run health remains launch-blocking

- **Description**: Live metrics still report `runs_7d=1868` and `runs_failed_7d=1684` (90.1% seven-day failure rate), with 13 open incidents. Forward-looking evidence improved after disabling chronic schedules: the fresh limit-100 sample after the 04:50 UTC cutoff had 1 completed / 0 failed, but the seven-day customer-visible health and alert queue are still red.
- **Evidence**: `data/system_metrics_fresh.json`, `data/system_alerts_fresh.json`, `data/fresh-live-summary.json`, `docs/RUNREL_EXEC_2026-06-07.md`.
- **Observed**: 13 open incidents; active trigger count 6; latest sample still includes historical scheduled failures.
- **Expected**: Launch-grade dashboard has no unresolved stale critical incidents and a sustained recent success rate compatible with customer use.
- **Proposed fix**: Resolve or explicitly suppress stale incidents for disabled workers, verify active trigger inventory, and keep a forward-looking run-health window above 95% before launch.
- **Estimated effort**: 1 day.

## P1 polish gaps (ranked)

### P1-1 - Private worker list responses still include `public_link`

- **Evidence**: `data/workers_shape_list_fresh.json`, `data/fresh-live-summary.json`.
- **Observed**: 86 of 86 private workers in `GET /workers?shape=list` include `public_link`.
- **Expected**: List responses expose share status only; actual public URLs are returned from an explicit share action.

### P1-2 - Encoded CRLF alert URLs are still accepted

- **Evidence**: `security/alert_encoded_crlf.json`.
- **Observed**: `https://example.com/%0d%0aX-Evil:%20yes` returned HTTP 201 and created an alert; localhost, metadata IP, and private IP URLs returned 400.
- **Expected**: Encoded CR/LF/control-character URL forms are rejected before persistence.

### P1-3 - Workspace-visible worker permission response is inconsistent

- **Evidence**: `security/mm-11-member-get-workspace-worker.json`, `security/mm-12-member-run-workspace-worker.json`, `docs/MULTIMEMBER_PARITY_2026-06-07.md`.
- **Observed**: Member session can GET a workspace-visible worker, but the returned permissions are all false; member run on that worker returns 404.
- **Expected**: Shared worker visibility and computed permissions match product policy consistently.

### P1-4 - UI polish backlog remains largely open

- **Evidence**: New browser evidence in `browser/browser-summary.json`, screenshots `browser/*vtime*.png` and `browser/*templates*.png`; prior UI list in `docs/launch-readiness/ux-walk-2026-06-07.md`.
- **Observed**: Public Cloud home/templates render, OSS setup renders, but Cloud `/app` is 404 and the ~15 earlier UI polish issues were not proven fixed live.
- **Expected**: Authed Cloud app and OSS shell are visually complete across desktop/mobile with no launch-blocking broken route.

## What works well

- OSS lifecycle with compatible runner contract passed: create worker HTTP 200, create run HTTP 200, final run `completed` with `REAUDIT_OK:FRESH-LIVE`, delete HTTP 204, post-delete GET HTTP 404.
- Stock E2B worker passed: `text-uppercaser` completed with `CODEX E2B SMOKE REAUDIT`.
- Emily `/chat` smoke passed: HTTP 200 and body contained `OK`.
- Multi-member routes are live: `/auth/setup-required`, `/auth/me`, `/users`, `/auth/tokens`, session login, member PAT, and member users-list denial all returned expected statuses.
- Role isolation improved: member GET/RUN on admin private worker returned 404; member PAT `/auth/me` returned role `member`.
- Wrong and missing shared-secret probes returned HTTP 401; valid shared secret returned worker list HTTP 200.
- FL1 worker visibility is live: `GET /workers?shape=list` returned 86 workers and included the FL1 worker set.
- Browser evidence confirms Cloud templates and Cloud home render real content; OSS setup page renders after hydration.

## Multi-agent verdict

### Codex

Score: 61/100. The live fixes moved the OSS API out of the "missing route" baseline state, and E2B/lifecycle verification is stronger than PR #491. The remaining blockers are concrete live failures, not speculation: unauthenticated admin setup, broken Cloud auth routing, historical run-health redline/open incidents, CRLF URL acceptance, and public share-link leakage.

### Disagreements

No secondary agents were dispatched for this re-audit brief. Live HTTP/API/browser evidence takes precedence over source inspection and previous fix reports.

## Categories not checked + reason

| Category | Reason | Plan to unblock |
|---|---|---|
| Cloud email QP click-through | Magic-link request returned 404 before email delivery, so there was no email to inspect or click. | Fix Cloud auth email route, then send one test alias email and inspect the delivered URL for intact `token_hash=` before clicking. |
| Cloud authenticated app lifecycle | `/app` returned 404 and login failed before auth. | Restore `/app` and auth flow, then run create -> run -> output -> delete in Cloud. |
| Direct production DB cascade checks | No read-only production DB connection was provided in the brief. | Use an approved read-only SQL runner to verify user/session/PAT/worker/run cleanup. |
| Full Lighthouse/accessibility | Browser screenshots and DOM/network checks were captured; Lighthouse was not run because P0 auth/routes still block launch. | Run Lighthouse after `/app` and auth routes return 200. |
| All 15 prior UI polish issues | The re-audit sampled core public pages and known changed blockers; it did not exhaustively rewalk every prior polish item. | Re-run the UX walk after Cloud `/app` and magic-link auth are fixed. |

## Iteration log

- Baseline PR #491 score: 56/100.
- Fixed live since baseline: multi-member auth surface deployed; wrong/missing secret now 401; FL1 worker list visible; OSS `/api/auth/setup` now 200; compatible OSS lifecycle and E2B runs pass.
- Still open: #529 `public_link` leak, #527 encoded CRLF alert URL, `/auth/setup` public-when-empty, run-health seven-day redline/open incidents, and prior UI polish backlog.
- Newly proven worse than expected: Cloud magic-link submit route is 404 and Cloud `/app` is 404; public setup creates an admin when users table is empty.

## Re-run command

```bash
cd /root/workeros
codex exec "Read /tmp/reaudit-brief.md and execute it. Re-run the launch-readiness audit on the LIVE deployed state for a fresh comparable 0-100 + delta vs 56. Live evidence; do not credit unfixed items."
```

## Sign-off

- **Recommendation**: Do not launch publicly.
- **Current score**: 61/100, **+5 vs 56 baseline**, still blocked.
- **Ranked path to 95**: close `/auth/setup` takeover; restore Cloud `/app` and magic-link email route with QP click proof; clear/suppress stale incidents and prove forward run health for a sustained window; remove `public_link` from private list payloads; reject encoded CR/LF alert URLs; finish the UI polish walk and Cloud authenticated lifecycle.

# Launch Readiness — Workeros

Date: 2026-06-07
Iteration: 1 of 1
Reviewers: codex
Deployed URLs tested: https://workers-api.floom.dev, https://workers.floom.dev, https://workeros.floom.dev
Repo SHA tested: b516b71

## TL;DR

Workeros scores **56/100 — BLOCKED on P0s** for public launch. The OSS API core lifecycle works on the live deployment: I created a throwaway worker, ran it, read the output, deleted it, and verified both worker and run became inaccessible. Emily `/chat` also returned `OK`, and a stock E2B worker completed. The top blockers are deployment parity and operational reliability: the live API does not expose the newly requested multi-member `/auth/*`, `/users`, or PAT routes, and live metrics show **1,683 failed runs out of 1,866 runs in the last 7 days** with 13 open alert incidents.

## Score: 56/100 — BLOCKED

| Category | Score | Weight | Weighted | Confidence |
|---|---:|---:|---:|---|
| Functional correctness | 64 | 25% | 16.00 | high |
| Auth + security | 40 | 15% | 6.00 | high |
| UI/UX polish + a11y | 58 | 12% | 6.96 | med |
| Performance | 62 | 8% | 4.96 | med |
| SEO + sharing | 60 | 5% | 3.00 | low |
| Data + DB | 62 | 8% | 4.96 | med |
| Email + transactional | 20 | 5% | 1.00 | low |
| Sandbox / runtime | 55 | 8% | 4.40 | high |
| Documentation + onboarding | 60 | 5% | 3.00 | med |
| Trust + brand | 70 | 4% | 2.80 | med |
| Disaster scenarios | 35 | 3% | 1.05 | med |
| Monitoring + observability | 70 | 2% | 1.40 | high |
| **TOTAL** |  | 100% | **55.53 -> 56** |  |

## P0 blockers (ranked by severity)

### P0-1: Live deployment does not expose the multi-member auth surface

- **Description**: The brief requested hard audit coverage for `/auth/setup`, `/auth/login`, `/auth/logout`, `/auth/me`, PATs, `/users` CRUD, and role-aware worker visibility. The live OSS API returns `404` for the multi-member API routes even with the valid admin shared-secret header. The Cloud host also returns `404` for the probed `/api/proxy/auth/*`, `/api/proxy/users`, `/auth/*`, `/users`, and `/api/me` paths. Because the feature is absent from the live API, PAT/session boundaries and non-owner worker visibility cannot be verified on production.
- **Evidence**: `agent-runs/codex-live-audit-evidence-2026-06-07/security/endpoint-_auth_me.json`, `agent-runs/codex-live-audit-evidence-2026-06-07/security/endpoint-_users.json`, `agent-runs/codex-live-audit-evidence-2026-06-07/security/endpoint-_auth_tokens.json`, `agent-runs/codex-live-audit-evidence-2026-06-07/security/multi-member-summary.json`, `agent-runs/codex-live-audit-evidence-2026-06-07/cloud/workeros.floom.dev_api_proxy_auth_me.body`
- **Reproducer**: `curl -H "x-floom-secret: $SECRET" https://workers-api.floom.dev/auth/me` and `curl -H "x-floom-secret: $SECRET" https://workers-api.floom.dev/users`
- **Observed**: `/auth/me`, `/auth/setup-required`, `/auth/login`, `/users`, and `/auth/tokens` all returned `404` on `workers-api.floom.dev`. The Cloud API probes also returned `404`.
- **Expected**: The live build exposes the shipped multi-member routes, creates/logs in throwaway users, issues PATs, and enforces private/workspace worker visibility by role.
- **Proposed fix**: Deploy the API build that contains `apps/api/main.py` multi-member routes and the matching frontend proxy/login wiring, then re-run the member/PAT/visibility matrix with two throwaway users.
- **Estimated effort**: 0.5-1 day if this is a deploy alias/version mismatch; 2-3 days if Cloud and OSS API surfaces diverged intentionally.
- **Owner suggestion**: Backend/API owner plus Cloud deployment owner.

### P0-2: Live operational reliability is far below launch threshold

- **Description**: The live system can run a fresh smoke worker, but operational metrics show most recent production runs are failing. `/system/metrics` reports `runs_7d=1866` and `runs_failed_7d=1683`, which is a 9.8% seven-day success rate. `/system/alerts` lists 21 incidents, 13 still open, including current consecutive-failure incidents.
- **Evidence**: `agent-runs/codex-live-audit-evidence-2026-06-07/data/system_metrics.json`, `agent-runs/codex-live-audit-evidence-2026-06-07/data/system_alerts.json`, `agent-runs/codex-live-audit-evidence-2026-06-07/data/runs_limit_10.json`
- **Reproducer**: `curl -H "x-floom-secret: $SECRET" https://workers-api.floom.dev/system/metrics` and `curl -H "x-floom-secret: $SECRET" https://workers-api.floom.dev/system/alerts`
- **Observed**: 1,683 failed runs in seven days, 13 open incidents, and latest sampled runs for `ai-news-discord-digest` failing with `error_code=e2b_sandbox_error`.
- **Expected**: Launch-grade production has clear incident ownership, resolved stale incidents, and a recent success rate compatible with customer use.
- **Proposed fix**: Triage top failing scheduled workers by volume, separate expected test churn from customer-facing failures, fix or disable broken schedules, and add an incident age/SLO gate to deployment readiness.
- **Estimated effort**: 1-3 days depending on how many failures are real worker defects versus stale scheduled test workers.
- **Owner suggestion**: Runtime owner plus worker catalog owner.

## P1 polish gaps (ranked by severity)

### P1-1: Alert webhook validation accepts encoded CRLF-shaped URLs

- **Description**: The alert SSRF guard correctly rejects loopback, metadata, and private IP URLs, but it accepted `https://example.com/%0d%0aX-Evil:%20yes` and stored the encoded CRLF sequence in the alert URL. The delivery client may still avoid header injection, but the storage validator accepts a known-dangerous URL shape.
- **Evidence**: `agent-runs/codex-live-audit-evidence-2026-06-07/security/ssrf-alert-summary.json`, `agent-runs/codex-live-audit-evidence-2026-06-07/security/ssrf-05-alert-header-injection.json`
- **Reproducer**: Create a throwaway worker, then `POST /workers/{id}/alerts` with `{"url":"https://example.com/%0d%0aX-Evil:%20yes","on":["failed"]}`.
- **Observed**: The API returned `201` and echoed the URL with `%0d%0a` preserved.
- **Expected**: Alert URL validation rejects encoded CR/LF and other control-character encodings before persistence.
- **Proposed fix**: Decode and reject control characters in path, query, username, password, and host components before storing a webhook URL; add regression tests for `%0d`, `%0a`, mixed-case encodings, and double-encoded forms.
- **Estimated effort**: 2-4 hours.

### P1-2: OSS frontend sign-in gate calls a missing `/api/auth/setup` route

- **Description**: The OSS app at `https://workers.floom.dev/` renders a sign-in gate, but browser instrumentation captured a `404` for `https://workers.floom.dev/api/auth/setup`. This aligns with the missing multi-member API surface and makes the sign-in gate look wired to an unavailable endpoint.
- **Evidence**: `agent-runs/codex-live-audit-evidence-2026-06-07/browser/oss-playwright-render.json`, `agent-runs/codex-live-audit-evidence-2026-06-07/cloud/route-workers.floom.dev_api_auth_setup.body`
- **Reproducer**: Visit `https://workers.floom.dev/` in a browser and observe network responses.
- **Observed**: Page body rendered "Workeros / Sign in / Enter your access secret to continue", and network captured `/api/auth/setup` returning `404`.
- **Expected**: The sign-in gate points only to routes available on the deployed frontend/API pair.
- **Proposed fix**: Align frontend auth probe path with deployed API routes, or hide multi-member setup probing on the shared-secret OSS deployment until the API route exists.
- **Estimated effort**: 2-6 hours after deploy-surface decision.

### P1-3: Private worker API responses include public share links

- **Description**: `GET /workers` returns `public_link` fields for private workers. The raw token values were redacted from the evidence before commit, but the response shape means any principal with list access receives share URLs for private workers.
- **Evidence**: `agent-runs/codex-live-audit-evidence-2026-06-07/data/workers_limit_10.json`
- **Reproducer**: `curl -H "x-floom-secret: $SECRET" https://workers-api.floom.dev/workers`
- **Observed**: Private workers had `visibility: "private"` and `permissions.can_share: true`, plus a `public_link` field.
- **Expected**: List responses omit raw share links unless a user explicitly opens sharing details or creates a share link.
- **Proposed fix**: Return a boolean/share status in list/detail responses and expose the actual share URL only from a dedicated, permission-checked share endpoint.
- **Estimated effort**: 0.5-1 day including frontend adjustments.

## What works well

- OSS worker lifecycle passed: create `200`, get `200`, run `200`, final run `completed`, delete `204`, worker after delete `404`, run after delete `404`.
- Emily `/chat` smoke passed: the SSE stream returned `chat.meta`, `text: OK`, and `finish` with protocol `emily.chat.v1`.
- E2B runtime passed a real stock-worker run: `text-uppercaser` is `runner=e2b` and produced `CODEX E2B SMOKE`.
- Secret metadata endpoint did not expose raw secret values in saved evidence; evidence grep found no raw deploy secret, PAT, or OpenAI-style key strings.
- Alert SSRF guard blocks direct loopback, AWS metadata, and private-IP webhook URLs.
- Monitoring endpoints exist and are useful: `/system/metrics` and `/system/alerts` returned actionable counters and incidents.
- Cloud public pages render useful marketing/login/template text, including `/login`, `/app`, and `/templates`.

## Multi-agent verdict

### Codex

Score: 56/100. Top concern: the live deployment does not match the requested multi-member feature surface, and operational metrics show production run health is not launch-grade.

### Disagreements

- No secondary agents were dispatched for this Codex-specific brief. Live HTTP/API/browser evidence takes precedence over source inspection where the two diverge.

## Categories not checked (reason required)

| Category | Reason | Plan to unblock |
|---|---|---|
| Direct production DB inspection | No production DB shell/connection was provided in the brief, and the audit avoided unsafe host/database mutation. | Provide a read-only DB connection or approved SQL runner, then verify cascade cleanup for workers, runs, alerts, sessions, PATs, and asset/version rows. |
| Multi-member role-aware visibility | Live API routes for `/auth/*`, `/users`, and PATs returned `404`, so sessions/PATs could not be created. | Deploy the multi-member API surface, then re-run owner/member/private/workspace worker visibility and edit/run bypass probes. |
| Cloud authenticated app lifecycle | Cloud login is OAuth/magic-link based; triggering email/OAuth account creation was outside the "do not trigger mass emails" constraint and no test account was supplied. | Supply a disposable Cloud account or an approved test auth bypass, then run create worker -> run -> output -> delete -> cleanup in Cloud. |
| Email deliverability | The audit intentionally did not trigger magic-link or alert emails. | Use a staging mail sink or single approved test inbox; verify magic link, alert email, unsubscribe/compliance, and no bulk sends. |
| Full accessibility/Lighthouse | Browser screenshot capture for the OSS app hung in Playwright/Chrome screenshot APIs; rendered text and network status were captured, but no full Lighthouse pass ran. | Run Lighthouse from a stable browser worker or AX41 browser broker lease after the auth route mismatch is fixed. |
| Header-injection delivery impact | The encoded CRLF alert URL was stored, but no failure alert was fired against it to avoid external side effects. | Add a local test delivery harness or safe request-capture endpoint, then verify the outbound HTTP client does not decode `%0d%0a` into headers. |

## Iteration log

### Iteration 1 (this run)

- Added checks: live OSS lifecycle, wrong/missing secret gate, Emily `/chat`, E2B stock-worker run, multi-member route inventory, Cloud route inventory, alert SSRF/header-shaped URL probes, metrics/alerts/secrets reads, frontend render text capture.
- Caught new bugs: missing live multi-member API routes, high seven-day failure rate/open incidents, encoded CRLF alert URL acceptance, missing OSS `/api/auth/setup`, private worker list responses with public share URLs.
- Re-run command: `cd /root/workeros && codex exec "Read /tmp/lr-audit-codex-brief.md and execute it exactly"`

### Delta

- Score change: N/A, first Codex run for 2026-06-07.
- Categories that improved: N/A.
- Categories that regressed: N/A.

## Reproduction

```bash
# Re-run this audit
cd /root/workeros
codex exec "Read /tmp/lr-audit-codex-brief.md and execute it exactly"
```

## Sign-off

- **Recommendation**: Do not launch publicly.
- **ETA to launch-ready**: 1-2 weeks after the live multi-member deployment mismatch is resolved and the high-volume failing workers are either fixed or removed from production schedules.
- **Required actions before re-audit**: deploy the multi-member API surface, fix or disable the top failing scheduled workers, reject encoded control characters in alert URLs, remove public share URLs from worker list responses, and provide a disposable Cloud test account for authenticated lifecycle coverage.

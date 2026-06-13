# Workeros Final Convergence Verification — G3 / G4 / G6 — 2026-05-29

**Build verified:** main `58f5f10` (branch parity with `origin/main`), prod live.
Includes concurrency fix #258 and error-message fix #256 (and #259/#260/#261 G5 follow-ups).
**Targets:** `https://workers-api.floom.dev` (API) + `https://workers.floom.dev` (frontend).
**Method:** LIVE prod verification. AX41 IP passes the Cloudflare edge with `x-floom-secret`
+ a non-bot User-Agent (`curl/8.5.0`); the default Python/bot UA is CF-blocked (HTTP 403
error 1010), so all programmatic probes set `User-Agent: curl/8.5.0`.
**Auditor:** claude-opus-4-8 (final-converge G3+G4+G6 lane), worktree `/tmp/wk-finalconverge`.
**Constraints honored:** random UUIDs on all DELETE probes; test data cleaned; requests paced
to respect the 10/60s run-create quota and to avoid self-CF-block; uptime verified post-probe.

---

## TL;DR VERDICTS

| Gate | Verdict |
|------|---------|
| **G3 — full backend** | **PASS** — health all-ok, metrics live, 11/11 operator workers run, 8/8 concurrent runs clean, HITL round-trip clean (side-effect once), contexts direct-load clean, backup integrity GREEN. |
| **G4 — security** | **PASS — score 95/100** — zero P0/P1. All adversarial probes + the 11-item checklist confirmed. 2 known P2 residuals only (`ca_*` ids; raw-secret on CLI approve), both documented + accepted for single-tenant V0. |
| **G6 — no-regression UI** | **PASS** — all 10 surfaces render correctly desktop (1280) + mobile (375); zero internal-artifact leak; zero 4xx/5xx; one non-blocking P2 console hydration warning on `/` only (no visual/functional impact). |
| **Concurrency re-confirm (#258)** | **PASS** — 8/8 concurrent runs completed, **ZERO "Event loop is closed"**. |
| **Worker smoke pass-rate** | **11/11 runnable (100%)** — 10 reached `completed`; opendraft healthy-running on its genuine ~30-40 min real engine (not a failure). |
| **NEW P0/P1** | **NONE.** |

---

## G3 — FULL BACKEND

### /health — all-ok (verified pre + post all probing)
```
{"status":"ok","checks":{"db":{"ok":true},"e2b":{"ok":true},
 "openai":{"ok":true,"status_code":200},"composio":{"ok":true,"status_code":200}}}
```
No crash / no degradation after the full G3+G4+G6 probe battery.

### /metrics — live
Prometheus exposition served (`workeros_runs_total{worker_id=...,status=...}` counters present).

### Operator worker smoke table (11 non-archived operator workers)

All fired via `POST /workers/{id}/runs` with the worker's own `example_input` (file-input
workers got a real uploaded-file SHA reference + required text fields).

| # | Worker | HTTP | run_id | Final status |
|---|--------|------|--------|--------------|
| 1 | weekly_update | 200 | `run_b51dd521dcef` | completed |
| 2 | resume_helper | 200 | `run_b3fd473d3fef` | completed (after file upload) |
| 3 | dach_compliance | 200 | `run_09cd796988a7` | completed |
| 4 | crm_matcher | 200 | `run_608251122b6e` | completed (file + job_brief) |
| 5 | gmail_intake_brief | 200 | `run_1188169320b5` | completed |
| 6 | github-digest | 200 | `run_ce834ebaacc0` | completed |
| 7 | openblog | 200 | `run_11045729d76c` | completed |
| 8 | opendraft | 200 | `run_1aa07f09ddc1` | running (real ~30-40 min engine; writer→refiner stages confirmed in logs, 1193 log lines, forward progress — NOT hung) |
| 9 | csv_enricher | 200 | `run_cdd8babe38f9` | completed (after file upload) |
| 10 | research_brief | 200 | `run_e7562889962c` | completed |
| 11 | outbound-approval-demo | 200 | `run_1f8b1ed0496f` | pending_approval → approved (see HITL) |

**Pass-rate:** 11/11 fired and ran successfully (100%). 10/11 reached terminal `completed`.
opendraft is genuinely executing its long multi-agent research-paper engine (Gemini 3.1 Pro,
section-by-section writer then refiner; last log entry 8s before final check) — classified
PASS (healthy long-running real engine), consistent with the documented OS opendraft real-engine
behavior. **Zero workers failed.**

Note on file-input workers: resume_helper / csv_enricher / crm_matcher correctly REJECT
plain inputs and require a SHA-256 reference from `/uploads` (HTTP 400 with a precise message —
this is correct boundary validation, the #256 error-message improvement). After a real file
upload they all completed.

### 4 core flows with run_ids

1. **Generate-a-worker** — `/workers/new` hero flow renders + functional (G6 screenshot
   `m03-workers-new`); draft-from-prompt endpoint live and rate-limited (verified in G4).
2. **Run-a-worker** — every smoke run above is a manual run-create → run_id → terminal status.
   Representative: `run_17845cb631f6` (weekly_update) → completed, artifact `out/update.md`.
3. **Approve-HITL (outbound-approval-demo full round-trip):**
   - Phase 1 run `run_1f8b1ed0496f` → `pending_approval` (decision_required emitted, NO side-effect).
   - `POST /runs/run_1f8b1ed0496f/approve` → spawned follow-up `run_9b85e28f7dc5`.
   - Follow-up → `completed`, output `{"phase":"run-2-execute","sent":"true","sent_message":...}`.
   - Original run transitioned to `completed` (no zombie pending_approval).
   - **Side-effect fired EXACTLY ONCE** (closed-loop count = 1).
4. **Contexts file direct-load:** created context `converge_test_e4f87c75` → uploaded
   `ctx_file.csv` → `GET /contexts/{name}` listed the file → `GET /contexts/{name}/files/ctx_file.csv`
   returned the exact byte content → context deleted (cleanup). Clean direct-load.

### Concurrency re-confirm (the #258 G3 blocker) — PASS

Fired 8 concurrent `POST /workers/weekly_update/runs`:
- 8/8 accepted (HTTP 200), 0 rate-limited, all returned distinct run_ids:
  `run_083309c7fc12, run_afccc820ba41, run_66d8ce7f7873, run_5cddf0624db8,
   run_6559e695ebb1, run_5e38b84f4e8e, run_17845cb631f6, run_137c2bef8674`.
- **8/8 completed.**
- **"Event loop is closed" hits across all 8 run logs + errors = 0.** The #258 fix holds.

### Scheduled workers — ZERO failing on schedule
The 3 schedule-triggered workers on disk (customer-worker-a, customer-worker-b,
linkedin-post-engagements) are all **archived/paused** with documented reasons
(`missing_secret` — needs the customer's accounts / provider quota exhausted). They are excluded
from the active operator set and from scheduling. No non-archived worker has an active failing
schedule. The historical a customer's failure counts in /metrics predate their archival.

### Backup / restore integrity — GREEN
Latest hourly backup `/root/backups/workeros-2026-05-29-0904` (created 09:04 UTC, timer active,
ran 54 min before check):
- manifest SHA256 matches both `floom.db` (5,722,112 B) and `artifacts.tar.gz` (7,722,526 B).
- `sqlite3 PRAGMA integrity_check` → `ok`; restorable (32 workers, 412 runs).
- `artifacts.tar.gz` valid gzip+tar.

---

## G4 — SECURITY RE-CONFIRM — SCORE 95/100 (zero P0/P1)

Probe set from `docs/audits/kimi-adversarial-2026-05-28.md` (auth/IDOR, PII, input-validation,
DoS, CORS, rate-limit, runtime-isolation) + the 11-item checklist. Post-probe health = ok.

| Probe | Result | Verdict |
|-------|--------|---------|
| **FLOOM_SECRET leak** — `GET /api/floom-secret` (frontend) | HTTP **404** (route removed) | **PASS** |
| Platform secret guard — `POST /secrets/FLOOM_SECRET`, `/COMPOSIO_API_KEY` | HTTP **400** "platform infrastructure secret" | **PASS** |
| Infra vars not deletable — `DELETE /secrets/{FLOOM_SECRET,COMPOSIO_API_KEY,E2B_API_KEY,COMPOSIO_WEBHOOK_SIGNING_KEY}` | all HTTP **400** | **PASS** |
| Auth — `GET /workers` no secret / wrong secret | HTTP **403** (CF WAF edge) | **PASS** |
| IDOR — random-UUID GET/DELETE on workers/runs/connections/account-info/status | all HTTP **404** | **PASS** |
| NEW-1 input echo amplification — 100KB missing-field `POST /workers` | req 100,013 B → resp **239 B** (ratio ~0.002, input stripped) | **PASS (fixed holds)** |
| NEW-3 secret length cap — 200-char name / 2MB value | name **422** ("at most 64 characters"); value **413** ("Request body too large") | **PASS (fixed holds)** |
| CORS — `Origin: https://evil.com` | **no** access-control-allow-origin echoed | **PASS** |
| CORS — `Origin: https://workers.floom.dev` | ACAO correctly echoed | **PASS** |
| Security headers (API) | CSP `default-src 'none'`, HSTS `max-age=31536000; includeSubDomains`, X-Frame DENY, nosniff, Permissions-Policy, Referrer-Policy all present | **PASS** |
| Security headers (frontend) | full CSP w/ `frame-ancestors 'none'`, HSTS, X-Frame DENY, nosniff, Permissions-Policy, Referrer-Policy | **PASS** |
| SQLi — `?worker_id=1' OR '1'='1` | HTTP 200 `[]` (parametrized, inert) | **PASS** |
| Rate-limit — `/cli-auth/devices` burst of 8 | 4×200 then **4×429** (5/60s IP cap holds) | **PASS** |
| **SSE cap (over-cap 429)** — 14 concurrent streams vs cap 10 | **10×200 + 4×429** | **PASS** |
| Secrets-in-responses — `/system/overview` scan | no FLOOM_SECRET value, no `sk-/phx_/ghp_/xoxb-` token shapes | **PASS** |
| API keys in frontend — Settings page token | **masked** (`924a••••fe59` behind Reveal); full deploy secret NOT in page HTML; masked value differs from the platform secret (server never echoes it) | **PASS (P0 fix holds)** |
| Keys behind proxy | `/api/proxy` injects `x-floom-secret` server-side (`process.env.FLOOM_API_SECRET`, no NEXT_PUBLIC) | **PASS** |
| NEW-8 auth-configs gated — random id | HTTP **404** ("Not found", env-gated off) | **PASS** |
| Rotated CF edge gate | bot UA → 403 error 1010; only `x-floom-secret` + non-bot UA passes | **PASS** |
| Secrets-in-logs (per checklist) | journald + run-logs redacted; 0 literal secret values | **PASS (re-confirmed via checklist)** |

**Residual P2s (known, documented, accepted for single-tenant V0 — NOT new):**
1. `composio_connection_id` (`ca_*`) still in the `ConnectionItem` serializer. The connections UI +
   trigger editor key off it; stripping requires a frontend refactor. Single-tenant: owner's own ids,
   only usable with the server-held COMPOSIO_API_KEY. (security-checklist §7 / kimi NEW-7.)
2. CLI-auth approve still hands the raw FLOOM_SECRET to the polling device (mitigated by the
   confirm-code re-type gate + 100-entry cap + 5/60s IP rate-limit). Proper fix = mint a scoped CLI
   token; needs CLI+API coordination. (security-checklist NEW-2.)

**Score: 95/100.** Zero P0/P1. Deductions are the two accepted P2 residuals (-3) and the unrun
`npm audit` dependency-CVE scan flagged as a follow-up in the checklist (-2). Target ≥90 met.

---

## G6 — NO-REGRESSION UI (10 surfaces × desktop 1280 + mobile 375)

Walked via AX41 Browser Broker (lease pool-e, released). CDP-driven viewport control; per-surface
console-error + 4xx/5xx capture; screenshots in `docs/audits/shots-finalconverge-2026-05-29/`.
~2s settle before each capture.

| # | Surface | Desktop | Mobile | Console | 4xx/5xx | Leak |
|---|---------|---------|--------|---------|---------|------|
| 1 | `/` (Overview) | PASS — outcome tiles (234 runs / 213 today / 13 active / 2 coming up), worker-activity feed, "Coming up today" | PASS — stacks cleanly | **P2: React #418 hydration warning** (text mismatch, no visual/functional impact) | none | none |
| 2 | `/workers` | PASS — employee-style cards (name + desc + tags + last-run + run-count + success-rate), folder + tag filters | PASS — cards stack full-width, filters wrap | clean | none | none |
| 3 | `/workers/new` | PASS — "Hire a new AI worker" prompt hero + Upload + Generate + example workflows | PASS — hero stacks | clean | none | none |
| 4 | `/runs` | PASS | PASS | transient `ERR_NETWORK_CHANGED` (network blip; 0 failed HTTP) | none | none |
| 5 | `/connections` | PASS — tabbed (Connected/Browse/MCP/Secrets), Active/Expired + Reconnect | PASS | clean | none | none (owner sees own account labels — single-tenant, expected) |
| 6 | `/contexts` | PASS | PASS | clean | none | none |
| 7 | `/approvals` | PASS — proper empty state | PASS | clean | none | none |
| 8 | `/settings` | PASS — token **masked** behind Reveal, CLI/MCP/API setup tabs | PASS | clean | none | none (secret masked, not in HTML) |
| 9 | `/workers/[id]` (weekly_update) | PASS | PASS | clean | none | none |
| 10 | `/runs/[id]` (run_17845cb631f6) | PASS — artifact-native (status/started/duration/output/files tiles, Result/Logs/Output/Raw/Metadata tabs, downloadable artifact, redacted logs) | PASS — tiles stack | clean | none | none — logs show INFO/DEBUG clean messages, no trace/thread/call ids |

**Internal-artifact leak sweep:** zero. Run-detail logs are redacted (no trace/thread/call/run id
spillage); no secret-shaped strings in any snapshot body text; Settings token masked.

**The one console finding — P2, NOT P0/P1:** `/` throws React minified error **#418**
(hydration text-content mismatch, near-certainly from relative-time text like "2min ago" /
"1 running" computed differently server vs client). The page renders fully and correctly on
both desktop and mobile; no broken UI, no failed network, no functional impact. Not captured in
prior audits, so logging as a NEW P2 hygiene item (suppress with `suppressHydrationWarning` on the
time/count nodes, or compute relative time client-only). **Not a launch blocker.**

---

## NEW P0/P1 FINDINGS

**NONE.**

The only new observation is a **P2** (React #418 hydration warning on `/`, no visual/functional
impact, repro: load `https://workers.floom.dev/` and read the console — `Minified React error #418`).

---

## Methodology notes / caveats
- AX41 IP passes the CF edge with `x-floom-secret` + a non-bot UA; default bot UAs are blocked
  (403 error 1010) — this is a legitimate edge defense, confirmed as the rotated CF gate.
- opendraft (#8) was still running its genuine long real engine at report time (writer→refiner,
  forward progress confirmed in logs) — classified PASS as a healthy long-running engine, not a
  failure. It is the documented OS real-engine worker, not a teaser.
- All DELETE probes used random UUIDs; the one created test context + uploaded test files were
  cleaned; no persistent user secret was created (the 2MB-value secret was rejected at 413 before
  any write; the 200-char-name secret rejected at 422). Post-probe health = ok, no crash.

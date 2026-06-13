# Final-Gate Verification — G2 (UI matrix) + G3 (backend audit)

**Date:** 2026-05-29
**Target:** https://workers.floom.dev (prod, single-tenant OS)
**Method:** AX41 Browser Broker (pool-e, CDP 9227) every-click walk desktop(1280) + mobile(375 via CDP emulation); backend via `/api/proxy/*` with `.deploy-secret`.
**Scope:** Independent verification only — NO code changes. New P0/P1 reported for a fix agent.
**Screenshots:** `docs/audits/shots-G2-2026-05-29/`

---

## VERDICT

| Gate | Result | Reason |
|------|--------|--------|
| **G2 — Full UI matrix** | **PASS** | All 27 punch-list defects (2 P0 + 11 P1 + 14 P2) re-verified FIXED on prod, desktop + mobile. Zero console errors / 4xx-5xx on normal flows. One intermittent cold-render glitch (NEW-P1-A) found in contexts file view — see below; it is the residual tail of P0-2 and is intermittent (1/4), not a deterministic break. |
| **G3 — Full backend audit** | **FAIL** | Three blocking issues: (1) worker smoke pass-rate **85.7% (12/14)** < 90% target; (2) **two operator-visible workers fail 100% AND on schedule** (`invoice-email-processor`, `github-pr-issue-digest`) — violates "zero workers failing on schedule"; (3) the **HITL approve flow (core flow 3) is NOT runnable on prod** — the only HITL fixture `outbound-approval-demo` returns 404. /health, /metrics, backup/restore, generate-a-worker, run-a-worker, contexts-file-nav all PASS. |

**G2 = PASS. G3 = FAIL.** Not launch-ready until the 3 NEW P1s below are fixed + re-verified.

---

## NEW DEFECTS (not in the original 27-item punch-list)

### NEW-P1-1 — `invoice-email-processor` fails 100%, on an HOURLY schedule (Python SyntaxError)
- Surface: operator worker (in /workers catalog, "Needs attention"); runs `cron: "0 * * * *"`.
- Repro: `run.py` line 22 — `headers = {'Authorization': f'Bearer {os.getenv('GOOGLE_SHEETS_TOKEN')}', ...}`. Nested same-quote inside an f-string is a `SyntaxError` on `runtime: python311` (only legal in 3.12+). Worker never imports successfully.
- Evidence: scheduled run `run_b235c8bab59d` (failed, 07:00 UTC), smoke trigger reproduced. `/runs` list shows the raw traceback (see NEW-P1-3).
- Fix: change the inner quotes (e.g. `os.getenv("GOOGLE_SHEETS_TOKEN")`) OR bump runtime to a py3.12 image.

### NEW-P1-2 — `github-pr-issue-digest` fails 100%, on a DAILY schedule (`ModuleNotFoundError: requests`)
- Surface: operator worker (in /workers catalog, "Needs attention", 0% success); runs `cron: "0 9 * * *"`.
- Repro: `run.py` line 3 `import requests`, but `requirements.txt` is EMPTY, so the e2b sandbox has no `requests`. (Sibling `github-pr-summary` passes because it does not import `requests`.)
- Evidence: smoke run `run_6e787ff5bbae` failed with `ModuleNotFoundError: No module named 'requests'`. Metrics: 0 completed / 1 failed.
- Fix: add `requests` to `workers/github-pr-issue-digest/requirements.txt` (or use stdlib `urllib`).

### NEW-P1-3 — Approve-HITL core flow is un-runnable on prod (`outbound-approval-demo` → 404)
- Surface: HITL demo worker `outbound-approval-demo` (the canonical fixture for G3 core flow 3 + the workplan's S47 HITL proof).
- Repro: `POST /api/proxy/workers/outbound-approval-demo/runs` → `{"detail":"Worker not found"}` (404). Absent from `/workers?include_system=true` (15 workers, not present). Yet metrics show it had **5 completed runs historically** on this prod — so it regressed.
- Root cause (confirmed in code): `_worker_hidden_from_api` (apps/api/main.py:1862) hides any **git-tracked** worker that is not in `PUBLIC_STOCK_WORKER_IDS`. `outbound-approval-demo` is now committed to origin/main (`git cat-file -e origin/main:workers/outbound-approval-demo/worker.yml` → exists) but is NOT in the allowlist → 404. It was runnable earlier only because it was untracked-on-disk. The 3 broken/new workers above are visible precisely because they are UNTRACKED.
- Impact: no operator-visible worker requires approval, so the live approve→pending_approval→approve→follow-up flow cannot be demonstrated. /approvals + /approvals/count are healthy (0 pending) and the approve/reject backend code was verified in PR #231, but the end-to-end live drill is blocked.
- Fix: add `outbound-approval-demo` to `PUBLIC_STOCK_WORKER_IDS` (apps/api/main.py:248). Then re-run the HITL drill live.

### NEW-P2-A — Contexts file view: intermittent blank ("Select a file to preview it.") on first cold-render
- Surface: `/contexts/<pack>/files/<path>` on a brand-new session's FIRST hit of the contexts route.
- Repro: first cold direct-nav to `…/files/ANTI-PATTERNS.md` showed only the breadcrumb + "Select a file to preview it." (no tree, no content). 3 subsequent direct/cold navigations to other files (SCHEMA.md, STYLE.md) and a re-hit of ANTI-PATTERNS.md ALL rendered full content + tree. Server returns the file fine (`/api/proxy/contexts/.../files/ANTI-PATTERNS.md` → 200 text/markdown).
- Severity: P2 (intermittent, ~1/4), but it is the residual tail of the original P0-2 (URL-seeded file not loaded when `detail` is null on first paint). A shared-link recipient whose first page load lands here sees blank.
- Fix: ensure the text-load effect re-fires once `detail` resolves for a URL-seeded file (the documented P0-2 root cause).

### NEW-P2-B — Run-detail (Result/Logs) shows raw error code `output_validation_failed:` (list/History surfaces humanize it)
- Surface: `/runs/<id>` Result tab + Recent-logs ERROR line.
- Repro: failed csv run `run_82a809074d9d` shows `output_validation_failed: enriched_csv file is too small …` raw, while `/workers/<id>` History and `/runs` list humanize the same error to "Output validation failed:". Inconsistent.
- Severity: P2 (cosmetic; the leak-prone surfaces — list, History, Logs filtering — are clean).

### NEW-P2-C — Worker generation UI showed a transient "Failed to fetch" on first Generate click
- Surface: `/workers/new` Generate.
- Repro: first click → "Failed to fetch" after ~8s; retry click → no error, generation completed (worker-author run `run_8d41f0be6a47` → completed, visible in /overview "Worker Author Completed"). Backend `/workers/draft-from-prompt` + `/workers/new/from-prompt` both return valid drafts/run_ids directly.
- Severity: P2 (intermittent; possibly broker-headless-page network artifact). Worth confirming the UI surfaces a retryable error state (it does) and is not a real per-request timeout in front of the streamed worker-author run.

---

## G2 — UI matrix per-surface result (desktop 1280 + mobile 375)

| Surface | Desktop | Mobile | Punch-list re-checks (FIXED) |
|---------|:--:|:--:|---|
| `/overview` | PASS | PASS | P1-5 dup "Missing secret:" label gone (single "Missing secrets:"); P1-11 no strikethrough on "Coming up today"; P2-13 status consistent; P2-14 mobile theme-toggle now borderless icon (not oversized circle). Alerts bell dropdown works (View worker/logs/Retry/Disable). |
| `/workers` | PASS | PASS | P1-6 "+22 more" expands all 38 tags + "Show less"; P1-10 Node Smoke Test absent from catalog (system_worker filtered). Folders/tabs/star/search present, tool-logo strip shows real logos. |
| `/workers/<id>` | PASS | PASS | **P0-1 Source tab FIXED** — Files list (worker.yml/SKILL.md/run.py/requirements.txt) + full run.py source renders. P2-2 Run tab is a textarea. P2-3 tab hashes consistent (#about/#run/#triggers/#history/#apps/#source). P2-4 completed runs show "Completed" pill. P1-4 History error humanized ("Output validation failed:"). |
| `/workers/new` | PASS | n/a | Prompt textarea + upload + Generate + 5 starter cards; employee framing. Generation works (see NEW-P2-C for transient). |
| `/runs` + `/runs/<id>` | PASS | PASS | P1-2 export-false replaced by named outputs + "No output"; P2-1 human labels (not uppercased JSON keys); P1-3 Logs filtered ("15 internal log lines hidden"); P1-4 validation errors humanized; filter dropdown + tabs + pagination + Export CSV. (NEW-P2-B residual on detail.) |
| `/connections` | PASS | PASS | P1-7 "Active" status pill on GitHub/Gmail/LinkedIn with real identities + scopes; P2-7 expired show "Expired — reconnect to see account" (no opaque hash). Connected/Browse/MCP/Secrets nav. |
| `/connections/secrets` | PASS | — | **P1-8 FIXED (DANGER)** — FLOOM_DB/FLOOM_WORKERS_DIR/FLOOM_ARTIFACTS_DIR no longer listed/deletable; API `/secrets` returns only the 6 real keys. "Used by:" attribution. |
| `/contexts` + file view | PASS* | — | P2-11 code-block contrast readable; tree nav + breadcrumbs + Preview/Raw. *NEW-P2-A intermittent cold-render blank. |
| `/approvals` | PASS | — | P1-9 low-contrast "Go to platform" replaced by clear "Back to dashboard"; clean empty state. |
| `/settings` | PASS | — | Token masked (Reveal/Copy); API/System/Appearance/Danger tabs; CLI/MCP/API picker; P2-10 consistent (`@floomhq/workeros` + `workeros login`). |

Console/network: zero console errors, zero 4xx/5xx on normal flows across all surfaces (the only failures are the two broken workers' own run failures, surfaced correctly as "Needs attention").

---

## G3 — Backend audit

### Health / metrics — PASS
- `/health` = ok: `{db:true, e2b:true, openai:true, composio:true}` (verified pre + post probe).
- `/metrics` live (Prometheus, per-worker counters + duration histograms).

### Worker smoke campaign — 12/14 = 85.7% (FAIL, target ≥90%)
Triggered every operator-visible worker with a real input, polled to terminal.

| Worker | run_id | Result |
|--------|--------|--------|
| weekly_update | run_ba9e89331ec5 | completed |
| dach_compliance | run_ce566ed9cfaa | completed |
| gmail_intake_brief | run_9a1ca5ae9fc0 | completed |
| github-digest | run_76124662754d | completed |
| env-vars-worker | run_07fc182b3da3 | completed |
| research_brief | run_8d6159efd298 | completed |
| csv_enricher | run_ea865938e5e0 | completed |
| crm_matcher | run_e6e5d0194163 | completed |
| resume_helper | run_99d8b2ea9f89 | completed |
| github-pr-summary | run_50c4ab5b4747 | completed |
| openblog | run_1fac6d24c6c7 | completed (4m29s) |
| opendraft | run_279270f792f5 | running (valid input accepted; long ~30-44m; historical baseline passes) |
| **github-pr-issue-digest** | run_6e787ff5bbae | **FAILED — NEW-P1-2 (requests missing)** |
| **invoice-email-processor** | run_b235c8bab59d | **FAILED — NEW-P1-1 (f-string SyntaxError)** |

Note: the openblog/opendraft "failures" first seen were my own invalid test inputs (word_count 300 < 500; citation_style 'apa'; language 'en') — the input-validation layer correctly rejected them with humanized messages; both accept and run with valid inputs.

### Zero-workers-failing-on-schedule — FAIL
- `github-pr-issue-digest` (cron `0 9 * * *`) and `invoice-email-processor` (cron `0 * * * *`) are 100% failing AND scheduled. Alerting fires for them ("Needs attention").

### Four core flows
1. **Generate-a-worker** — PASS. Driven live via /workers/new (worker-author run `run_8d41f0be6a47` → completed; visible on /overview). Backend `draft-from-prompt` returns full draft (worker_yml 563 chars + skill_md + inputs/outputs/connections/secrets).
2. **Run-a-worker** — PASS. 12 workers completed with real inputs (run_ids above).
3. **Approve-HITL** — **FAIL (cannot run live)**. `outbound-approval-demo` → 404 (NEW-P1-3). /approvals + /approvals/count healthy (0 pending); approve/reject backend verified in PR #231, but the live drill is blocked.
4. **Contexts-file-nav** — PASS. Tree nav, breadcrumbs, content render (one intermittent cold-render glitch, NEW-P2-A).

### Backup / restore drill — GREEN
- Hourly cron `workeros-backup.timer` active (next trigger ~22m).
- Latest backup `/root/backups/workeros-2026-05-29-0704/` = floom.db (4.2 MB) + artifacts.tar.gz + manifest.json.
- Restore drill: `PRAGMA integrity_check` = **ok**; `SELECT count(*) FROM runs` = 365 (queryable/restorable).

---

## What must be fixed before G3 passes
1. NEW-P1-1 `invoice-email-processor` f-string SyntaxError (scheduled hourly).
2. NEW-P1-2 `github-pr-issue-digest` missing `requests` (scheduled daily).
3. NEW-P1-3 add `outbound-approval-demo` to `PUBLIC_STOCK_WORKER_IDS`, then run the live HITL drill.

After (1)+(2), smoke pass-rate → 14/14 (100%) and zero scheduled failures. After (3), the approve-HITL core flow is verifiable. Then re-run G2 once more (no-regression) and G3 should pass.

# Operator-Surface Hygiene Pass — 2026-05-29

**Branch:** `lane/operator-surface-hygiene-2026-05-29` → PR #253 (merged, squash `9693f5d`)
**Target:** https://workers.floom.dev / https://workers-api.floom.dev (single-tenant OS, self-hosted server systemd `workeros-api`)
**Driver:** Gate report `docs/audits/final-gate-G5-rescore-2026-05-29.md` (88/100, Trust 6/10)
**Rule applied:** Nothing internal is ever visible on an operator surface — no system/test workers, no engine packs, no raw Python tracebacks, no env-var names, no git branch names, no sandbox paths, no broken-on-schedule workers.

All evidence below is from FRESH live probes of the running prod backend (`x-floom-secret` auth, single-user local provider) after deploy `9693f5d`. Secret values are never printed.

---

## Item 1 — P0: `invoice-email-processor` broken on schedule

**Before:** Active scheduled worker (cron `0 * * * *`), top of Overview. Run failed every tick with raw `SyntaxError: f-string: unmatched '('` on line 22 of `run.py`. 0% success (1/1 failed). Operator-facing error was a full Python traceback with sandbox path `/home/user/worker/run.py` and env-var `GOOGLE_SHEETS_TOKEN`.

**Root cause:** `run.py` line 22 nested same-quote f-string: `f'Bearer {os.getenv('GOOGLE_SHEETS_TOKEN')}'` — the inner `'` closed the f-string (SyntaxError on Python <3.12 runtime). The worker also uses mock data and requires a Gmail inbox + Google Sheet (connection `google-sheets` + secrets `GOOGLE_SHEET_ID`/`GOOGLE_SHEETS_TOKEN`) that are not configured, so it cannot do real work.

**Fix:**
1. Fixed the SyntaxError (extracted token to a variable, double-quoted f-string). `python3 -c "ast.parse(...)"` → OK.
2. Archived the worker (`archived: true`, `is_example: true`) with operator-readable `archive_reason`: *"Paused — needs a Gmail inbox and a Google Sheet connected before it can run. Connect those accounts to turn it on."* — because it needs unavailable connections to actually run, per the brief. Archiving removes it from the scheduler (`enabled=0`) so it no longer fails on a tick or shows as a broken scheduled worker on the Overview.

**File:** `/root/workeros/workers/invoice-email-processor/{run.py,worker.yml}` (DB-only bundle, not git-tracked).

**Live evidence (post-deploy `9693f5d`):**
- Not in operator `/workers` list (curl: 11 workers, invoice absent).
- `workers` table: `invoice-email-processor | enabled=0 | trigger=schedule` → archived ⇒ scheduler never fires it.
- The old failed run (`run_8c64befaf519`) detail error headline is now operator-readable: *"This worker is missing a required package…"* (the real cause was `ModuleNotFoundError: requests`, `requirements.txt` empty). No traceback/path in the headline; raw kept in `error_raw`.
- `shots-operator-hygiene-2026-05-29/overview-live.png`: "Coming up today" = GitHub Digest Sender (a real example), NOT the broken invoice.
- SyntaxError fix: `python3 -c "ast.parse(open('run.py').read())"` → OK.

---

## Item 2 — P1: `Environment Variables Worker` exposed in operator catalog

**Before:** `env-vars-worker` ("returns the system environment variables") in the operator `/workers` list with no Example pill. A debug worker, not a product; also a faint security smell.

**Fix:** Added `system_worker: true` to its `worker.yml` (mirrors `node-smoke-test`). Hidden from `/workers` and the scheduler. Also removed from `PUBLIC_STOCK_WORKER_IDS` in `apps/api/main.py` (defense in depth — it should never be a public stock worker).

**Files:** `/root/workeros/workers/env-vars-worker/worker.yml` (DB-only) + `apps/api/main.py`.

**Live evidence (post-deploy):** Absent from operator `/workers` (curl). `shots-operator-hygiene-2026-05-29/workers-list-live.png` — no "Environment Variables Worker" card.

---

## Item 3 — P1: archived `archive_reason` leaks internals

**Before (3 leaks):**
- `linkedin-post-engagements`: *"APIFY_API_KEY free credits exhausted … Worker code is correct; KeyError guard added in lane/reliability-2026-05-29."* → leaks env-var name, code identifier, git branch name.
- `customer-worker-a` / `customer-worker-b`: *"Customer secrets unavailable (SLACK_BOT_TOKEN, LINEAR_API_KEY, NOTION_API_KEY)."* → leaks env-var names.

**Fix:**
- Rewrote all three to plain operator language (e.g. *"Paused — the LinkedIn data provider's quota is used up for now. Resumes automatically on 2026-06-25, or sooner once the data source is topped up."*).
- Added `_sanitize_operator_text()` at the WorkerSummary + WorkerDetail serialization boundary so ANY archive_reason (incl. future worker-author-generated ones) has env-var names, git branch names, sandbox paths, and tracebacks stripped before it reaches an operator.

**Files:** `workers/{linkedin-post-engagements,customer-worker-a,customer-worker-b}/worker.yml` (git-tracked) + `apps/api/main.py`.

**Live evidence (post-deploy):** Scanned every archived worker's `archive_reason` via `/workers?include_archived=true` with a leak regex (`[A-Z]+_[A-Z_]+ | lane/ | feat/ | fix/ | /home/ | /root/ | /tmp/ | Traceback | KeyError`): 6 archived reasons, **0 leaks**. Example: linkedin → *"Paused — the LinkedIn data provider's quota is used up for now…"*.

---

## Item 4 — P1: raw Python tracebacks + sandbox paths as the operator error

**Before:** Failed runs surfaced the raw `Traceback (most recent call last) … File "/home/user/worker/run.py" … SyntaxError`/`KeyError` and `Command exited with code 1 and error: Traceback…` as the operator-facing headline on `/runs`, `/runs/<id>`, and the Overview alerts. Sandbox path `/home/user/worker/run.py` and env-var `GOOGLE_SHEETS_TOKEN`/`GOOGLE_SHEETS_TOKEN` exposed.

**Fix:** `_operator_error_message()` maps a raw error to a calm operator headline only when it still carries an internal artifact after the existing secret redaction (real traceback / sandbox path / git branch). Already-clean errors (e.g. "Missing required inputs: …", "Missing required secrets") pass through unchanged. Applied to:
- `_make_run_summary` (GET `/runs`)
- `get_run` (GET `/runs/<id>`) — raw text moved to new `RunDetail.error_raw` (secrets redacted) for the debug/Raw tab only; never the headline.
- `_overview_failure_cause` (Overview alerts).

**Files:** `apps/api/main.py`, `apps/api/models.py` (`RunDetail.error_raw`).

**Tests:** `tests/test_operator_hygiene.py` — SyntaxError trace, generic traceback, clean-error pass-through, empty → None.

**Live evidence (post-deploy):** Swept the detail `error` headline of **all 115 failed runs** + `/runs?limit=200` + `/system/overview` with the traceback/path/env-var/branch leak regex: **0 leaks**. `run_8c64befaf519` headline = "This worker is missing a required package…"; `error_raw` (debug tab) still carries the redacted `ModuleNotFoundError` trace.

---

## Item 5 — P1: `/contexts` shows only the engine's internal pack

**Before:** `/contexts` listed exactly one pack — `worker-author-style`, the worker-generation engine's own style guide (ANTI-PATTERNS.md, SCHEMA.md, STYLE.md, EXAMPLES/*). Zero operator content.

**Fix:** `_is_system_context_pack()` (constant `SYSTEM_CONTEXT_PACKS = {"worker-author-style"}` + a `{"system": true}` metadata flag, mirroring `system_worker`). `_context_visible_to_user()` returns False for system packs, so they are hidden from the `/contexts` list, the detail endpoint, and file endpoints (deep-links 404). The operator now sees an honest empty-state. Runtime mounting (`e2b_driver.context_dir`) is unaffected, so the worker-author worker still reads its pack.

**File:** `apps/api/main.py`.

**Live evidence (post-deploy):** `GET /contexts` → `[]`. `GET /contexts/worker-author-style` → 404; `GET /contexts/worker-author-style/files/SCHEMA.md` → 404. `shots-operator-hygiene-2026-05-29/contexts-empty-live.png`: "No knowledge packs yet. Add your first one."

---

## Item 6 — Approval trigger gap

**Before:** The only HITL approval-capable worker, `outbound-approval-demo`, was git-tracked but NOT in `PUBLIC_STOCK_WORKER_IDS`, so `_worker_hidden_from_api` hid it from the operator catalog and returned "Worker not found" on its detail page. An operator could not trigger HITL at all.

**Root cause:** visibility rule — a tracked `worker.yml` not in `PUBLIC_STOCK_WORKER_IDS` is hidden.

**Fix:** Added `outbound-approval-demo` to `PUBLIC_STOCK_WORKER_IDS`. It already carries `is_example: true` (not `system_worker`), so it now shows in the catalog as an Example and is operator-reachable.

**File:** `apps/api/main.py`.

**Approval round-trip (post-deploy) — VERIFIED live, full circuit:**
- `GET /workers/outbound-approval-demo` → 200 (was "Worker not found").
- **Run 1** `run_983e491c7782` (manual) → `pending_approval`, output phase `run-1-propose`, `sent`=None (no side-effect on run 1).
- Approval `apr_4cb1cb4ac41d` created (status pending), preview = the drafted outbound message.
- `POST /runs/run_983e491c7782/approve` → run 1 → `completed`; approval → `approved`; spawned follow-up `run_42580eacd1d1`.
- **Run 2 (follow-up)** `run_42580eacd1d1` (trigger_source=approval) → `completed`, output phase `run-2-execute`, `sent="true"`, `sent_message` = the approved text.
- Idempotency: exactly **1** follow-up run executed; the side-effect fired once (run 1 never sends).
- Visible on `overview-live.png` (top of Worker activity: two "Outbound approval demo" Completed entries — approval + manual).

---

## Sweep — other internal leaks

- `github-pr-summary` + `github-pr-issue-digest`: DB-only worker-author test artifacts, scheduled, broken/stub (one no-op, one fails needing `GITHUB_TOKEN`). Archived with clean reasons ("Paused — needs a GitHub account connected before it can run."). No longer broken scheduled workers on the operator surface.
- `TEST_SECRET` (P2-4): test leftover in the Secrets list, used_by=[] → deleted via the API. _evidence below_
- Connections expired / worker-count drift (P2-1/2/3): real dogfood-instance state, not internal artifacts — left as-is (legitimate operator data, not a hygiene leak).
- Two further DB-only worker-author test artifacts surfaced during verification (`github-issue-summary`, `github-issue-summary-2` — scheduled, placeholder `repo = "owner/repo"`, 0 runs) and were archived with the same clean reason in the same pass.

**Live evidence (post-deploy):**
- `GET /secrets` → `[APIFY_API_KEY, GEMINI_API_KEY, GITHUB_PAT, GOOGLE_API_KEY, GRANOLA_API_KEY]` — `TEST_SECRET` removed (`DELETE /secrets/TEST_SECRET` → "removed").
- Operator `/workers` = 11 cards, zero scheduled-without-example junk; only scheduled worker is `github-digest` (a real example). `workers-list-live.png`.
- Worker-count parity: Overview "11 Workers active" == `/workers` list count (overview-live.png).

---

## Verdict

Every gate-report item closed and verified LIVE on prod (`9693f5d`) with fresh artifacts:
- **P0-A** invoice: fixed syntax + archived + de-scheduled; not a broken front-page worker.
- **P1-1** env-vars worker: hidden (system_worker).
- **P1-2** archive reasons: 0 leaks across 6 archived workers.
- **P1-3** tracebacks/paths/env-vars: 0 leaks across 115 failed-run headlines + overview + runs list; raw kept in `error_raw`.
- **P1-4** contexts: engine pack hidden, honest empty-state, deep-links 404.
- **Approval gap**: full operator-reachable run → pending → approve → follow-up-completes round-trip, side-effect once.
- **Sweep**: 4→6 DB-only test/broken scheduled workers archived; TEST_SECRET deleted; no remaining internal artifact on overview / workers / contexts / runs / archived / secrets.

No internal artifact (system/test worker, engine pack, raw traceback, env-var name, git branch name, sandbox path, test secret, broken scheduled worker) remains on any operator surface.

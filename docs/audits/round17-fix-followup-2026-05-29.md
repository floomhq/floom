# Round-17 Referee Follow-up — the two genuinely-real fixes

**Date:** 2026-05-29
**Branch:** `fix/composio-execute-auth-and-csp-2026-05-29`
**Context:** The Round-17 reconciliation (`round17-reconciliation-2026-05-29.md`, written into
`/root/workeros` during that session) closed every P0/P1 as FALSE / by-design / already-fixed
and surfaced exactly two genuinely-real residuals plus one informational note. This doc records
fixing the two real items. Single-tenant OS is unaffected in behavior; both items matter before
the multi-tenant Cloud reuses this backend.

---

## FIX 1 (MEDIUM, multi-tenant teeth) — `POST /runs/{run_id}/composio-execute/{tool_slug}` owner-scoping

**File:** `apps/api/main.py` (`composio_execute_proxy`), `apps/api/db/sqlite.py` (`SqliteRunRepository.get_any`).

### Root cause
The endpoint is intentionally middleware-exempt (regex `_RE_RUN_COMPOSIO_PROXY`) so a worker's
`run.py` inside the E2B sandbox can proxy a Composio call back, authorized by possession of a live
`run_id`. Two real defects in the connection fallback:

1. It read the owner from `run_row.get("user_id")`, but the **`runs` table has no `user_id`/`owner_id`
   column** — the owner lives on `workers.owner_id` (confirmed against the live schema). So `owner_id`
   was always empty and never used.
2. The fallback query was `SELECT composio_connection_id FROM composio_connections WHERE app_name = ?
   AND status = 'active' LIMIT 1` — **"first active connection for the app", with no owner scoping.**
   In multi-tenant Cloud, owner A's running worker could resolve owner B's connected account.

### Fix (root cause, not symptom)
- Derive the run **OWNER** from the run's worker: `repos.workers.get_any(worker_id=run.worker_id).owner_id`.
- Replace the raw unscoped SQL with the owner-scoped repo call `repos.connections.list(user_id=owner_id)`,
  filtered to `app_name == tool_prefix and status == "active"`. Connection lookup is now owner-scoped at
  the SQL layer (`WHERE user_id = ?`).
- Reject (404/403) when the run's worker or owner cannot be resolved.
- The RUNNING-status gate already rejects missing/garbage/terminal runs (the `run_id` is only a valid
  capability while the run is live).
- Documented `runs.get_any()` as **unscoped / capability-and-internal-only** in `sqlite.py`. Verified its
  only callers are this callback (`main.py`) and background run-execution (`run_service.py:1103,2032,2385`);
  **no authed read endpoint uses it** (`get(user_id=...)` enforces `WHERE w.owner_id = ?`).

### Verification
- New tests (`tests/test_composio_execute_owner_scope.py`, 3/3 pass):
  - **owner-scoping**: owner A owns the run; owner B has an active gmail connection inserted FIRST. Proxy
    resolves `CONN_A_CORRECT`, never `CONN_B`. Single-tenant still executes. Proven the old `LIMIT 1` query
    returns the first-inserted (B) row, so the test genuinely catches the bug.
  - **invalid run_id** → 404, proxy never called.
  - **non-running run** → 403, proxy never called.
- `tests/test_connections_backend.py`: 27/27 relevant pass (1 unrelated pre-existing failure asserting
  `MAX(version)==36` while DB is now at migration 38 — sibling-lane drift, untouched by this change).

---

## FIX 2 (LOW) — CSP `script-src 'unsafe-inline'`

**File:** `apps/web/next.config.ts`.

### Decision: documented-and-left (NOT tightened)
A nonce-based CSP in Next.js 16 app-router requires a per-request `middleware.ts` that produces the CSP
header with a fresh nonce; Next only nonces its own inline bootstrap/flight scripts when the header arrives
that way. This app ships **no middleware** and relies on static/ISR rendering. Adding nonce middleware forces
every route to dynamic rendering and risks hydration regressions — disproportionate risk for a LOW finding on
a single-tenant OS, and the brief's decision rule is explicit: do not break a working app for a LOW item.

Left `'unsafe-inline'` with a clear in-code rationale + `TODO(cloud-ga)` to switch to a per-request nonce
(or `strict-dynamic` + hashes) before the multi-tenant Cloud serves untrusted-tenant content. `style-src`
unchanged. Live site verified loading (HTTP 200, `_next/static` served, CSP header present).

**Residual (honest):** `script-src 'unsafe-inline'` remains a defense-in-depth weakness; acceptable for
single-tenant MVP, must be nonce-tightened before Cloud GA.

---

## Informational (no change)
`repos.runs.get_any()` is unscoped by design; now documented and confirmed off all authed read paths.

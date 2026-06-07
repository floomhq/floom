# S47 — HITL via approval-page + respawn (NovaSearch requirement)

**Date:** 2026-05-29
**Author:** Claude
**Priority:** P0 — hard requirement for NovaSearch (customer #1). Recruiting workflows need a human approve/edit step before an outbound action.
**Dispatch timing:** AFTER the queue lane (adds `RunStatus.QUEUED` drain + status enum) and S37 (adds conversations migration) land — both touch `run_service.py` status enum + the migration list, so dispatching HITL in parallel races migration numbers + enum merges. Sequence behind them.

## The decided design (Federico, 2026-05-29 — verbatim)

> "No worker suspension. Workeros runs are single-thread, start-to-finish. So HITL can't pause and resume in place. Handled by design: worker exits with a marker, approval page records decision, a fresh run is spawned with the decision as input. Constraint: each worker must be idempotent/re-entrant."

This is the **two-run** model. Confirmed correct by investigation: the E2B sandbox is stateless between invocations, so thread-suspension is not viable; respawn-with-decision is the clean path. No change to the single-thread execution model.

## Investigation findings (the ground truth this builds on)

- Run execution: `execute_run()` @ `apps/api/run_service.py:963`, one `threading.Thread` per run, blocking `driver.run()`. No suspend/resume primitive. ✅ matches claim.
- Run status enum: `apps/api/models.py:27-31` — only QUEUED/RUNNING/COMPLETED/FAILED. `APPROVED/REJECTED/PENDING_APPROVAL` were removed in commit `80b8947` (migration 15).
- Approvals table: created migration 1 (`_legacy_sqlite.py:574`), `reason` added migration 6, **DROPPED migration 15** (`_legacy_sqlite.py:707`, commit `80b8947` "#29 scope cut").
- Result protocol: run writes `result.json` = `{status: success|error, outputs:{}, error}` (`e2b_driver.py:604`). No "needs decision" signal today — this brief adds one.
- Dead leftovers to clean/reuse: `runs.approval_status` column still in live DB (written `"not_required"`); `main.py:922,1069-1074` legacy status shims; `approvals: required: false` ignored field in many worker.yml; settings copy mentions approvals.

## Original approvals schema (reconstructed from git — restore this)

```sql
CREATE TABLE IF NOT EXISTS approvals (
    id          TEXT PRIMARY KEY,
    run_id      TEXT NOT NULL,    -- FK -> runs(id) ON DELETE CASCADE
    worker_id   TEXT NOT NULL,    -- FK -> workers(id) ON DELETE CASCADE
    status      TEXT NOT NULL,    -- 'pending'|'approved'|'rejected'
    label       TEXT,
    preview     TEXT,
    created_at  TEXT NOT NULL,
    decided_at  TEXT,
    reason      TEXT              -- added migration 6
);
```
Extend it for the respawn model:
```sql
    decision_input_json TEXT,     -- the inputs to spawn the follow-up run with
    edited_output_json  TEXT,     -- operator edits to the proposed output (optional)
    follow_up_run_id    TEXT,     -- the run spawned on approval
    owner_id            TEXT NOT NULL  -- scope to the workspace (see S-workspace note)
```

## What to ship

### 1. worker.yml schema — resurrect the `approvals` field (currently ignored)
```yaml
approvals:
  required: true            # default false
  label: "Approve outbound email"   # shown on the approval card
```
Add to `WorkerContract`/`WorkerConfig` (it's parsed-and-ignored today, so existing files won't break).

### 2. Decision marker — the run signals "needs a human"
A worker that needs approval ends its run by writing a decision marker into `result.json`:
```json
{ "status": "success",
  "outputs": { ... the proposed action ... },
  "decision_required": { "label": "Approve outbound email", "preview": "<human-readable summary>" } }
```
`execute_run()`: if `decision_required` present AND the worker declares `approvals.required` → land the run as `PENDING_APPROVAL` (new enum value), create an `approvals` row with `status='pending'`, `preview`, and `decision_input_json` = the inputs needed to re-run with the decision. Do NOT mark COMPLETED.

### 3. Run status enum
Add `RunStatus.PENDING_APPROVAL = "pending_approval"` back to `models.py`. Reuse the existing `runs.approval_status` column as the active field (`not_required|pending|approved|rejected`). The dead status shims in `main.py:922,1069-1074` can now map to real values again — verify they don't conflict.

### 4. Backend endpoints
- `GET /approvals?status=pending` — list pending approvals scoped to `owner_id`
- `POST /runs/{run_id}/approve` — body `{ edited_output?: {} }`. On approve: mark approval `approved`, set `decided_at`; **spawn a fresh run** of the same worker with `inputs = decision_input_json merged with {decision:"approved", approved_output: edited_output||proposed}`; store `follow_up_run_id`. The original run stays terminal at PENDING_APPROVAL→(approved).
- `POST /runs/{run_id}/reject` — body `{ reason?: str }`. Mark `rejected`, no follow-up run.
- SSE: broadcast decision via the existing `_publish_sse` hook so any open UI updates live.

### 5. Approval page (frontend)
- New route `apps/web/app/approvals/page.tsx` — list of pending approval cards: worker name, label, preview (markdown), Approve / Edit-then-approve / Reject. ChatGPT-simplicity bar (no nested cards, single blue accent, sentence case).
- Surface a count badge in the sidebar nav + the /overview AlertsBell ("N awaiting approval").
- A run at PENDING_APPROVAL on `/runs/[id]` shows the decision card inline + the same actions.
- After approve, link to the follow-up run.

### 6. Idempotency note (the constraint Federico flagged)
Document in docs/AUTHORING.md: a worker that uses `approvals.required` MUST be re-entrant — the post-approval run re-executes from scratch with the decision as input, so the worker must (a) not double-send the side-effect it proposed (the FIRST run proposes, the SECOND run executes), and (b) read `inputs.decision` / `inputs.approved_output` to perform the approved action. Pattern: run 1 = "draft + propose", run 2 = "execute the approved draft". Provide one example worker (`outbound-approval-demo`) showing the two-phase pattern end-to-end.

## Workspace note (requirement #2 — NOT a build, a decision)
Investigation confirms ownership is a raw `owner_id TEXT DEFAULT 'federico'` string; no workspace table. "Collapse workspace = owner_id:novasearch" is just `WORKEROS_USER_ID=novasearch` at deploy time for the NovaSearch instance (single-tenant OS). **Do not flip Federico's dogfood instance** — that would hide his `federico`-owned workers (and secrets, due to the `_SECRET_PREFIX` transform at `sqlite.py:52`). The real multi-tenant workspace primitive is parked until customer #2 (~3-day build). The `approvals.owner_id` column added above keeps HITL forward-compatible with that.

## Verification gate
- [ ] Worker with `approvals.required:true` emitting `decision_required` lands PENDING_APPROVAL, creates a pending approval row, does NOT complete.
- [ ] `GET /approvals` lists it scoped to owner.
- [ ] Approve → follow-up run spawns with the decision as input, executes the approved action, original approval row → approved with `follow_up_run_id` set.
- [ ] Reject → no follow-up run, approval row → rejected with reason.
- [ ] `outbound-approval-demo` worker proves the two-phase (propose → approve → execute) flow end-to-end on prod, with the side-effect happening exactly once.
- [ ] Sidebar/AlertsBell shows the pending count.

## Anti-patterns
- Do NOT try to suspend a running thread / keep the E2B sandbox warm. Two-run respawn only.
- Do NOT auto-approve. A missing decision = stays pending.
- Do NOT let the FIRST run perform the real side-effect. First run proposes; approved run executes.
- Do NOT regress the queue lane's QUEUED status or S37's conversations migration — rebase on whatever migration number is current after they land.

## Status file
Append to `/root/workeros/.codex-logs/s47-hitl-status.md`.

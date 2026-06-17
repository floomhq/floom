# Approval Model

Workeros approvals are a human-in-the-loop pause, not an error state.

## When a Run Pauses

A run enters `pending_approval` when the worker declares `approvals.required: true`
or when an internal tool creates a destructive-action approval. At that point:

- The initial run has already executed far enough to produce a preview.
- Side effects that require approval have not been finalized.
- The run stays visible in `/runs` with status `pending_approval`.
- A matching row is created in `/approvals`.

Agent-mode workers use the approval gate after the agent has produced the
proposed final output. Script-mode workers use the approval contract in the
worker manifest and runtime output path.

## Two-Phase Side-Effect Contract (#418)

For a worker with `approvals.required: true`, the engine guarantees the worker
runs in exactly one of two phases and stamps an authoritative `decision` value
onto its inputs **before execution**:

- **Propose phase** — `decision == "proposed"`. Every run that is not an
  engine-spawned post-approval run. The worker MUST draft its action and emit
  `decision_required` and MUST NOT fire any side effect.
- **Execute phase** — `decision == "approved"`. Only the follow-up run the
  engine spawns after an owner approves. `approved_output` carries the
  (optionally edited) proposed output. The worker fires the side effect here,
  exactly once.

The phase is determined authoritatively from the approval record
(`follow_up_run_id`), never from caller-supplied inputs or `trigger_source`. A
caller cannot bypass the gate by sending `decision: "approved"` — the engine
overrides it to `"proposed"` for any non-approved run, and strips
`approved_output`. Worker rule: **branch on `decision == "approved"` to act;
treat everything else as propose. Never fire a side effect unless
`decision == "approved"`.**

## Owner Review Flow

`GET /approvals` returns pending approval rows for the authenticated owner. The
response is intentionally scoped by `x-floom-secret` / the active workspace
identity and does not expose another owner's approvals.

The owner decides through:

- `POST /runs/{run_id}/approve`
- `POST /runs/{run_id}/reject`

Approving a run records the approval decision, moves the original run out of
`pending_approval`, and starts the approved follow-up execution when the worker
needs a second phase to perform the side effect. Rejecting records the rejection
reason and marks the original run failed with an approval rejection code.

Both endpoints reject already-decided approvals with `409` and return `404` when
no matching pending approval exists.

## Signed Public Review Links

Some approval rows include a signed public review link for external reviewers.
Those routes are token-gated and do not require the owner's `x-floom-secret`:

- `GET /approvals/public/{approval_id}?token=...`
- `POST /approvals/public/{approval_id}/approve?token=...`
- `POST /approvals/public/{approval_id}/reject?token=...`

Public approval responses use a strict allow-list. They do not include owner ids,
raw secrets, internal API credentials, or unrelated workspace data.

## Destructive Actions

Workspace-agent destructive actions use approval rows with a decision payload.
They are decided through:

- `POST /approvals/{approval_id}/approve-action`
- `POST /approvals/{approval_id}/reject-action`

These endpoints are owner-authenticated. They reject normal run approvals, and
the run approval endpoints reject destructive-action approvals, keeping the two
decision models separate.

## Operational Notes

`GET /approvals/count` returns the pending badge count for navigation. The count
and list are both derived from pending approval rows. After approve or reject,
the approval row is no longer pending, so both the badge and list drop the item.

Approval wait time is not counted as execution duration. The run duration is
captured when the worker parks for approval and is preserved after the later
decision.

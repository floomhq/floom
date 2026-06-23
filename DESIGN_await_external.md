# Await External Design Note

Issue: floomhq/floom#1915

## Current Suspend Signal

Script and agent drivers return a `WorkerResult` parsed from `result.json`. The
existing run-level suspend signal is `decision_required`, defined on
`WorkerResult` in `apps/api/models.py`. In `apps/api/run_service.py`,
`execute_run()` inspects `result.decision_required` after the sandbox returns.

For workers with `approvals.required: true`, `decision_required` parks the run by:

- creating a row in `approvals` with `status='pending'`;
- storing the original inputs in `approvals.decision_input_json`;
- storing the proposed outputs in `runs.output_json`;
- setting the run row to `status='pending_approval'`.

The parked DB state is therefore:

- `runs.status = 'pending_approval'`;
- one pending `approvals` row linked by `approvals.run_id`;
- `approvals.decision_input_json` is the source used to rebuild the next phase's inputs.

`pending_approval` is also treated as a stopped state by the executor guard in
`execute_run()` and by serializers in `apps/api/services/run_serialize.py`.

## Current Approval Resume

Human approval does not continue the same process. The original sandbox process
has already exited after emitting `decision_required`.

`POST /runs/{run_id}/approve` in `apps/api/routers/approvals.py`:

1. loads the pending run and pending approval row;
2. parses the original inputs from `approval.decision_input_json`;
3. merges `decision='approved'` and `approved_output`;
4. atomically flips the approval row from `pending` to `approved`;
5. marks the original pending run `completed`;
6. creates a new follow-up run with `trigger_source='approval'`;
7. attaches that follow-up run id to `approvals.follow_up_run_id`;
8. queues the follow-up run.

The resumed phase receives its decision through the follow-up run's
`runs.input_json`. `_is_engine_approved_execution_run()` treats the approved
approval row's `follow_up_run_id` as the authoritative signal that the follow-up
run is the human-approved execute phase.

## Current Webhook Auth And Run Creation

`POST /webhooks/{worker_id}` in `apps/api/main.py` authenticates using either:

- query token: `token=<derived token>`, verified by
  `webhook_service.verify_webhook_token()`;
- HMAC signature header: `X-Floom-Signature` or `X-Workeros-Signature`, verified
  by `webhook_service.verify_signature()`.

The HMAC scheme is:

- stored secret material is the worker's webhook secret hash;
- header format is `sha256=<hex digest>`;
- digest is `HMAC-SHA256(key=<secret_hash>, message=<raw request body>)`.

After auth, the existing webhook path parses the request body as JSON inputs and
creates a new unrelated run with `trigger_source='webhook'`. It may tag the
specific trigger row via `trigger_ref`, but it does not resume a parked run.

## Minimal Await External Slice

Add a sibling worker-output signal:

```json
{
  "await_external": {
    "key": "correlation-key",
    "label": "Audit job",
    "timeout_seconds": 3600
  }
}
```

When a worker returns this, the engine parks the run in the existing
`pending_approval` state and creates an `approvals` row as the durable wait
record. The row is typed with `decision_input_json.kind = 'await_external'` and
stores both the original inputs and the await metadata. This reuses the
approval expiry/reaper mechanics without showing the row as a human approval or
letting human approval endpoints decide it.

Add `POST /webhooks/{worker_id}/resume`, authenticated with the same per-worker
webhook token/HMAC rules as `POST /webhooks/{worker_id}`. The endpoint:

1. verifies token or HMAC;
2. parses the JSON body;
3. finds a pending `await_external` row for that worker by `key`, or by explicit
   `run_id` plus `key`;
4. atomically flips that wait row to `approved`;
5. marks the original parked run completed;
6. creates a linked follow-up run with original inputs plus
   `external_result=<posted result>`;
7. attaches the follow-up run id and queues it.

This is intentionally the same lineage model as human approval, not a live
process continuation. A future refactor could express human approval as one
source of the generalized await primitive, but that is out of scope here.

## Safety Notes

External wait rows must not authorize an `approvals.required` worker's
human-approved execute phase. `_is_engine_approved_execution_run()` therefore
needs to treat ordinary run approval rows as human authorization and ignore
`kind='await_external'` rows.

Human approval routes must reject typed `await_external` rows, even if they are
somehow visible to an operator.

The operator approval surfaces (`/approvals`, `/approvals/count`, and the chat
approval listing tool) filter pending `await_external` rows so a machine wait is
not presented as a human action item.

The existing `POST /webhooks/{worker_id}` behavior remains unchanged: it still
creates a new webhook-triggered run and, when configured, validates the same
query token or `X-Floom-Signature` / `X-Workeros-Signature` HMAC header. The new
`POST /webhooks/{worker_id}/resume` path shares that auth helper but resolves a
pending wait row instead of creating an unrelated webhook run.

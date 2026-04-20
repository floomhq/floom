# Triggers

Fire a Floom app run from the outside world, automatically.

Two shapes, one system:

| Shape | Dispatcher | When to use |
|---|---|---|
| **Schedule** | cron expression in UTC or an IANA timezone | "Every Monday at 9am", "every 5 minutes", "first of the month" |
| **Webhook** | public URL + HMAC-SHA256 signature | "When a GitHub issue opens", "when Stripe sends a `charge.succeeded`", "when my internal system has news" |

Triggers and runs share the same job queue, so retries, timeouts, and the outgoing completion webhook behave identically whether the run was started by a button click, a cron, or an inbound event.

---

## Scheduled runs

> Example: run an app every Monday at 9am Berlin time.

### Create

```bash
curl -X POST https://floom.dev/api/hub/my-weekly-report/triggers \
  -H "Authorization: Bearer $FLOOM_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
        "action": "run",
        "inputs": { "week_of": "this" },
        "trigger_type": "schedule",
        "cron_expression": "0 9 * * 1",
        "tz": "Europe/Berlin"
      }'
```

Response:

```json
{
  "trigger": {
    "id": "tgr_3p8q2wmz6k1v",
    "app_slug": "my-weekly-report",
    "action": "run",
    "trigger_type": "schedule",
    "cron_expression": "0 9 * * 1",
    "tz": "Europe/Berlin",
    "next_run_at": 1745478000000,
    "enabled": true
  }
}
```

### Cron expression reference

Floom uses the standard 5-field crontab: `minute hour day-of-month month day-of-week`. A handful of common shapes:

| Expression | Reads as |
|---|---|
| `* * * * *` | every minute |
| `*/5 * * * *` | every 5 minutes |
| `0 * * * *` | top of every hour |
| `0 9 * * *` | 09:00 every day |
| `0 9 * * 1` | 09:00 every Monday |
| `0 9 1 * *` | 09:00 on the 1st of every month |
| `0 9,17 * * 1-5` | 09:00 and 17:00 on weekdays |

Timezone-aware: the `tz` field is an IANA zone like `Europe/Berlin`, `America/New_York`, or `UTC` (the default). DST transitions are handled by [`cron-parser`](https://www.npmjs.com/package/cron-parser); a `0 9 * * *` trigger with `tz: 'Europe/Berlin'` fires at 09:00 local time both before and after the spring-forward cutover.

### Drift + catch-up

If the server was down when a scheduled fire time passed, Floom applies a simple catch-up rule:

- **drift ≤ 1 hour** — fire once, advance `next_run_at` to the next valid cron time.
- **drift > 1 hour** — skip the missed fire and reset `next_run_at` to the next valid cron time **after now**. No catch-up storm.

### Disable / enable

```bash
curl -X PATCH https://floom.dev/api/me/triggers/tgr_3p8q2wmz6k1v \
  -H "Authorization: Bearer $FLOOM_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "enabled": false }'
```

Disabling leaves the row in place; the scheduler skips it until re-enabled.

---

## Webhook triggers

> Example: run an app whenever a GitHub issue is opened.

### Create

```bash
curl -X POST https://floom.dev/api/hub/my-triage-app/triggers \
  -H "Authorization: Bearer $FLOOM_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
        "action": "run",
        "trigger_type": "webhook"
      }'
```

Response (**copy the secret now — it is never shown again**):

```json
{
  "trigger": {
    "id": "tgr_m9k7x2qz5p1r",
    "app_slug": "my-triage-app",
    "trigger_type": "webhook",
    "webhook_url_path": "a3f7c91e88b0d2f6",
    "enabled": true
  },
  "webhook_url": "https://floom.dev/hook/a3f7c91e88b0d2f6",
  "webhook_secret": "4a9b...e2d1",
  "webhook_url_path": "a3f7c91e88b0d2f6"
}
```

### Signature contract

Every incoming POST must carry:

```
X-Floom-Signature: sha256=<hex-encoded HMAC-SHA256 of the raw body with the webhook secret as key>
```

Optional:

```
X-Request-ID: <any stable id>   # 24h idempotency — replays return 200 { deduped: true }
```

### Responses

| Status | Meaning |
|---|---|
| `204 No Content` | Accepted. Job is enqueued; `Location` header points at it. |
| `200 OK` | Replay of an `X-Request-ID` we saw in the last 24h. No new job. |
| `401 Unauthorized` | Signature missing or invalid. No job. |
| `404 Not Found` | Unknown `webhook_url_path`. |
| `409 Conflict` | App was deleted or is not active. |

### Sign a payload — Node.js

```js
import { createHmac } from 'node:crypto';

const secret = process.env.FLOOM_WEBHOOK_SECRET;
const body = JSON.stringify({ inputs: { event: 'issue.opened', number: 42 } });
const sig = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');

await fetch('https://floom.dev/hook/a3f7c91e88b0d2f6', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Floom-Signature': sig,
    'X-Request-ID': `issue-42-${Date.now()}`,
  },
  body,
});
```

### Sign a payload — Python

```python
import hashlib, hmac, json, os, time, requests

secret = os.environ['FLOOM_WEBHOOK_SECRET'].encode()
body = json.dumps({'inputs': {'event': 'issue.opened', 'number': 42}})
sig = 'sha256=' + hmac.new(secret, body.encode(), hashlib.sha256).hexdigest()

requests.post(
    'https://floom.dev/hook/a3f7c91e88b0d2f6',
    headers={
        'Content-Type': 'application/json',
        'X-Floom-Signature': sig,
        'X-Request-ID': f'issue-42-{int(time.time())}',
    },
    data=body,
)
```

### Sign a payload — curl

```bash
BODY='{"inputs":{"event":"issue.opened","number":42}}'
SIG="sha256=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$FLOOM_WEBHOOK_SECRET" -hex | awk '{print $2}')"
curl -X POST https://floom.dev/hook/a3f7c91e88b0d2f6 \
  -H "Content-Type: application/json" \
  -H "X-Floom-Signature: $SIG" \
  -H "X-Request-ID: issue-42-$(date +%s)" \
  -d "$BODY"
```

### Passing inputs

The body can carry a top-level `inputs` object to override what was stored with the trigger at creation time:

```json
{ "inputs": { "issue_number": 42, "urgency": "high" } }
```

If the body has no `inputs` key (or is not JSON), the stored inputs are used as-is. This lets you create a trigger with default inputs and then override per-event.

---

## Outgoing webhook on completion

When the job finishes, Floom POSTs the result to your app's `webhook_url` (if set). Trigger context is included so you can branch on origin:

```json
{
  "job_id": "job_8k2p9wzm7q1v",
  "slug": "my-triage-app",
  "status": "succeeded",
  "output": { "triaged": true, "label": "bug" },
  "error": null,
  "duration_ms": 1832,
  "attempts": 1,
  "triggered_by": "webhook",
  "trigger_id": "tgr_m9k7x2qz5p1r"
}
```

`triggered_by` is one of `'schedule'`, `'webhook'`, or `'manual'`. Absent `triggered_by` (older deployments) means `'manual'`.

---

## Rotate or revoke a webhook secret

There is no in-place rotation today. To rotate: delete the trigger (`DELETE /api/me/triggers/:id`) and create a fresh one. The old URL path + secret are gone immediately; in-flight deliveries signed against the old secret will 401.

---

## Limits + guarantees

- **Schedule granularity.** The scheduler polls every 30s. A cron set to `* * * * *` fires once per minute, not once per 30s.
- **Webhook body size.** The ingress reverse proxy caps at 1MB. Cron jobs have no body.
- **Concurrency.** Each tick, every ready trigger fires at most once (atomic `next_run_at` advance). Multiple replicas are safe — the claim race is resolved by the DB.
- **Ordering.** No guaranteed ordering between triggers that fire in the same tick; they're enqueued independently.
- **At-most-once vs at-least-once.** Webhook receivers (your Floom app) should be idempotent: retries on 5xx are allowed, and if you return a 5xx we treat it as transient.

---

## Reference

- Protocol spec: [spec/protocol.md §8](../spec/protocol.md#8-triggers)
- Source: [`routes/triggers.ts`](../apps/server/src/routes/triggers.ts), [`routes/webhook.ts`](../apps/server/src/routes/webhook.ts), [`services/triggers.ts`](../apps/server/src/services/triggers.ts), [`services/triggers-worker.ts`](../apps/server/src/services/triggers-worker.ts)
- Tests: [`test/stress/test-triggers-schedule.mjs`](../test/stress/test-triggers-schedule.mjs), [`test/stress/test-triggers-webhook.mjs`](../test/stress/test-triggers-webhook.mjs)

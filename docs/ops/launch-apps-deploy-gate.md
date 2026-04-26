# Launch Apps Deploy Gate

## Purpose

Issue #691 surfaced a silent regression mode where launch apps could return
`dry_run: true` (and model `"dry-run"`) after deploy, while container health
still looked green.

`scripts/ops/launch-apps-real-run-gate.sh` closes that gap by running real
post-deploy app calls and blocking the rollout if any launch app is in
dry-run mode or exceeds the API latency budget.

## What the gate checks

The gate runs against these slugs:

- `lead-scorer`
- `competitor-lens`
- `ai-readiness-audit`
- `pitch-coach`

For each slug it:

1. `POST /api/run` with a real payload.
2. Polls `GET /api/run/:id` until terminal.
3. Asserts terminal status is success.
4. Asserts output is live-run, not fallback:
   - `dry_run` is `false` (top-level or `meta.dry_run`)
   - `model` is not `"dry-run"` (top-level or `meta.model`)
5. Asserts run latency is within budget (default `30_000ms`).

The script exits non-zero if any app fails.

## When it runs

The gate runs inside both deploy scripts after health-check succeeds and before
marking deploy successful:

- `scripts/ops/floom-deploy-preview.sh` (base `http://127.0.0.1:3052`)
- `scripts/ops/floom-deploy-prod.sh` (base `http://127.0.0.1:3051`)

Deploy success is now `health-check + launch-app gate`.

## Rollback interaction

If the gate fails, deploy scripts route into the existing rollback path (same
path used by health-check failures):

- restore compose backup
- `docker compose up -d --no-deps <service>`
- verify rollback health endpoint

No separate rollback mechanism was added; the gate plugs into the existing
Defense Layer 3 rollback behavior already present in deploy scripts.

## Add a new launch app to the gate

Update these places together:

1. `scripts/ops/launch-apps-real-run-gate.sh`
   - append slug in `SLUGS=(...)`
   - add a real payload in `build_payload()`
2. `test/stress/test-launch-apps-no-dry-run.mjs`
   - include the slug in test fixtures/mock outputs
3. This doc (`docs/ops/launch-apps-deploy-gate.md`)
   - update the tracked launch slug list

## Debug a gate failure

1. Re-run the gate manually against preview/prod base URL:

```bash
# Preview
bash scripts/ops/launch-apps-real-run-gate.sh --base-url http://127.0.0.1:3052

# Prod
bash scripts/ops/launch-apps-real-run-gate.sh --base-url http://127.0.0.1:3051
```

2. Inspect deploy logs:

- `/var/log/floom-deploy-preview.log`
- `/var/log/floom-deploy-prod.log`

3. Inspect the failing run payload directly:

```bash
curl -sS http://127.0.0.1:3052/api/run/<run_id> | jq .
```

4. Verify the runtime DB path (mounted volume), not stale host-local path:

- runtime DB: `/var/lib/docker/volumes/floom-chat-deploy_floom-chat-data/_data/floom-chat.db`
- in-container path: `/data/floom-chat.db`

5. If the row shows `dry_run=true` or `model="dry-run"`, verify `GEMINI_API_KEY`
   presence in the running container environment and in seeded global secrets.

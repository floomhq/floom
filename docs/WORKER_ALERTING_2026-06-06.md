# Worker Alerting 2026-06-06

PR: #483

## What Fires

- Registered worker alerts from `POST /workers/{id}/alerts` now fire from the central run outcome path when a run is marked `completed` or `failed`.
- A failed terminal status also runs the consecutive-failure incident check immediately. When a non-manual, enabled worker reaches the threshold, Workeros opens a `consecutive_failures` incident and notifies through the existing alerting channel.
- `/system/overview` now includes a `needs_attention` item with `type: "consecutive_failures"` once a worker has reached the threshold. The item includes the count, last failed time, error code, cause, and the existing worker action URL.

## Defaults

- `WORKEROS_ALERT_ENABLED=true`
- `WORKEROS_ALERT_CONSECUTIVE_FAILURES=3`
- `WORKEROS_ALERT_POLL_TICKS=5`
- `WORKEROS_ALERT_SUCCESS_RATE_THRESHOLD=0.5`
- `WORKEROS_AUTO_PAUSE_ON_CONSECUTIVE_FAILURES` is off by default. When enabled, only automatic trigger sources (`schedule`, `scheduled`, `webhook`, `composio`, `trigger`) are paused after the configured consecutive-failure threshold.

## Notification Paths

- Per-worker alerts reuse the existing `WorkerAlert` rows and delivery code:
  - webhook URL
  - email recipients via Resend
- Consecutive-failure incidents reuse the existing `alerting.py` incident table and global alert notification path:
  - structured warning log
  - `WORKEROS_ALERT_EMAIL` when configured

## Notes

- The terminal run hook is centralized in `run_service.update_run_status`, so pre-driver failures, missing inputs/secrets/connections, schema failures, quality gate failures, driver failures, crashes, and completions all use one alert path.
- Existing manual-only workers are ignored by the incident checker to avoid noisy alerts for explicit operator test runs.

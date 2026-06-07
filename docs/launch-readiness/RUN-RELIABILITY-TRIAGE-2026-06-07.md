# Run Reliability Triage - 2026-06-07

Read-only investigation for #526. No live worker disables, fixes, or database writes were performed. Execution is gated on Wave 1 finishing.

## Scope And Evidence

- Brief: `/tmp/run-reliability-brief.md`
- Live API checks:
  - `GET https://workers-api.floom.dev/system/metrics`
  - `GET https://workers-api.floom.dev/system/alerts`
- Live DB checks:
  - SQLite opened read-only with `file:/root/workeros/data/floom.db?mode=ro`
  - Tables used: `runs`, `workers`, `skill_versions`, `alert_incidents`, `worker_alerts`, `logs`
- Verified live metric at query time:
  - `runs_7d=1,868`
  - `runs_failed_7d=1,684`
  - failure rate `90.1%`
  - `active_triggers=8`
  - 13 unresolved alert incidents

The brief cited `1,683 / 1,866`. The read-only API and DB now show `1,684 / 1,868`, which is the same launch-blocking condition with two additional runs and one additional failure.

## Top Failure Concentration

Window: runs created at or after `2026-05-31T04:00:50.086303+00:00`, matching the live `/system/metrics` seven-day window.

| Rank | Worker | Trigger | Enabled | Total runs | Failed | Failure rate | Latest run |
|---:|---|---|---:|---:|---:|---:|---|
| 1 | `slack-listener` | schedule `*/10 * * * *` | 0 | 853 | 853 | 100.0% | `2026-06-06T22:00:47.852785+00:00` |
| 2 | `whatsapp-listener` | schedule `*/10 * * * *` | 0 | 705 | 705 | 100.0% | `2026-06-06T21:38:56.173353+00:00` |
| 3 | `ai-news-discord-digest` | schedule `0 * * * *` | 1 | 205 | 110 | 53.7% | `2026-06-07T04:00:50.086303+00:00` |
| 4 | `worker-author` | manual | 1 | 24 | 3 | 12.5% | `2026-06-06T21:41:27.374621+00:00` |
| 5 | `github-slack-notification-digest` | schedule `0 9 * * *` | 1 | 3 | 3 | 100.0% | `2026-06-06T09:00:01.767040+00:00` |
| 6 | `ai-news-summary` | schedule `0 9 * * *` | 0 | 3 | 2 | 66.7% | `2026-06-02T09:00:40.027762+00:00` |
| 7 | `linkedin_engagements` | schedule `0 9 * * 2,5` | 1 | 2 | 2 | 100.0% | `2026-06-05T09:00:36.106795+00:00` |

The top two workers account for `1,558 / 1,684` failures, or `92.5%` of seven-day failures. The top three account for `1,668 / 1,684`, or `99.0%` of seven-day failures.

This is a small number of chronic scheduled failers, not broad runtime collapse.

## Failure Mode Counts

| Mode | Error code(s) | Failures |
|---|---|---:|
| Missing required input | `missing_required_input` | 929 |
| Missing connection/secret | `missing_secret` | 728 |
| E2B sandbox error | `e2b_sandbox_error` | 12 |
| Code/runtime error | `invalid_worker`, `agent_runtime_error`, `missing_result` | 10 |
| Interruption/cancel | `interrupted_by_restart`, `cancelled` | 3 |
| Uncoded | empty / null `error_code` | 2 |

Dominant exact fingerprints:

| Failures | Worker | Error code | Error sample |
|---:|---|---|---|
| 850 | `slack-listener` | `missing_required_input` | `Missing required input: channel` |
| 705 | `whatsapp-listener` | `missing_secret` | `Missing secrets: COMPOSIO_API_KEY, WORKEROS_API_SECRET, WORKEROS_API_BASE` |
| 76 | `ai-news-discord-digest` | `missing_required_input` | `Missing required input: discord_channel_id` |
| 18 | `ai-news-discord-digest` | `missing_secret` | `Missing secrets: NEWS_API_KEY, DISCORD_BOT_TOKEN` |
| 12 | `ai-news-discord-digest` | `e2b_sandbox_error` | E2B payment/path failures |
| 3 | `github-slack-notification-digest` | `missing_required_input` | `Missing required input: slack_channel` |
| 2 | `linkedin_engagements` | `missing_secret` | `Missing secrets: APIFY_API_KEY` |
| 2 | `worker-author` | uncoded | OpenAI rejected non-default `temperature=0.2` |

## Per-Worker Action List

| Worker | Classification | Proposed action after Wave 1 | Evidence |
|---|---|---|---|
| `slack-listener` | DISABLE / keep gated | Keep disabled until schedule has a saved `channel` value or the manifest default is wired into scheduled runs. Do not re-enable on Wave 1 without a successful manual run. | 853/853 failed; 850 are `Missing required input: channel`; DB currently has `enabled=0`; repo manifest has `paused: true`. |
| `whatsapp-listener` | DISABLE / keep gated | Keep disabled until `COMPOSIO_API_KEY`, `WORKEROS_API_SECRET`, and `WORKEROS_API_BASE` are available to the scheduled runtime and one manual run succeeds. | 705/705 failed; all are `missing_secret`; DB currently has `enabled=0`; repo manifest has `paused: true`. |
| `ai-news-discord-digest` | FIX or temporary DISABLE if Wave 1 cannot fix immediately | Fix scheduled input/default persistence for `discord_channel_id`, confirm `NEWS_API_KEY` and `DISCORD_BOT_TOKEN` are scoped to the scheduled owner, then investigate the 12 E2B errors. If not fixed before next launch-readiness score, pause temporarily. | 110 failures, 95 successes; latest runs are failing hourly; active schedule remains enabled. |
| `github-slack-notification-digest` | FIX or DISABLE | Save `slack_channel` for the scheduled instance, or pause until a channel is configured. | 3/3 scheduled failures, all `missing_required_input`. |
| `linkedin_engagements` | FIX or DISABLE | Add `APIFY_API_KEY` for the worker owner or pause the Tuesday/Friday schedule. | 2/2 scheduled failures, both `missing_secret`; current DB row remains enabled. |
| `ai-news-summary` | Already disabled | Leave disabled unless path/runtime issue is fixed and manually verified. | 2/3 failures; current DB row has `enabled=0`. |
| `worker-author` | FIX already mostly handled | Verify no new OpenAI `temperature=0.2` failures after the existing fix; treat the remaining restart interruption as deploy-window noise. | 3/24 failures; 2 old OpenAI temperature errors and 1 restart interruption. |

## Projected Failure-Rate Impact

Two projections are useful:

- `fix_failures`: assumes equivalent future volume and the listed worker failures become successes.
- `remove_runs`: assumes disabled scheduled loops stop generating attempts, so both numerator and denominator shrink.

| Top actions applied | Failure streams removed | fix_failures projected rate | remove_runs projected rate |
|---:|---:|---:|---:|
| Top 1 (`slack-listener`) | 853 | 44.5% | 81.9% |
| Top 2 (+ `whatsapp-listener`) | 1,558 | 6.7% | 40.6% |
| Top 3 (+ `ai-news-discord-digest`) | 1,668 | 0.9% | 15.2% |
| Top 5 (+ `worker-author`, `github-slack-notification-digest`) | 1,674 | 0.5% | 12.8% |
| Top 7 (+ `ai-news-summary`, `linkedin_engagements`) | 1,678 | 0.3% | 8.2% |

Recommendation: after Wave 1, keep the two already-disabled listener loops gated, fix or temporarily pause `ai-news-discord-digest`, and fix/pause `github-slack-notification-digest` plus `linkedin_engagements`. That removes or converts 1,678 of 1,684 observed failures. Under equivalent future traffic, the failure rate projects from `90.1%` to `0.3%`; if disabled loops are removed from the run denominator, the remaining observed failure rate projects to `8.2%`.

## Alerting Sanity Check For #483

Verified:

- `/system/alerts` returns 21 incident rows total.
- 13 rows are unresolved, matching the brief's "13 open incidents".
- The chronic failers are represented:
  - `slack-listener`: open `consecutive_failures`
  - `whatsapp-listener`: open `consecutive_failures`
  - `ai-news-discord-digest`: open `consecutive_failures` and `low_success_rate`
  - `github-slack-notification-digest`: open `consecutive_failures`
- Alerting is catching the DB incidents it was designed to catch.

Gap:

- `worker_alerts` has no URL or email destination configured for the open incident workers in this DB. Evidence supports "incidents are recorded and exposed by `/system/alerts`", but not "external notifications are delivered".
- Disabled workers with already-open incidents remain open until the alerting resolver sees recovery. This makes historical disabled loops continue to count as open incidents, which is accurate for unresolved triage but noisy for launch dashboards.

## Execution Gate

No live mutations were performed in this lane. After Wave 1 finishes:

1. Confirm the Wave 1 deploy is stable.
2. Re-run the read-only metrics query.
3. Apply the per-worker actions above in order.
4. Re-run `/system/metrics`, `/system/alerts`, and the read-only top-failer query.
5. Resolve #526 only after seven-day run reliability is no longer dominated by scheduled config loops and the open incident list has explicit ownership.

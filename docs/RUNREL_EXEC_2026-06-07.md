# Run Reliability Execution - 2026-06-07

## Scope

Wave 1 was deployed before this execution. Live SQLite writes were applied to `/root/workeros/data/floom.db` to stop chronic scheduled failures identified in #526/#547. No worker rows, run rows, logs, artifacts, or bundles were deleted.

Backup before writes:

```text
data/floom.db.runrel-20260607-0650.bak
```

The triage doc named in the brief, `docs/launch-readiness/RUN-RELIABILITY-TRIAGE-2026-06-07.md`, was not present in the live checkout used for execution. GitHub issue #526 and PR #547 contained the matching triage facts used for execution.

## Actions

| Worker | Pre-action state | Action | Re-enable requirement |
|---|---|---|---|
| `slack-listener` | Already `enabled=0`; normalized trigger disabled; stale worker/trigger `next_run_at` populated; YAML already `paused:true`. | Cleared worker `next_run_at`; cleared trigger `next_run_at`; mirrored DB manifest `paused:true`. | Configure a Slack channel/input path and required runtime secrets, then unpause intentionally. |
| `whatsapp-listener` | Already `enabled=0`; normalized trigger disabled; stale worker/trigger `next_run_at` populated; YAML already `paused:true`. | Cleared worker `next_run_at`; cleared trigger `next_run_at`; mirrored DB manifest `paused:true`. | Provide the WhatsApp/Composio/API runtime secret path, then unpause intentionally. |
| `ai-news-discord-digest` | `enabled=1`; schedule trigger enabled; next hourly run due; seven-day failures include missing `discord_channel_id`, missing `NEWS_API_KEY`/`DISCORD_BOT_TOKEN`, and E2B payment/bundle errors. | Set worker `enabled=0`; disabled normalized schedule trigger; cleared worker/trigger `next_run_at`; added `paused:true` to YAML; mirrored DB manifest `paused:true`. | Persist a real Discord channel ID, validate Discord/news secrets in the worker runtime, and restore E2B billing/runtime readiness. |
| `github-slack-notification-digest` | `enabled=1`; schedule trigger enabled; three daily failures from missing `slack_channel`. | Set worker `enabled=0`; disabled normalized schedule trigger; cleared worker/trigger `next_run_at`; added `paused:true` to YAML; mirrored DB manifest `paused:true`. | Persist a real Slack channel ID and verify GitHub/Slack connections. |
| `linkedin_engagements` | `enabled=1`; schedule trigger enabled; two scheduled failures from missing `APIFY_API_KEY`; YAML was already archived. | Set worker `enabled=0`; disabled normalized schedule trigger; cleared worker/trigger `next_run_at`; added `paused:true` to YAML; mirrored DB manifest `paused:true`. | Validate `APIFY_API_KEY` availability in the worker runtime before unpausing. |
| `ai-news-summary` | Already `enabled=0`; archived; two scheduled failures from path-traversal runtime errors before disable. | Kept disabled; disabled normalized schedule trigger; cleared worker/trigger `next_run_at`; added `paused:true` to YAML; mirrored DB manifest `paused:true`. | Fix bundle path/runtime resolution before unarchiving or unpausing. |

## Verification

Post-write target state:

```text
all six target workers: enabled=0
all six target normalized schedule triggers: enabled=0
all six target worker next_run_at values: NULL
all six target trigger next_run_at values: NULL
all six target DB manifests: paused=true
```

Manifest verification:

```text
slack-listener: paused:true
whatsapp-listener: paused:true
ai-news-discord-digest: paused:true
github-slack-notification-digest: paused:true
linkedin_engagements: archived:true, paused:true
ai-news-summary: archived:true, paused:true
```

Live API after action:

```json
{
  "workers_count": 99,
  "runs_total": 2485,
  "runs_7d": 1868,
  "runs_failed_7d": 1684,
  "active_triggers": 5
}
```

Read-only SQLite after action:

```text
all_runs_7d: 1869
all_failed_7d: 1684
all_failure_rate_pct: 90.10
active_runs_7d: 24
active_failed_7d: 5
active_failure_rate_pct: 20.83
disabled_chronic_failed_7d: 1675
observed_equiv_forward_failure_pct: 0.48
```

The API and SQLite seven-day denominators differ by one run at the time-window boundary. Both sources confirm the chronic scheduled loops are off. The historical seven-day rate remains high until old runs age out; the forward-looking observed-equivalent rate after removing the disabled chronic streams is `0.48%`.

Remaining enabled schedule rows:

```text
gmail_inbox_manager
github-digest
github-weekly-issue-digest
good-morning-summary-email
search_console_insights
```

Remaining active seven-day failures are low-volume historical rows: `worker-author` restart interruptions, `gmail_inbox_manager` restart interruption, and one-off worker/runtime failures. No enabled high-frequency chronic loop remains in the post-action top-failer query.

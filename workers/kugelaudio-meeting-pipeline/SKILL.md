---
name: kugelaudio-meeting-pipeline
description: Operate, debug, or extend Kugelaudio's meeting follow-up automation that scans Notion Meeting Tracker pages, extracts action items with Claude/Anthropic, deduplicates against Linear issues, creates or links Linear issues, writes processing state back to Notion, and posts a Slack digest. Use when working on the Notion to Linear to Slack meeting pipeline, its env vars, one-shot runner, systemd timer, or related deployment/debugging tasks in this repo.
---

# Kugelaudio Meeting Pipeline

## Core Flow

Use this skill for the repo workflow implemented in `lead-gen-service/src/meeting-pipeline.js`:

1. Query the Notion Meeting Tracker database for rows where the trigger checkbox is enabled.
2. Skip rows already recorded in the pipeline state file with the same `last_edited_time`.
3. Read the Notion page body blocks and flatten them into meeting text.
4. Fetch open Linear issues for the configured team.
5. Ask Anthropic/Claude to extract concrete to-dos and optionally match each to an existing Linear issue identifier.
6. For matched issues, add a Linear comment with meeting context.
7. For unmatched to-dos, create new Linear issues with the configured label.
8. Build and post a Slack digest unless Slack posting is disabled.
9. Best-effort update Notion properties with status, digest text, and Linear identifiers.
10. Save state after successful non-dry-run processing.

## Source Map

Primary files (in the customer's repo, NOT in this Workeros bundle):

- `lead-gen-service/src/meeting-pipeline.js`: implementation and all API integration helpers.
- `lead-gen-service/src/meeting-pipeline-run-once.js`: CLI wrapper; supports `--dry-run`.
- `lead-gen-service/package.json`: npm scripts `meeting-pipeline-once` and `meeting-pipeline-dry-run`.
- `lead-gen-service/.env.example`: required and optional env vars.
- `deploy/systemd/kugelautos-meeting-pipeline.service`: one-shot production service.
- `deploy/systemd/kugelautos-meeting-pipeline.timer`: 15-minute production schedule.
- `lead-gen-service/README.md`: user-facing summary of the flow.

## Configuration

Required env:

```text
NOTION_API_KEY
SLACK_BOT_TOKEN
LINEAR_API_KEY
LINEAR_TEAM_ID
ANTHROPIC_API_KEY
```

Important optional env and defaults:

```text
NOTION_MEETING_DB_ID=f3eeea40f0f549d3943a37640081f1d0
MEETING_PIPELINE_SLACK_CHANNEL=C0B4ZH046UU
MEETING_PIPELINE_LINEAR_LABEL=from-meeting
MEETING_PIPELINE_AI_MODEL=claude-haiku-4-5-20251001
MEETING_PIPELINE_TRIGGER_PROPERTY=Team Meeting
MEETING_PIPELINE_STATUS_PROPERTY=Pipeline Status
MEETING_PIPELINE_DIGEST_PROPERTY=Slack Digest
MEETING_PIPELINE_LINEAR_PROPERTY=Linear Issues
MEETING_PIPELINE_TITLE_PROPERTY=Meeting
MEETING_PIPELINE_DATE_PROPERTY=Datum
MEETING_PIPELINE_SKIP_SLACK=0
MEETING_PIPELINE_STATE_FILE=/opt/kugelautos/lead-gen-service/state/meeting-pipeline-state.json
```

## Notes for Workeros port

- Customer originally runs this via a systemd timer (every 15 min). In Workeros, the equivalent is a `schedule` trigger with cron `*/15 * * * *`.
- The `meeting-pipeline.js` source itself isn't pasted into this bundle yet — Federico has the customer's repo locally. To make this worker runnable, paste the contents of `lead-gen-service/src/meeting-pipeline.js` as `run.js`, and `lead-gen-service/src/meeting-pipeline-run-once.js` as a thin entry wrapper (or merge them).
- Required Node deps (from customer's package.json): `@notionhq/client`, `@anthropic-ai/sdk`. Add to `package.json` `dependencies`.
- State file: change default from `/opt/kugelautos/...` to a Workeros-friendly path under `state/` inside the bundle, or accept that prod runs are stateless and re-process the same row on every tick (the customer's state.json behavior is desirable; we should support per-worker persistent state in a future Workeros release).

This SKILL.md serves as the design / runbook reference. The agent on Workeros should NOT execute this — it's a description of an external pipeline. To make it a runnable worker, drop in the JS source and a `worker.yml` pointing at `node run.js`.

# Slack Self-Test Checklist

Use this checklist to verify the Workeros Slack Agent in a real Slack workspace.

## Current Gate

Production endpoint `https://workers-api.floom.dev/slack/events` is deployed, but live Slack verification returns:

```text
503 {"detail":"SLACK_SIGNING_SECRET is not configured"}
```

Before the Slack app can verify its Request URL, configure the production API environment with:

- `SLACK_SIGNING_SECRET`
- `SLACK_BOT_TOKEN`
- optional: `SLACK_ALLOWED_TEAM_IDS`
- optional: `SLACK_WORKEROS_USER_ID`

Do not paste Slack tokens or signing secrets into chat. Add them through the server environment path used by `workeros-api.service`, then restart the service.

## Slack App Setup

1. Open Slack API app configuration.
2. Create or update the app from `docs/slack-app-manifest.example.yml`.
3. Install or reinstall the app into the test workspace after scopes/events change.
4. Confirm Event Subscriptions verifies `https://workers-api.floom.dev/slack/events`.
5. Confirm Interactivity is enabled for `https://workers-api.floom.dev/slack/events`.
6. Confirm `/floom` points to `https://workers-api.floom.dev/slack/events`.

## Channel reading (consent = invite)

Emily can read a channel's recent history on demand, but only channels she has
been **invited** to. The invite is the consent: Slack only lets the bot read a
channel it is a member of. Default access stays DM + @mention only; there is no
firehose ingestion.

Required bot scopes (already in `docs/slack-app-manifest.example.yml`):

- `channels:read`, `channels:history` (public channels)
- `groups:read`, `groups:history` (private channels)

After adding these scopes you MUST **reinstall** the app so the new bot token
carries them. Until then, channel-read requests degrade gracefully: Emily tells
the operator that channel access isn't enabled yet and how the owner enables it
(she does not crash).

To grant Emily access to a specific channel, run in that channel:

```text
/invite @Workeros
```

## Smoke Test

1. In a channel where the bot is present, send:

```text
@Workeros summarize my active workers
```

Expected: Workeros replies in the Slack thread.

2. Run:

```text
/floom help
```

Expected: Slack returns an ephemeral help message mentioning `/floom approvals`.

3. Run:

```text
/floom summarize failed runs
```

Expected: Slack returns `Working on it...`, then posts the workspace-agent reply.

4. Run:

```text
/floom approvals
```

Expected: Slack renders pending approvals with Approve, Reject, and Dismiss buttons. If there are no pending approvals, Slack returns `No pending approvals.`

5. Open the Workeros app DM or AI App thread and send:

```text
List pending approvals
```

Expected: Workeros sets assistant status and replies in the thread.

6. Click Approve and Reject on a real pending approval card.

Expected: the Slack message is replaced with the decision result, and the corresponding Workeros run leaves `pending_approval`.

7. In the Workeros app DM or AI App thread, send:

```text
List the Slack channels you can read
```

Expected: Emily calls `slack__list_channels`. With channel scopes granted, she
lists the channels she's been invited to. Without the scopes, she replies that
channel access isn't enabled yet and how the owner enables it (no error).

8. In a channel where Emily is invited, ask her to summarize it:

```text
@Workeros summarize #launch
```

Expected: Emily calls `slack__read_channel` and summarizes the recent messages.
If she isn't in the channel, she replies "Invite me with /invite @Workeros in
#launch and I'll read it." If scopes aren't granted, she explains how the owner
enables channel access.

## Evidence To Capture

- Slack Event Subscriptions URL verification success screen.
- Slack app install success screen.
- Screenshot of `@Workeros` threaded reply.
- Screenshot of `/floom help`.
- Screenshot of `/floom approvals` Block Kit buttons or `No pending approvals.`
- Screenshot of approval decision result.
- API logs around each request:

```bash
journalctl -u workeros-api --since "10 minutes ago" --no-pager | rg -n "slack|Slack|/slack"
```

## Deterministic Regression

Run from the Workeros repo:

```bash
python3 -m pytest tests/test_slack_events.py tests/test_slack_listener.py tests/test_composio_triggers.py tests/test_pr231_correctness.py -q
python3 -m pytest tests/test_api_endpoints.py -q
python3 -m py_compile apps/api/main.py workers/slack-listener/run.py
git diff --check
```

# Slack Events Verification

Workeros exposes a native Slack Events API receiver at:

- Self-hosted: `https://localhost:8000/slack/events`
- Remote/self-hosted: `https://api.workeros.example.com/slack/events`

## Required Env

- `SLACK_SIGNING_SECRET`: Slack app signing secret used for `X-Slack-Signature`.
- `SLACK_BOT_TOKEN`: bot token with `chat:write` plus the event scopes used by the Slack app.
- `SLACK_ALLOWED_TEAM_IDS`: optional comma-separated allowlist of Slack team ids.
- `SLACK_WORKEROS_USER_ID`: optional Workeros user/workspace owner id; defaults to the single-user bootstrap id.
- `SLACK_EVENTS_ENABLED`: optional feature flag; set to `0` to disable the route.

## Slack App Setup

1. In Slack app Event Subscriptions, set Request URL to the matching `/slack/events` URL.
2. Slack sends a `url_verification` payload. Workeros returns the raw `challenge` only after validating Slack HMAC.
3. Subscribe to `app_mention` bot events.
4. Install or reinstall the app into the workspace after scopes/events change.

## Runtime Behavior

- The route rejects missing, stale, or invalid Slack signatures.
- `event_callback` payloads are deduplicated by Slack `event_id`.
- `app_mention` events are acknowledged immediately, then processed in the background.
- The background task calls the workspace agent and posts the reply in the Slack thread with `chat.postMessage`.

## Local Smoke Test

The deterministic route tests are:

```bash
python3 -m pytest tests/test_slack_events.py tests/test_slack_listener.py tests/test_composio_triggers.py -q
```

These cover URL verification, invalid signatures, app mention forwarding, duplicate event handling, the existing polling listener worker, and existing Composio webhook behavior.

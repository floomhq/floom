# Skill: Emily Slack Onboarding (#542)

Reusable, end-to-end runbook for bringing Emily (the workspace agent) into a
Slack workspace: install, auth/linking, first DM/channel use, troubleshooting.
Written to be followed by an operator, a support agent, or Emily herself when
staged as a brain pack. Companion references: `docs/slack-events.md`
(receiver contract), `docs/slack-self-test.md` (live verification checklist),
`docs/slack-app-manifest.example.yml` (app manifest).

Applies to self-hosted Workeros (`https://localhost:8000`) and hosted Workeros
(`https://api.workeros.example.com`); substitute your API base below.

---

## 1. Install the Slack app

Two supported paths. Use Guided unless you cannot create a Slack app from a
manifest.

### Path A — Guided (Settings UI + OAuth)

1. Create the Slack app from the manifest: Slack API console → *Create New App*
   → *From an app manifest* → paste `docs/slack-app-manifest.example.yml`
   (update the three URLs to your API base).
2. In Workeros Settings → Channels → Slack, enter the app's **Client ID**,
   **Client Secret**, and **Signing Secret**. This calls
   `POST /slack/setup/config` (env allowlist: `SLACK_CLIENT_ID`,
   `SLACK_CLIENT_SECRET`, `SLACK_SIGNING_SECRET`, `SLACK_EVENTS_ENABLED`).
3. Check `GET /slack/setup/status` — it reports `configured`, which of the
   three values are missing, the exact `events_url` / `command_url` /
   `interactivity_url` / `callback_url` to paste into the Slack app config,
   and an `install_url` once configured.
4. Click **Install to Slack** (the `install_url`, i.e.
   `POST /slack/oauth/install` → Slack consent → `GET /slack/oauth/callback`).
   The callback stores the team's bot token and appends the team to
   `SLACK_ALLOWED_TEAM_IDS`.

### Path B — Manual (env-only, single workspace)

1. Create the app from the manifest as above.
2. Set on the API host (via the server environment path used by
   `workeros-api.service`, then restart — never paste tokens into chat):
   - `SLACK_SIGNING_SECRET` (required)
   - `SLACK_BOT_TOKEN` (required; bot token after installing the app by hand)
   - `SLACK_ALLOWED_TEAM_IDS` (optional allowlist)
   - `SLACK_WORKEROS_USER_ID` (optional; defaults to single-user bootstrap id)
   - `SLACK_EVENTS_ENABLED` (optional; `0` disables the route)
3. In the Slack app config set Event Subscriptions / Interactivity / `/floom`
   slash command to `<api-base>/slack/events`. Slack sends `url_verification`;
   Workeros echoes the `challenge` only after validating the HMAC signature.
4. Subscribe to `app_mention` (and `assistant_thread_started`) bot events,
   then install/reinstall the app into the workspace. Reinstall again any time
   scopes or events change.

---

## 2. Auth and account linking (who is this Slack user?)

Server-side auth is the signing secret + per-team bot token (above). Per-user
identity uses **claim bindings** (`slack_sender_bindings`, mirroring the
WhatsApp pattern):

1. First DM (or `/floom`) from an unbound Slack user: Emily does not answer
   the request. She replies with a private **claim link** (an ephemeral
   message / DM with a "Link your account" button — the bearer token is never
   posted to a shared surface).
2. The link opens `<frontend>/settings?slack_claim=<token>`; logging in there
   calls `POST /slack/bindings/claim`, binding `(team_id, slack_user_id)` to
   the logged-in Workeros user. Pending claims expire and are replaced on
   re-request; active bindings are never silently replaced.
3. From then on, DMs/@mentions from that Slack user run as the bound Workeros
   user (their workers, connections, approvals).
4. Inspect or unlink: `GET /slack/bindings/me`, `DELETE /slack/bindings/me`.

Legacy single-user mode (binding prompts off, everything maps to the bootstrap
user) exists for self-hosts that predate bindings — leave it off otherwise.

---

## 3. First use: DM, @mention, channel

- **DM**: open a DM with the bot (Messages tab is enabled) and say hi. Emily
  answers in-thread; the Slack "assistant view" suggested prompts (pending
  approvals, worker status) are good first asks.
- **@mention in a channel**: `/invite @Workeros` to the channel, then
  `@Workeros <request>`. Replies land in the message's thread.
- **Slash command**: `/floom <request>` or `/floom approvals` from anywhere.
- **Channel reading (consent = invite)**: Emily can read recent history only
  in channels she has been invited to — the invite is the consent; there is no
  firehose ingestion. Tools: `slack__list_channels`,
  `slack__read_channel(channel, limit?)`. Scopes already in the manifest:
  `channels:read`, `channels:history`, `groups:read`, `groups:history`.

Smoke-check after onboarding: one DM round-trip, one @mention round-trip in a
test channel, one `/floom approvals`.

---

## 4. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Slack URL verification fails, API returns 503 `SLACK_SIGNING_SECRET is not configured` | Signing secret missing on the API host | Set it via `POST /slack/setup/config` or the server env path, restart, re-verify |
| 401/invalid signature on `/slack/events` | Wrong signing secret, or request older than the tolerance window | Re-copy the signing secret from the Slack app; check host clock skew |
| Events verified but Emily never replies | `SLACK_EVENTS_ENABLED=0`, team not in `SLACK_ALLOWED_TEAM_IDS`, or bot token missing/invalid for the team | `GET /slack/setup/status` → check `events_enabled`, `allowed_team_ids`, `installed_teams` |
| Emily replies with a claim link instead of answering | Sender is unbound (expected on first contact) | Complete the claim flow in Settings; check `GET /slack/bindings/me` |
| Claim link 404s or bounces to /login | Frontend base URL misconfigured for short claim links | Verify the API's public/frontend base URL env; the short link must resolve to `/settings?slack_claim=...` |
| `@Workeros` in a channel does nothing | Bot not invited, or `app_mention` event not subscribed | `/invite @Workeros`; confirm bot events in the app config; reinstall after changes |
| `slack__read_channel` returns nothing / permission error | Bot not a member of the channel, or history scopes missing | Invite the bot; confirm `channels:history` / `groups:history` scopes; reinstall |
| Worked before, broke after editing scopes/events | Slack requires reinstall after scope/event changes | Reinstall the app into the workspace |

Deterministic local checks (no Slack workspace needed):

```bash
python3 -m pytest tests/test_slack_events.py tests/test_slack_listener.py -q
```

Live checklist: `docs/slack-self-test.md`.

# Emily on Slack + WhatsApp — integration state (audit 2026-06-10)

Evidence-backed audit of the real code in `/root/workeros` (engine/OS) + `/root/managed-deployment`.

## How it works (built)
Same Emily everywhere. A channel message → Workeros webhook → `_collect_workspace_agent_reply_for_slack` → `stream_chat` (Emily's agent loop) → reply posted back. Conversation id keeps thread/number context (`slack:{channel}:{thread_ts}`, `whatsapp:{wa_id}`).

## Slack — ~built for single-tenant; multi-user identity is the gap
| Piece | Status | Where |
|---|---|---|
| Inbound webhook `POST /slack/events` + HMAC verify, app_mention / DM / assistant_thread | BUILT | engine `apps/api/main.py` (~16333) |
| Outbound `chat.postMessage` + reactions | BUILT | `_post_slack_thread_reply` (~15888) |
| Approvals (Block Kit approve/reject + `/slack/interactivity` + `/floom approvals`) | BUILT | (~16007 / 16487 / 16435) |
| OAuth "Add to Slack" install + bot token store (`slack_installations`) | BUILT | `_exchange_slack_oauth_code`, `_upsert_slack_installation` |
| Cloud channel→workspace binding | BUILT | `workspace_agent_channel_bindings` (Supabase migration 0022) |
| **Per-Slack-user identity / new-user onboarding** | **MISSING** | every DM/mention → one hardcoded `SLACK_WORKEROS_USER_ID` (bootstrap "federico"). No `slack_user_links` / `slack_link_nonces`. Design in `slack-zero-ui-onboarding.md`, not built. |
| Approval auth-guard per Slack actor | PARTIAL (launch blocker) | interactivity resolves to the same hardcoded user, not the clicker |
| Guided "Add to Slack" UI | PARTIAL | barebones form, manual channel id (M78 brief) |

## WhatsApp — ~built for single-tenant OSS; approvals + Cloud persistence are the gaps
Provider = **Meta WhatsApp Business Cloud API** (Graph `v23.0`), not Twilio/Composio/clawdbot.
| Piece | Status | Where |
|---|---|---|
| Inbound `GET/POST /whatsapp/webhook` + `X-Hub-Signature-256` verify + parse | BUILT | engine main.py (~16950 / 16753 / 16856) |
| Sender onboarding (first msg → claim link → `whatsapp_sender_bindings`, claim via `/whatsapp/bindings/claim`) | BUILT (OSS SQLite) | migration 57 |
| Outbound send (`/v23.0/{phone_id}/messages`, chunked, typing) | BUILT | `send_whatsapp_text` (~16827) |
| Emily reachability (same pipeline, `source="whatsapp"`) | BUILT | `_handle_whatsapp_message` (~16906) |
| **Approvals over WhatsApp** | **MISSING** | no reply-yes/quick-reply approve path |
| **Cloud multi-tenant binding** | **MISSING** | `whatsapp_sender_bindings` only in ephemeral SQLite, no Supabase migration → lost on deploy, not workspace-scoped. Engine-only; no Cloud overlay. |
| Provisioning | static env (`WHATSAPP_PHONE_ID/TOKEN/APP_SECRET/WEBHOOK_VERIFY_TOKEN`) | single number; no per-workspace number provisioning |

## Don't confuse: the "listener" example workers are NOT the real path
`workers/slack-listener` and `workers/whatsapp-listener` are `is_example` **poll-based** workers using Composio (cron polling). The real-time path is the **Events API / Meta webhooks** above. Ignore the pollers.

## Biggest single gap
**Slack per-Slack-user identity** (+ Cloud-persisted, workspace-scoped channel bindings for WhatsApp). Until a Slack message can be tied to the *actual* sender and a new user can self-onboard via DM link, Slack is only a single-tenant personal assistant, and the approval buttons let any Slack actor mutate runs.

## Ownership
Slack handler logic = **engine (OS)**; Cloud adds a thin overlay + workspace binding. WhatsApp = **engine only** (Cloud overlay missing). Keep OS↔Cloud in sync per the workeros sync rule.

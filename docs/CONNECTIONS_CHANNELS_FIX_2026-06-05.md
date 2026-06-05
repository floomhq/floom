# Connections and Channels Fix Status - 2026-06-05

## M80 - Composio redirect delay

Status: complete.

PR: https://github.com/floomhq/workeros/pull/448

Change: removed the hardcoded 3000ms delay in `apps/web/app/connections/redirect/page.tsx`. The redirect now happens as soon as `api.connections.initiate(slug)` returns a `redirect_url`.

Initiate latency finding: the backend already caches Composio auth config IDs for 10 minutes. The connected-account URL is still minted at click time, which keeps the auth URL fresh while removing the artificial client delay.

Verification:
- `npm run lint`
- `npm run build`
- `npm test`
- `git diff --check`

## M79 - Bare dashboard paths

Status: complete.

PR: https://github.com/floomhq/workeros/pull/450

Bad-link source: `apps/web/components/ConnectionEventPicker.tsx` used a raw `<a href="/connections/browse">`, which bypassed Next base-path handling on cloud. The broader risk was bare shared links such as `/connections`, `/connections/browse`, `/assistant`, and `/workers/new` 404ing before they reached `/app`.

Change: added cloud-only apex redirects in `apps/web/next.config.ts` when `NEXT_PUBLIC_BASE_PATH` is configured. Bare dashboard paths now redirect to `/app/<same>`.

Verification:
- `npm test`
- `npm run lint`
- `npm run build`
- `NEXT_PUBLIC_BASE_PATH=/app npm run build`
- Local production curl checks:
  - `/connections` -> `307 /app/connections`
  - `/connections/browse` -> `307 /app/connections/browse`
  - `/assistant` -> `307 /app/assistant`
  - `/workers/new` -> `307 /app/workers/new`

## M78 - Guided assistant channel onboarding

Status: implemented in branch `feat/m78-guided-assistant-channels`.

Change:
- Added engine APIs for assistant channel status, live target options, binding, and unbinding:
  - `GET /assistant/channels/status`
  - `GET /assistant/channels/{provider}/options`
  - `PUT /assistant/channels/{provider}/binding`
  - `DELETE /assistant/channels/{provider}/binding`
- Added SQLite migration 58 for `assistant_channel_bindings`.
- Replaced manual channel entry with an assistant Channels tab that guides users through OAuth connect, live picker, and binding.
- Slack uses Composio `SLACK_LIST_ALL_CHANNELS` and presents public/private channels in a dropdown.
- WhatsApp uses Composio `WHATSAPP_GET_PHONE_NUMBERS` and presents WhatsApp Business phone numbers in a dropdown.
- Added an overview entry point labeled `Set up channels` that links to `/assistant#channels`.

Verification:
- Live Composio catalog check found toolkit `whatsapp`.
- Live Composio catalog check found WhatsApp auth schemes `OAUTH2` and `API_KEY`.
- Live Composio tools include `WHATSAPP_GET_PHONE_NUMBERS`.
- Local browser screenshot verified the Channels tab renders Slack and WhatsApp connect cards: `/tmp/workeros-m78-assistant-channels-firefox.png`.
- Local browser screenshot verified the overview entry point: `/tmp/workeros-m78-overview-entry.png`.
- API tests cover status, live option parsing for Slack and WhatsApp, and OAuth-required binding.

## WhatsApp mechanism finding

Composio supports WhatsApp in the live catalog, so the STOP condition for an unsupported Composio mechanism did not apply.

Options considered:
- Composio: available now through toolkit `whatsapp`, OAuth2/API-key auth, and phone-number listing tools. Recommendation: use this for cloud onboarding first because it matches the existing Connections flow.
- Twilio: viable as a separate provider path, but it would introduce new account setup, sender approval, webhook, and billing surfaces.
- Existing OpenClaw/Clawdbot gateway: useful as a runtime or fallback integration, but it is not the cleanest cloud onboarding mechanism while Composio already exposes WhatsApp.

Recommendation: ship Composio-backed WhatsApp onboarding first. Keep Twilio and the existing OpenClaw/Clawdbot gateway as product decisions only if Composio phone listing, OAuth, or webhook behavior fails in production validation.

## Production deploy note

No production deploy or prod alias flip was performed from these branches. `ops/smoke-routes.sh` remains the required gate before any prod deploy.

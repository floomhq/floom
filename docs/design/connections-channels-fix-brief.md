# Connections + Channels onboarding — fix brief (2026-06-05)

Federico live-walk. Three issues + one feature gap. OS engine = single source; the assistant Channels UI is a CLOUD OVERLAY (managed-deployment web/overlay/app/assistant/page.tsx). Respect the engine/cloud boundary: connect MECHANISM (Composio) + binding APIs are engine; cloud-owned overlay only adds the cloud seams. Fix in engine + PR, bump submodule, unless genuinely cloud-routing/overlay-only. Do NOT prod-deploy without running ops/smoke-routes.sh.

## M80 (perf, QUICK) — "Redirecting to Composio" is slow
Root cause CONFIRMED: apps/web/app/connections/redirect/page.tsx lines 47-49 hardcode `setTimeout(() => window.location.href = redirect_url, 3000)` — a 3-SECOND artificial delay before redirecting, on top of the api.connections.initiate(slug) round-trip.
FIX: redirect as soon as redirect_url is ready (drop the 3000ms; at most a 300-500ms beat so the card is visible, or immediate). Also check api.connections.initiate latency — if the server round-trip to Composio to mint the auth URL is itself slow, see if it can be prefetched/cached. Verify the connect flow feels instant after.

## M79 (bug, QUICK) — apex /connections/* 404
CONFIRMED: workeros.floom.dev/connections/browse = 404, /connections = 404 (apex, no /app), while /app/connections/browse = 307 and /app/connections = 307 (dashboard works). Federico wants connections/onboarding reachable "from the landing directly".
FIX: decide + implement: either (a) apex redirects /connections, /connections/* (and likely /secrets, /runs, /workers, /assistant if similarly linked) -> /app/<same> so bare links resolve into the dashboard, OR (b) fix whatever LINKS to /connections/browse to use /app/... Find the source of the bad link first (grep landing app/ + dashboard for href="/connections). Prefer an apex redirect so shared/bare links never 404. Verify all the bare paths resolve live.

## M78 (feature, the main complaint) — proper Slack + WhatsApp onboarding flows
Current state: assistant#channels has ONLY a barebones Slack form (paste Channel ID / Team ID manually). NO WhatsApp anywhere in the codebase. Federico: "I wanted proper slack and whatsapp onboarding flows ... also from the landing directly."
BUILD:
- SLACK guided flow: replace the manual channel-ID form with a real guided onboarding — Connect Slack via OAuth (Composio), then PICK the channel from a live dropdown (list the workspace's Slack channels via the connection), then enable the binding. The user should never hand-type a channel ID. Keep the readiness pills (OAuth / events / bot / binding) but make each step actionable inline.
- WHATSAPP: FIRST scope the mechanism — check the live Composio app catalog for a WhatsApp app (initiate/list). If Composio supports WhatsApp, build the SAME connect->bind flow. If Composio does NOT support WhatsApp, do NOT invent a mechanism: write the options (Composio vs Twilio vs the existing OpenClaw/Clawdbot WhatsApp gateway) with a recommendation and STOP for a Federico product decision on which mechanism to use. Report this clearly.
- FROM LANDING: add an entry point so a prospect can start Slack/WhatsApp setup from the landing (link into /app/connections or a dedicated onboarding; respects auth — unauth lands on login then continues).

## Discipline
Worktree off origin/main, commit+push each step, PR (admin merge if GH Actions billing-blocks, after local tests pass — document). Run ops/smoke-routes.sh before any prod alias flip. No secret values. No em dashes in user-facing strings. Match the design system (warm matte, Geist, ChatGPT-simplicity bar); real brand logos via BrandLogo, no text-in-circles.

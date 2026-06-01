# Telemetry and Data Collection Requirement

Date: 2026-06-01
Status: OPEN product requirement

## Requirement

Workeros Cloud needs a first-party telemetry system that records enough product, usage, reliability, and onboarding data to improve the product quickly.

## Data to Collect

- Authentication and onboarding funnel events: visit login, choose provider, magic-link requested, password login attempted, OAuth callback success/failure, workspace created, workspace selected.
- Core product events: worker created, edited, duplicated, deleted, imported, exported, run started, run completed, run failed, schedule enabled, approval created, approval accepted/rejected.
- Agent and Slack events: assistant instruction edited, resolved prompt viewed, channel connected, Slack event received, Slack reply sent, Slack failure.
- Connections and brain events: connection started, connected, failed, refreshed, disconnected, brain pack created, file uploaded, file previewed, worker attached/detached brain pack.
- UI quality events: route visited, command palette opened, source rendered/raw toggled, copy button clicked, preview failed, long loading states, client-side errors.
- Backend reliability events: API route, latency bucket, status code, worker runner, queue wait, retry count, rate-limit hit.

## Guardrails

- Disclose telemetry clearly in the privacy policy before broad rollout.
- Provide user/workspace export for telemetry associated with the workspace.
- Provide deletion flow that removes or anonymizes telemetry tied to a deleted user/workspace.
- Do not collect secrets, raw API keys, OAuth refresh tokens, full request bodies, full worker outputs, or unredacted logs.
- Redact emails, tokens, connection identifiers, URLs with credentials, and file contents unless an event explicitly needs a safe hash or count.
- Keep privileged analytics keys server-side only. Frontend can send events only to a first-party ingestion endpoint.
- Add rate limits and batching before enabling high-volume client telemetry.
- Separate operational logs from product analytics; both need retention limits.

## Implementation Notes

- Typed Cloud API endpoints are now defined under `/api/telemetry/*`.
- Storage migration: `supabase/migrations/0017_telemetry_events.sql`.
- Events are stored with `user_id`, `workspace_id`, hashed `session_id`, `event_name`, `event_version`, `source`, sanitized `properties`, `occurred_at`, and `created_at`.
- Sensitive payload handling is server-side: property keys containing token/secret/password/session/etc. are redacted, emails and token-shaped strings are redacted, and oversized values are truncated.
- Privacy controls exist at:
  - `GET /api/telemetry/preferences`
  - `PUT /api/telemetry/preferences`
  - `GET /api/telemetry/export`
  - `DELETE /api/telemetry/workspace`

## Still Required

- Wire frontend and backend product events into the ingestion endpoint.
- Add privacy-policy copy for telemetry categories and retention.
- Add retention jobs once usage volume is known.
- Add product analytics dashboards on top of exported events.

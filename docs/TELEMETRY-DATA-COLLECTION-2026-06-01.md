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

- Start with a typed event schema and an ingestion endpoint under the Cloud API.
- Store events with `user_id`, `workspace_id`, `session_id`, `event_name`, `event_version`, `properties`, `created_at`.
- Keep sensitive payloads out of `properties`; use allowlisted property keys per event.
- Add a privacy export endpoint that can stream telemetry by workspace.
- Add a deletion/anonymization job for workspace and user deletion.

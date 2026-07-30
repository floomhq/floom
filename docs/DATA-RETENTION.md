# Data, retention, and safeguards

This document describes the open-source runtime's data handling model and the
hosted Cloud posture at a product level. It is not a replacement for the hosted
Floom Terms or Privacy Policy.

## Hosted Cloud versus self-hosted

- **Hosted Floom Cloud** runs on Floom-managed API, storage, sandbox compute,
  model/runtime infrastructure, and OAuth connection infrastructure. Hosted
  users should review the live Terms and Privacy Policy at
  `https://floom.dev/terms` and `https://floom.dev/privacy`.
- **Self-hosted Floom** stores data wherever the operator configures it:
  SQLite/Postgres/Supabase, local or cloud file storage, E2B, Composio, model
  providers, and any MCP servers or integrations the operator connects. The
  operator is responsible for retention, access control, backups, deletion, and
  provider terms.

## What Floom stores

Floom stores the records required to run and audit workers:

- Worker bundles: `worker.yml`, `run.py` or `SKILL.md`, requirements, helper
  files, schedules, triggers, and worker settings.
- Run records: inputs, status, logs, tool-call metadata, approvals, errors,
  outputs, and artifacts.
- Context files: workspace knowledge files attached to workers.
- Connection metadata: connected app labels, provider/app identifiers, scopes or
  tool lists when available, trigger wiring, and status.
- Secrets: secret names and encrypted values. Secret values are intended to be
  write-only through product surfaces.
- Workspace settings, members, tokens, and audit/history records where enabled.

## Connected accounts and Gmail data

Workers may access Gmail or other connected accounts only when a workspace
member connects that account and the worker declares the connection it needs.
Worker authors should prefer the narrowest useful connection declaration:

```yaml
connections:
  - app: gmail
    allowed_tools:
      - GMAIL_FETCH_EMAILS
      - GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID
```

The Floom runtime rejects undeclared Composio apps and tool slugs outside
`allowed_tools`. This is a platform-level guard for a worker run; it does not
change the underlying OAuth grant held by the connection provider. For true
OAuth least privilege, use provider-side auth configurations with narrower
scopes, such as read-only Gmail scopes for read-only workers.

## Uploaded files and worker storage

File inputs, context files, and run artifacts can contain sensitive data. Floom
keeps them workspace-scoped and passes only the files declared for a run into
the worker sandbox. Script workers run in an E2B microVM and do not receive host
environment variables or undeclared platform secrets.

Do not put long-lived credentials, API keys, OAuth tokens, or customer secrets
inside worker files, context files, inputs, logs, or outputs. Store credentials
through the secret store and reference them by name in `worker.yml`.

## Retention and deletion

The OSS runtime does not impose a universal automatic deletion window. Data is
retained until the operator deletes it, rotates storage, or configures their own
retention job. Product surfaces and APIs provide deletion controls for common
objects, including workers, secrets, context files, share links, and workspaces
where the deployment enables those routes.

For hosted Cloud, retention and deletion commitments belong in the live Privacy
Policy and operational runbooks. Do not promise a fixed retention period in
docs, templates, or support messages unless the hosted infrastructure enforces
that period.

## Cost and abuse backstops

Hosted deployments should set low default spend caps for free or trial
workspaces. The API supports user-level and workspace-level daily/monthly run
spend caps via:

- `WORKEROS_DEFAULT_USER_DAILY_SPEND_CAP_USD`
- `WORKEROS_DEFAULT_USER_MONTHLY_SPEND_CAP_USD`
- `WORKEROS_DEFAULT_DAILY_SPEND_CAP_USD`
- `WORKEROS_DEFAULT_MONTHLY_SPEND_CAP_USD`

The two user-level values are DEFAULTS. A per-user override, set with
`PUT /admin/users/{user_id}/spend-caps` and read with the matching `GET`, gives one
account headroom without raising the ceiling for every account. `null` clears an
override and restores the env default. There is no unlimited value: set a large
number so the effective ceiling stays auditable.

`WORKEROS_SPEND_CAP_WARN_RATIO` (default `0.8`) is the fraction of a cap at which a
scope starts reporting a warning on `/system/overview` and in the logs. It does not
change admission; it exists so an account learns it is approaching the wall before
its automations stop.

A cap is an **admission threshold, not a ceiling**. A run's cost is finalized only
after it terminates, so the run that crosses the cap still completes and is billed,
and runs already in flight are invisible to the check. The guaranteed bound is
`final spend <= cap + (cost of the runs in flight when the cap was crossed)`, itself
bounded by the concurrent-run limit times the cost of the most expensive single run.
The overshoot is reported rather than hidden: see `overshoot_usd` in
`GET /account/spend` and the "$X over" suffix in the rejection message.

These are run-dispatch backstops, not a substitute for provider-side billing
alerts, rate limits, abuse monitoring, or legal review.

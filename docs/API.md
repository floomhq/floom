# API overview

The local API serves on `http://localhost:8000`.

If `FLOOM_SECRET` is set, API requests require:

```text
x-floom-secret: <your secret>
```

Shared-secret requests are member-scoped by default. Set
`WORKEROS_SHARED_SECRET_ROLE=admin` only for deployments that intentionally need
legacy admin-equivalent shared-secret access.

If `FLOOM_SECRET` is unset, local development runs without the operator secret.
For the exhaustive route reference, start the API and open
`http://localhost:8000/docs`.

## Common endpoints

This page is a curated map of the main surfaces. It is not a replacement for
the generated OpenAPI docs.

### Workers

| Endpoint | Method | Description |
|---|---|---|
| `/workers` | GET | List workers |
| `/workers/{id}` | GET | Worker detail, including missing secrets/connections |
| `/workers/reload` | POST | Reload workers from disk |
| `/workers/{id}/runs` | POST | Trigger a run |
| `/workers/import-from-share` | POST | Import a worker from a public share token |

### Runs and approvals

| Endpoint | Method | Description |
|---|---|---|
| `/runs` | GET | List runs |
| `/runs/{id}` | GET | Run detail, logs, tool calls, approvals, and outputs |
| `/runs/{id}/approve` | POST | Approve a pending run |
| `/runs/{id}/reject` | POST | Reject a pending run |
| `/runs/{id}/feedback/issue` | POST | Convert actionable run feedback into a workspace issue bound to the run (`asset_type=run`, `source=run_feedback`, label `run-feedback`). Opt-in; a stable `feedback_id` dedups (returns the existing issue with `created=false`, `200`). |
| `/approvals` | GET | List pending approvals |

### Connections and secrets

| Endpoint | Method | Description |
|---|---|---|
| `/connections` | GET | List connections |
| `/connections/{id}` | GET | Connection detail |
| `/connections/{id}/activity` | GET | Recent runs that used this connection |
| `/connections/{id}/peek` | GET | Privacy-conscious preview for supported connections |
| `/connections/secrets` | GET | List secret metadata |

### Workspace issues

Git-backed operating record stored under `.floom/issues/` in the workspace git repo
(no GitHub Issues, no provider sync, no database table). See
[git-workspace.md](git-workspace.md).

| Endpoint | Method | Description |
|---|---|---|
| `/workspace/issues` | GET | List issues; filter by `status`, `label`, `asset_type`, `asset_id` |
| `/workspace/issues/{id}` | GET | Issue detail with comments |
| `/workspace/issues` | POST | Create an issue (optionally bound to a worker/context/run) |
| `/workspace/issues/{id}` | PATCH | Update title/body/status/labels/asset binding |
| `/workspace/issues/{id}/comments` | POST | Append a comment |

Issues ride the workspace git source of truth, so a git remote clone/push and the
cloud bundle flow preserve them automatically. The curated `/workspace/export` +
`/workspace/import` template bundle preserves them explicitly: issue files are
written under `issues/` in the zip and restored into `.floom/issues/` on import
(existing ids are never clobbered).

### Auth and system

| Endpoint | Method | Description |
|---|---|---|
| `/auth/magic-link` | POST | Issue a short-lived personal sign-in URL |
| `/auth/magic/{token}` | GET | Consume a magic-link token and create a session |
| `/composio-events` | POST | Signed Composio webhook receiver |
| `/healthz` | GET | Health check |
| `/system/overview` | GET | Overview stats and setup alerts |

## Related docs

- [AUTHORING.md](AUTHORING.md) for worker manifests, inputs, outputs, secrets,
  connections, triggers, and approvals.
- [GETTING-STARTED.md](GETTING-STARTED.md) for the first-run path and safe
  self-hosting checklist.
- [TROUBLESHOOTING.md](TROUBLESHOOTING.md) for common setup, runtime, and test
  issues.

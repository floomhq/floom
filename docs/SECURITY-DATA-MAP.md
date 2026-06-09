# Security Data Map — Workeros

Last updated: 2026-06-09

Where user data lives, how it is protected at rest, and how long it is kept.
Workeros OS is a single-tenant deployment: one account owner, no third-party
end users. "User" below means that owner.

## 1. SQLite database (`FLOOM_DB`, default `data/floom.db`)

Single SQLite file on the server. Encryption at rest = whatever the host
disk provides (the DB file itself is not separately encrypted). File
permissions on the server restrict access to the service account. The API
process is the only reader/writer; all queries are parametrized.

| Table | Stores | Sensitivity | At-rest encryption | Retention |
|---|---|---|---|---|
| `workers` | Worker definitions, metadata, owner id | Low (config) | Disk-level only | Until deleted by owner |
| `runs` | Run inputs, status, error, cost, trigger source, owner id | Medium (inputs may contain PII the worker was given) | Disk-level only | Until deleted / `runs/clear` |
| `logs` | Per-run step logs and tool-call traces | Medium (redacted before serving — see redaction below) | Disk-level only | Tied to parent run |
| `secrets` | User API keys / credentials (values) | **High** | Disk-level only; write-only via API (values never returned) | Until deleted by owner |
| `composio_connections` | OAuth/MCP connection rows, Composio connection id, MCP url + auth-secret name, scopes | Medium (identifiers, not tokens) | Disk-level only | Until disconnected by owner |
| `conversations`, `conversation_messages` | Workspace-agent chat history | Medium | Disk-level only | Until deleted by owner |
| `worker_webhook_secrets` | Per-worker HMAC secrets for inbound webhooks | High | Disk-level only | Tied to worker |
| `cli_auth_devices` | Short-lived CLI device codes + approved API secret | High (holds the platform secret once approved) | Disk-level only | Auto-pruned at expiry (600s); single-use on poll |
| `schedules`, `worker_state` | Cron schedules, worker runtime state | Low | Disk-level only | Tied to worker |
| `approvals` | Human-approval gate records for runs | Low | Disk-level only | Tied to run |
| `artifacts` | Pointers to artifact files (path, size) | Low (metadata) | Disk-level only | Tied to run |
| `files`, `file_owners`, `file_binding_audit` | Uploaded-file metadata, owner scoping, access audit | Medium | Disk-level only | Until file deleted |
| `alert_incidents` | Operational alert records | Low | Disk-level only | Operational |
| `webhook_delivery_receipts` | Webhook idempotency receipts | Low | Disk-level only | Short-lived |
| `run_create_rate_limits` | Per-user sliding-window rate-limit timestamps | Low | Disk-level only | Pruned past window |
| `skill_versions`, `schema_version` | Skill/version + migration bookkeeping | Low | Disk-level only | Persistent |

## 2. Artifacts directory (`FLOOM_ARTIFACTS_DIR`, default `data/artifacts`)

Output files produced by runs (reports, CSVs, generated docs). Sensitivity
matches whatever the worker produced. Encryption at rest = disk-level only.
Retention follows the parent run; removed when the run is cleared/deleted.

## 3. Contexts directory (`FLOOM_CONTEXTS_DIR`, default `contexts`)

Markdown/context files the owner creates and mounts into workers. Owner
controls content and lifetime. Disk-level encryption only.

## 4. Environment file (`.env` on the server)

Holds platform infrastructure secrets: `FLOOM_SECRET`, `OPENAI_API_KEY`,
`E2B_API_KEY`, `COMPOSIO_API_KEY`, `COMPOSIO_WEBHOOK_SIGNING_KEY`,
`WORKERS_FRONTEND_URL`. File-permission protected (mode 0600 by convention).
These are NEVER returned by any API endpoint, never logged in cleartext, and
NEVER injected into worker sandboxes (`_PLATFORM_SECRET_NAMES` denylist in
`run_service.py`). User-managed secrets added via the secrets API are stored
in the DB `secrets` table, not here.

## 5. Worker execution topology

Workeros has two execution paths:

- Pure-script workers (`.py`, `.sh`, `.js`, or `runtime.mode: pure-script`) run in E2B microVMs.
- Agent workers (`.md`, `SKILL.md`, or `runtime.mode: agent`) run in the API process through AgentDriver.

Product/security decision: agent workers are trusted platform-controlled code in the current single-tenant deployment. They are not a sandbox for arbitrary user-authored or marketplace code.

### 5.1 E2B sandboxes for pure-script workers

Pure-script worker code runs in E2B microVMs. Each sandbox receives only:
`FLOOM_RUN_ID`, `FLOOM_TRACE_ID`, the worker's declared inputs, declared
context files, and the declared/user secrets resolved through
`get_secrets_for_worker` (platform infra secrets are filtered out). The
sandbox `os.environ` does NOT contain any platform secret. Sandboxes are
destroyed when the run ends; nothing persists in them.

### 5.2 AgentDriver for agent workers

Agent workers run the OpenAI Agents SDK loop inside the API host process. They
can access their staged worker bundle, per-run artifacts and contexts, declared
secrets passed by the runtime, configured MCP/Composio clients, and API-host
process resources exposed through AgentDriver tools. Platform secret values are
not returned to the browser, but this path is not microVM-isolated from the API
host. Security review scope for agent workers is approval gates, MCP/Composio
scoping, declared-secret filtering, artifact/log redaction, cancellation, and
cost caps.

## 6. Logs / journald

The API runs under journald. Run logs served to clients pass through
`_redact_public_log_message` and `_public_sse_event` / `_public_run_part`,
which strip internal trace/thread/run/call/tool ids and rewrite
"Missing secrets: X, Y" and "<VAR> is not configured" messages so secret
*names* and platform internals are not disclosed. Secret values are never
written to logs by design.

## Data-flow summary

```
Browser ──(/api/proxy, server-injected x-floom-secret)──▶ API (FastAPI)
                                                            │
                          ┌─────────────────────────────────┼───────────────┐
                          ▼                                 ▼                ▼
                     SQLite (floom.db)              artifacts/contexts   Worker runtime
                     workers/runs/secrets/          on server disk       pure-script: E2B
                     connections/conversations/                          agent: API-host
                     contexts/approvals/...                              AgentDriver
```

The browser never receives platform secrets or user secret values; the
Next.js `/api/proxy` route injects `x-floom-secret` server-side.

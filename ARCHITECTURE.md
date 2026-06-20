# Floom Architecture

**For auditors, operators, and contributors: read this before testing or filing security findings.**

## Runtime Topology

Floom is a self-hosted app with three main pieces:

| Component | Default local location | Responsibility |
|---|---|---|
| Web app | `apps/web` | Next.js UI |
| API service | `apps/api` | FastAPI backend, auth, workers, runs, contexts |
| MCP server / CLI | `apps/mcp` | Agent and command-line integration |
| SQLite DB | `data/floom.db` by default | Local application state |
| Worker bundles | `workers/<worker_id>/` by default | Worker source and manifests |
| Run artifacts | `data/artifacts/` by default | Outputs, transcripts, uploaded files |

Local development (`python main.py`) serves the API on `http://localhost:8000`
by default. Override with `WORKEROS_API_PORT`. In production, run the FastAPI app
behind your own process manager and reverse proxy, for example with `uvicorn`
without reload.

## How Workers Execute

**Script workers run in E2B sandbox microVMs. Agent workers run in the API process through AgentDriver.** There is no local in-process script runner.

- `runner_sandbox/__init__.py` returns `AgentDriver` for `.md`/agent workers and `E2BSandboxDriver` for `.py`, `.sh`, and `.js` script workers.
- The `runner_local.py` module that existed in earlier commits was renamed to `runner_utils.py` in PR R. Its `run_worker_local` executor function was deleted in PR #28. The remaining contents are pure utility helpers consumed by the E2B driver to prepare the per-run payload.
- E2B sandboxes are Firecracker microVMs hosted by E2B. They do not share a Python interpreter, filesystem, network namespace, or environment variables with the API service.
- AgentDriver runs the OpenAI Agents SDK loop in the API process. Its file tools operate on host-staged worker, input, output, and context paths, and its MCP/Composio clients are created by the API process. The `run_command` tool follows the configured E2B runner, but that does not move the AgentDriver loop or its other tools into the microVM.

**Verified in-sandbox isolation:** a malicious bundle running an `os.environ` dump inside an E2B sandbox returns only sandbox metadata. `FLOOM_SECRET`, `OPENAI_API_KEY`, `COMPOSIO_API_KEY`, `COMPOSIO_WEBHOOK_SIGNING_KEY`, and `E2B_API_KEY` are all absent from `os.environ` inside the sandbox. The runner-hardening test suite covers this boundary.

**Also absent from `secrets.json`:** platform-level environment keys are denied from the worker-secret payload by `_PLATFORM_SECRET_NAMES`, regardless of whether a worker manifest or the secrets DB tries to declare them. `OPENAI_API_KEY` is intentionally not denylisted in this single-tenant version and can be passed when declared. See `tests/test_sandbox_secrets_isolation.py` for the regression.

For pure-script workers, this means attacks like:

- Worker reaches localhost FastAPI to read `/secrets`.
- Worker reads API-process environment variables and exfiltrates platform secrets.
- Worker introspects `sys.modules` to find the FastAPI app and inject routes.
- Worker mutates env vars seen by subsequent workers.
- Worker writes to API service files.

These do not apply to the pure-script Floom path. Pure-script workers do not
share a Python interpreter with the API. If a security audit produces these
findings for a `.py`/`.sh`/`.js` worker, the audit was run against the wrong
execution path.

Agent workers have a different trust model. `.md`/`mode: agent` workers run
through AgentDriver in the API process and are therefore not isolated from the
API host by an E2B microVM. The current single-tenant deployment policy permits
only trusted agent bundles on this path. That is an operational policy and trust
precondition, not a code-enforced sandbox boundary: the runtime does not
independently prove that an agent bundle is trustworthy. Untrusted or
marketplace agent bundles require a separate isolation design before they can
use this execution path.

## API Authentication

When `FLOOM_SECRET` is configured, the API is gated by a shared
`x-floom-secret` header. Requests without it return 401. Local development may
omit `FLOOM_SECRET`; production deployments should set it. Exempt paths include
`/health`, `/healthz`, `/connections/callback`, `/composio-events`, and
`/webhooks/<worker_id>` (token-gated separately).

## Rate Limiting

The API applies token-bucket rate limiting to request paths and caller identity.
Excess requests return 429 with `Retry-After` where appropriate. Worker run
creation and chat/draft operations also have DB-backed per-user quotas.

## Security Headers

Every response includes the standard browser hardening headers configured by
`main.py`, including HSTS, frame denial, content type sniffing protection,
referrer policy, permissions policy, and content security policy.

## How To Run A Real Audit

1. Test the API endpoint for the deployment you are auditing with its configured auth secret, rather than an unrelated local dev server.
2. Test pure-script isolation with a malicious `.py`/`.sh`/`.js` bundle. The E2B sandbox isolates that execution path.
3. Test agent workers against their actual boundary: trusted in-process AgentDriver execution, host-side file tools, configured MCP/Composio access, declared-secret handling, approvals, cancellation, and resource limits.
4. If you want to test the API surface, point your tools at the real API origin for that deployment and test auth, rate limit, input validation, path traversal, upload caps, and token-gated webhooks there.
5. Read this file before filing any "workers can compromise the platform" finding.

## Backend Module Layout (`apps/api`)

The FastAPI backend is being decomposed from a single large `main.py` into
focused modules. The dependency direction is strictly downward:
`main -> routers -> services -> core`. Nothing in `core`, `services`, or
`routers` imports `main`, avoiding import cycles. `main.py` remains the
application aggregator: it builds the FastAPI app and middleware, mounts the
routers, and re-exports moved names for backward compatibility.

- **`core/`**: dependency-light building blocks, no app state.
  - `config.py`: env-driven settings and static constants.
  - `utils.py`: pure helpers such as `row_to_dict` and `_parse_iso8601`.
  - `urls.py`: public base-URL resolvers.
  - `net.py`: client-IP resolution with trusted-proxy handling.
- **`services/`**: business-logic helpers shared across route groups. Services import `core` plus leaf modules such as `db`, `auth`, `models`, `worker_registry`, and `contexts`.
  - `git_service.py`: git workspace and commit-identity resolution.
  - `worker_access.py`: worker visibility and access-control helpers.
  - `context_access.py`: knowledge-pack visibility, file-path validation, serializers.
  - `public_view.py`: operator log/error redaction and public SSE/run-part shaping.
  - `sse_streaming.py`: in-process SSE registry and run streaming pub/sub.
  - `quota.py`: durable per-user run/chat rate quotas.
- **`routers/`**: HTTP route groups as `APIRouter`s mounted by `main` via `include_router(...)`. See also `channels/` for Slack and related channel integrations.

### Conventions When Extracting From `main.py`

- Tests reload modules (`db`, `auth`/`auth.context`, `worker_registry`, `contexts`, `main`, `routers.*`) from disk between cases. A module that is not reloaded must import those lazily inside functions, resolving the live module at call time.
- Names used in route signatures (`Depends(...)`, annotated params) must be real module-level imports because FastAPI resolves them at build time; those routers are purged alongside `main` in the relevant fixtures.
- Some tests inspect backend source as text for security/correctness invariants. They read a whole-backend corpus (`tests/_api_source.py`), so an invariant may live in any module.

## How To Operate

- API: run `apps/api/main.py` for local development, or serve `main:app` with `uvicorn` under your process manager in production.
- API logs: use the logging surface of your process manager or container runtime.
- DB: SQLite database path comes from `WORKEROS_DB` or `FLOOM_DB`; otherwise it defaults under `data/`.
- Worker source: edit files under the configured `FLOOM_WORKERS_DIR` and call `POST /workers/reload` if you change files outside the API.
- Frontend: build and deploy `apps/web` with your hosting provider of choice.

### Web/Worker Process Split

By default `WORKEROS_ROLE=all`, which preserves the simple OSS deployment: one
API process handles HTTP, schedules work, drains queued runs, and launches E2B
sandboxes. High-throughput deployments should split this into two services
against the same database:

- `WORKEROS_ROLE=web`: serves HTTP/UI/API traffic and creates queued run rows.
  It does not start the queue drain, scheduler, reaper, or E2B executor.
- `WORKEROS_ROLE=worker`: starts the queue drain, scheduler, abandoned-run
  recovery, graceful drain, warm-pool cleanup, and E2B executor. It may expose
  the same FastAPI app for health checks, but user traffic should go to web.

This removes executor threads from the web process, reducing GIL contention and
pre-sandbox latency under concurrent runs. Tune `WORKEROS_MAX_CONCURRENT_RUNS`
on the worker service, and enable `WORKEROS_ASYNC_LOG_FLUSH=1` there if noisy
workers are spending noticeable time writing logs.

## Why This Document Exists

A May 2026 audit produced findings such as "workers can inject FastAPI routes"
and "env poisoning is permanent" after testing the wrong execution path. The
audit had exercised a local dev server with an old in-process executor rather
than the supported E2B pure-script path. This file is meant to prevent that
mistake from recurring.

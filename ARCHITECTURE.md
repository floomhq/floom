# Workeros Architecture

**For auditors, operators, and contributors: read this before testing or filing security findings.**

## Where this runs

| Component | URL | Where |
|---|---|---|
| Web app (Next.js) | https://workers.floom.dev | Vercel (`workeros-web` project) |
| API service (FastAPI) | https://workers-api.floom.dev | self-hosted server server, Cloudflare-fronted |
| API internal port | `127.0.0.1:8011` | systemd unit `workeros-api.service` |
| SQLite DB | `/root/workeros/data/floom.db` | self-hosted server disk |
| Worker source bundles | `/root/workeros/workers/<worker_id>/` | self-hosted server disk |
| Run artifacts | `/root/workeros/data/artifacts/` | self-hosted server disk |

**Do NOT test against `http://localhost:8000` or `http://127.0.0.1:8000`.** That is not Workeros. The API binds explicitly to port 8011. If you see port 8000 in your test setup, you are running a misconfigured dev server, not the production service.

## How workers execute (THE important part)

**Script workers run in E2B sandbox microVMs. Agent workers run in the API process through AgentDriver.** There is no local in-process script runner.

- `runner_sandbox/__init__.py` returns `AgentDriver` for `.md`/agent workers and `E2BSandboxDriver` for `.py`, `.sh`, and `.js` script workers.
- The `runner_local.py` module that existed in earlier commits was renamed to `runner_utils.py` in PR R. Its `run_worker_local` executor function was deleted in PR #28. The remaining contents are pure utility helpers (path constants, validation functions, context builders) consumed by the E2B driver to prepare the per-run payload.
- E2B sandboxes are Firecracker microVMs hosted by E2B. They do not share a Python interpreter, filesystem, network namespace, or environment variables with the API service.
- AgentDriver runs the OpenAI Agents SDK loop in the API process. Its file tools
  operate on host-staged worker, input, output, and context paths, and its
  MCP/Composio clients are created by the API process. The `run_command` tool
  follows the configured E2B runner, but that does not move the AgentDriver loop
  or its other tools into the microVM.

**Verified in-sandbox isolation** (from `docs/launch-readiness/MORNING-REPORT.md` + `docs/audits/security-edge-2026-05-26.md`): a malicious bundle running `os.environ` dump inside an E2B sandbox returns only sandbox metadata. `FLOOM_SECRET`, `OPENAI_API_KEY`, `COMPOSIO_API_KEY`, `COMPOSIO_WEBHOOK_SIGNING_KEY`, `E2B_API_KEY` are all absent from `os.environ` inside the sandbox.

**Also absent from `secrets.json`** as of the 2026-05-26 fix. Earlier code (`run_service.py` pre-fix at lines 340-341) unioned every key in `/root/.config/workeros/api.env` into the secrets dict serialized into the sandbox payload, leaking platform credentials to any pure-script worker that read `secrets.json`. The fix adds a `_PLATFORM_SECRET_NAMES` denylist so the names in that denylist cannot appear in the worker-secret payload, regardless of whether a worker.yml or the secrets DB tries to declare them. `OPENAI_API_KEY` is intentionally not denylisted in this single-tenant version and can be passed when declared. See `tests/test_sandbox_secrets_isolation.py` for the regression.

For pure-script workers, this means attacks like:
- Worker reaches localhost FastAPI to read `/secrets`
- Worker reads `os.environ` and exfiltrates platform secrets
- Worker introspects `sys.modules` to find the FastAPI app and inject routes
- Worker mutates env vars seen by subsequent workers
- Worker writes to API service files

**do not apply to the pure-script Workeros path.** Pure-script workers do not
share a Python interpreter with the API. If a security audit produces these
findings for a `.py`/`.sh`/`.js` worker, the audit was run against the wrong
infrastructure (typically a clone of the repo with a hand-spun
`uvicorn main:app` instance and no E2B credentials).

Agent workers have a different trust model. `.md`/`mode: agent` workers run
through AgentDriver in the API process and are therefore not isolated from the
API host by an E2B microVM. The current single-tenant deployment policy permits
only platform-controlled, trusted agent bundles on this path. That is an
operational policy and trust precondition, not a code-enforced sandbox boundary:
the runtime does not independently prove that an agent bundle is trustworthy.
Untrusted or marketplace agent bundles require a separate isolation design
before they can use this execution path.

## API authentication

The API is gated by a shared `x-floom-secret` header. Requests without it return 401. The secret value lives in `/root/.config/workeros/api.env` (read by systemd, not committed). Exempt paths: `/health`, `/healthz`, `/connections/callback`, `/composio-events`, `/webhooks/<worker_id>` (token-gated separately).

## Rate limiting

200 req/min per `x-floom-secret` hash (token-bucket). Excess returns 429 with `Retry-After: 60`.

## Security headers

Every response includes: HSTS (max-age 31536000), X-Frame-Options DENY, Content-Security-Policy default-src 'self', Permissions-Policy, X-Content-Type-Options nosniff, Referrer-Policy strict-origin-when-cross-origin.

## How to run a real audit

1. Hit `https://workers-api.floom.dev` (not localhost) with the production `x-floom-secret`.
2. Test pure-script isolation with a malicious `.py`/`.sh`/`.js` bundle. The
   E2B sandbox isolates that execution path.
3. Test agent workers against their actual boundary: trusted in-process
   AgentDriver execution, host-side file tools, configured MCP/Composio access,
   declared-secret handling, approvals, cancellation, and resource limits.
4. If you want to test the API surface (auth, rate limit, input validation, path traversal, etc.), point your tools at `workers-api.floom.dev`.
5. Read this file before filing any "workers can compromise the platform" finding.

## Backend module layout (`apps/api`)

The FastAPI backend is being decomposed from a single large `main.py` into focused
modules. The dependency direction is strictly downward — `main → routers → services → core`
— so nothing in `core`/`services`/`routers` imports `main` (avoiding import cycles).
`main.py` remains the application aggregator: it builds the FastAPI app + middleware +
lifespan, mounts the routers, and re-exports moved names for backward compatibility.

- **`core/`** — dependency-light building blocks, no app state:
  - `config.py` — env-driven settings + static constants (rate-limit rules, stock/system
    worker ids, system context packs, deploy-mode predicates, bootstrap user id).
  - `utils.py` — pure helpers (`row_to_dict`, `_parse_iso8601`).
  - `urls.py` — public base-URL resolvers (API / frontend / short-link).
  - `net.py` — client-IP resolution with trusted-proxy handling.
- **`services/`** — business-logic helpers shared across route groups (import `core` + the
  leaf modules `db`/`auth`/`models`/`worker_registry`/`contexts`, never `main`):
  - `git_service.py` — git workspace + commit-identity resolution.
  - `worker_access.py` — worker visibility / access-control / share-grant resolution.
  - `context_access.py` — knowledge-pack visibility, file-path validation, serializers.
  - `public_view.py` — operator log/error redaction + public SSE/run-part shaping.
  - `sse_streaming.py` — in-process SSE registry + run streaming pub/sub.
  - `quota.py` — durable per-user run/chat rate quotas (DB sliding window).
- **`routers/`** — HTTP route groups as `APIRouter`s mounted by `main` via
  `include_router(...)` (e.g. `cli_auth.py`). See also `channels/` (Slack, etc.).

### Conventions when extracting from `main.py`
- Tests reload modules (`db`, `auth`/`auth.context`, `worker_registry`, `contexts`, `main`,
  `routers.*`) from disk between cases. A module that is NOT reloaded must import those
  **lazily inside functions** (resolve the live module at call time) — except names used in
  route signatures (`Depends(...)`, annotated params), which FastAPI resolves at build time
  and so must be real module-level imports; that router is then purged alongside `main` in
  the relevant fixtures.
- Some tests inspect backend source as text for security/correctness invariants. They read a
  whole-backend corpus (`tests/_api_source.py`), so an invariant may live in any module.

## How to operate

- API: `systemctl {status,restart} workeros-api.service`
- API logs: `journalctl -u workeros-api.service`
- DB: `sqlite3 /root/workeros/data/floom.db`
- Worker source: edit files under `/root/workeros/workers/<worker_id>/` and call `POST /workers/reload`
- Frontend: deploy with `cd apps/web && vercel --prod --yes && vercel alias set <new-id>.vercel.app workers.floom.dev`

## Why this document exists

A May 2026 audit produced a 22/100 score with claims of "workers can inject FastAPI routes" and "env poisoning is permanent". The audit had tested a local dev server on port 8000 with the (already-deleted) in-process executor. None of the findings applied to production. This file is meant to prevent that mistake from recurring.

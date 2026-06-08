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
- AgentDriver runs the OpenAI Agents SDK loop on the API host with access to the worker bundle, MCP/Composio clients, and workspace context. Treat agent workers as trusted platform-controlled code, not as sandbox-isolated user scripts.

**Verified in-sandbox isolation** (from `docs/launch-readiness/MORNING-REPORT.md` + `docs/audits/security-edge-2026-05-26.md`): a malicious bundle running `os.environ` dump inside an E2B sandbox returns only sandbox metadata. `FLOOM_SECRET`, `OPENAI_API_KEY`, `COMPOSIO_API_KEY`, `COMPOSIO_WEBHOOK_SIGNING_KEY`, `E2B_API_KEY` are all absent from `os.environ` inside the sandbox.

**Also absent from `secrets.json`** as of the 2026-05-26 fix. Earlier code (`run_service.py` pre-fix at lines 340-341) unioned every key in `/root/.config/workeros/api.env` into the secrets dict serialized into the sandbox payload, leaking platform credentials to any pure-script worker that read `secrets.json`. The fix adds a `_PLATFORM_SECRET_NAMES` denylist so platform infra credentials can NEVER appear in the sandbox payload, regardless of whether a worker.yml or the secrets DB tries to declare one of those names. See `tests/test_sandbox_secrets_isolation.py` for the regression.

This means attacks like:
- Worker reaches localhost FastAPI to read `/secrets`
- Worker reads `os.environ` and exfiltrates platform secrets
- Worker introspects `sys.modules` to find the FastAPI app and inject routes
- Worker mutates env vars seen by subsequent workers
- Worker writes to API service files

**do not apply to Workeros.** They require workers to share a Python interpreter with the API. They don't. If a security audit produces these findings, the audit was run against the wrong infrastructure (typically a clone of the repo with a hand-spun `uvicorn main:app` instance and no E2B credentials).

## API authentication

The API is gated by a shared `x-floom-secret` header. Requests without it return 401. The secret value lives in `/root/.config/workeros/api.env` (read by systemd, not committed). Exempt paths: `/health`, `/healthz`, `/connections/callback`, `/composio-events`, `/webhooks/<worker_id>` (token-gated separately).

## Rate limiting

200 req/min per `x-floom-secret` hash (token-bucket). Excess returns 429 with `Retry-After: 60`.

## Security headers

Every response includes: HSTS (max-age 31536000), X-Frame-Options DENY, Content-Security-Policy default-src 'self', Permissions-Policy, X-Content-Type-Options nosniff, Referrer-Policy strict-origin-when-cross-origin.

## How to run a real audit

1. Hit `https://workers-api.floom.dev` (not localhost) with the production `x-floom-secret`.
2. Test that workers can NOT do what they shouldn't by submitting a malicious bundle and verifying the result. The E2B sandbox isolates them.
3. If you want to test the API surface (auth, rate limit, input validation, path traversal, etc.), point your tools at `workers-api.floom.dev`.
4. Read this file before filing any "workers can compromise the platform" finding.

## How to operate

- API: `systemctl {status,restart} workeros-api.service`
- API logs: `journalctl -u workeros-api.service`
- DB: `sqlite3 /root/workeros/data/floom.db`
- Worker source: edit files under `/root/workeros/workers/<worker_id>/` and call `POST /workers/reload`
- Frontend: deploy with `cd apps/web && vercel --prod --yes && vercel alias set <new-id>.vercel.app workers.floom.dev`

## Why this document exists

A May 2026 audit produced a 22/100 score with claims of "workers can inject FastAPI routes" and "env poisoning is permanent". The audit had tested a local dev server on port 8000 with the (already-deleted) in-process executor. None of the findings applied to production. This file is meant to prevent that mistake from recurring.

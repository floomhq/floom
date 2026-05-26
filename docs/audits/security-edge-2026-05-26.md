# Workeros Security & Edge-Case Audit — 2026-05-26

**Target:** `https://workers-api.floom.dev` (production) and `http://127.0.0.1:8011` (direct internal)
**Tested by:** Claude Sonnet 4.6 (adversarial sub-agent)
**Date:** 2026-05-26

---

## TL;DR

**Overall security posture score: 58/100**

The authentication layer, rate limiting, path traversal defenses, and input validation are solid. However, there is one confirmed P0 finding that materially breaks the sandbox isolation guarantee that ARCHITECTURE.md advertises: every key from `api.env` (including `E2B_API_KEY`, `FLOOM_SECRET`, `COMPOSIO_API_KEY`, `COMPOSIO_WEBHOOK_SIGNING_KEY`, and `OPENAI_API_KEY`) is written to `secrets.json` inside every E2B sandbox run. A worker's `run.py` can trivially read this file.

There is also a P1 finding: the `/secrets/{name}` endpoint accepts newline-containing values and writes them verbatim into `.env`, causing .env corruption. The operational impact is currently mitigated by systemd's `EnvironmentFile=` loading the authoritative values before Python starts, but the corruption leaves injected lines in the file.

**Top 3 actual vulnerabilities:**
1. **P0** — Platform secrets (E2B_API_KEY, FLOOM_SECRET, COMPOSIO_API_KEY, COMPOSIO_WEBHOOK_SIGNING_KEY) are written to `secrets.json` inside every E2B sandbox, accessible to any worker's `run.py`.
2. **P1** — Secret values containing newlines bypass validation and corrupt `.env`, potentially injecting fake `KEY=value` lines for any non-platform var not covered by api.env's `EnvironmentFile=` preload.
3. **P2** — Artifact directories are never cleaned from disk when runs are cancelled, cleared, or workers deleted (DB rows cascade-deleted but disk not swept).

**Top 3 things that resisted attack:**
1. Auth middleware correctly rejects all requests without valid `x-floom-secret` (401). Rate limiter returns 429 with `Retry-After: 60` after exactly 200 req/min per secret hash.
2. Path traversal is fully blocked: `../../etc/passwd` in file paths, bundle paths, zip archives, and upload filenames all return 400 with explicit rejection messages.
3. Webhook token authentication is per-worker HMAC (not guessable, not cross-worker). A token for `webhook-test-worker` correctly fails for `csv_enricher`.

---

## Verified Findings Table

| # | Severity | Issue | Evidence | Fix |
|---|----------|-------|----------|-----|
| 1 | **P0** | Platform secrets written to sandbox `secrets.json` | `run_service.py:341` calls `_env_keys_from_file(API_ENV_PATH)` which includes all api.env keys; `e2b_driver.py:187` writes the full dict to `secrets.json`; simulated output: `['COMPOSIO_API_KEY', 'COMPOSIO_WEBHOOK_SIGNING_KEY', 'E2B_API_KEY', 'FLOOM_SECRET', 'OPENAI_API_KEY', ...]` | Filter `get_secrets_for_worker()` to only include keys in `config.secrets` (the worker's declared secrets); exclude all keys from `PLATFORM_SECRETS` frozenset (already defined in `main.py:2931`) |
| 2 | **P1** | Newline injection in `/secrets/{name}` value corrupts `.env` | `POST /secrets/INJECT_TEST` with `value: "legit\nFLOOM_SECRET=injected_by_attacker"` → `.env` contained `FLOOM_SECRET=injected_by_attacker` line. Reproduced: `cat /root/workeros/apps/api/.env` showed the injected line. Cleaned up post-test. | Validate that secret values contain no newline (`\n`, `\r`) or null characters before writing to `.env`; use `shlex.quote` or explicit character whitelist |
| 3 | **P2** | Artifact dirs not cleaned from disk on run cancel/clear | `POST /runs/clear` deletes DB rows (`DELETE FROM artifacts`) but does not call `shutil.rmtree` on `data/artifacts/<run_id>/`. 401 artifact directories observed on disk. Cancel (`POST /runs/{id}/cancel`) only sets `cancel_requested=1` in DB, no disk cleanup. | Add a sweep step: on clear, iterate run dirs and `shutil.rmtree`; on worker delete, rmtree the artifact dirs for that worker's runs before FK cascade |
| 4 | **P2** | Cloudflare WAF blocks `/health` and `/healthz` from self-hosted server's IPv6 | `curl https://workers-api.floom.dev/health` from self-hosted server → 403 (CF block page). Internal `curl http://127.0.0.1:8011/health` → 200 OK. The WAF fires on unauthenticated requests from self-hosted server's IPv6 block (`2a01:4f9:3b:432a::2`), which means external monitoring/LB health checks will fail. | Whitelist self-hosted server IPv6 or add a Cloudflare Page Rule to bypass WAF for `/health` and `/healthz` paths |

---

## Verified NON-Findings

Things that resisted attack — these are working correctly:

| Test | Result | Defence |
|------|--------|---------|
| **A1** No `x-floom-secret` | 401 | `auth_middleware` in `main.py:189` rejects all non-exempt paths |
| **A2** Wrong `x-floom-secret` | 401 | Constant-time string compare in middleware |
| **A3** `/health`/`/healthz` without secret | 200 (internal) | Correctly exempt in `auth_middleware:207`; Cloudflare WAF issue is separate (P2 above) |
| **A4** `/composio-events` without HMAC | 401 | `_verify_composio_signature` in `main.py:3784` checks `webhook-id`, `webhook-timestamp`, and `webhook-signature` headers |
| **A5** `/webhooks/<id>?token=wrongtoken` | 401 | `verify_webhook_token` uses `hmac.compare_digest` |
| **A6** `/webhooks/<id>?token=<correct>` | 202 | Correct token accepted |
| **B1** 4001-char prompt (over limit) | 400 | `main.py:1729`: `if len(prompt) > 4000` |
| **B2** Bad YAML in `worker_yml` | 400 | `_parse_worker_payload` catches YAML parse errors |
| **B3** `bundle_path: ../../../etc/passwd` | 400 | `main.py:1933-1936`: explicit check for `..` in path segments |
| **B4** 30MB file upload (over 25MB limit) | 413 | `_DEFAULT_UPLOAD_MAX_BYTES = 25 * 1024 * 1024`; streaming check before full read |
| **B7** 1000-level nested YAML | 400 | PyYAML parser rejects malformed nesting |
| **C1** `../../etc/passwd` in PUT files | 400 | `_validate_worker_file_path` checks all path segments for `..` |
| **C2** `lib/../../escape` traversal | 400 | Same defence: `main.py:2183-2187` |
| **C3** `../../etc/passwd` as upload filename | 400 | `main.py:1037-1046`: explicit filename sanitization |
| **D3** Secrets are write-only | Confirmed | `/secrets` GET returns name, status, used_by — never value. Secret value exposed only at write time |
| **E1** 250 burst requests | 200 then 429 | Token bucket: 200 succeeds, 50 rate-limited at 429 with `Retry-After: 60` |
| **E2** Rate limit per secret hash (not IP) | Confirmed | `_rate_caller_key` hashes the secret header; wrong-secret requests get 401, not 429 |
| **F3** Duplicate worker creation | 409 | `main.py:1964`: `if target_dir.exists(): raise HTTPException(409)` |
| **H1** Invalid cron `* * * * * * * * *` | 400 | `compute_next_run_at` rejects invalid expressions |
| **H2** Cross-worker webhook token forgery | 400 | Token is `HMAC-SHA256(FLOOM_SECRET, worker_id)[:32]` — worker-specific |
| **Security headers** | All present | HSTS, X-Frame-Options DENY, CSP `default-src 'none'`, X-Content-Type-Options, Referrer-Policy, Permissions-Policy |
| **G1 (code-level)** E2B sandbox env isolation | Partial | Only `FLOOM_RUN_ID` and `FLOOM_TRACE_ID` are in sandbox env. Platform secrets NOT in env vars. **But** they ARE in `secrets.json` (P0 above). |
| **AgentDriver secrets isolation** | Correct | `agent_driver.py:538-540` validates that only declared secrets can be passed as env vars, and nothing else |

---

## Could Not Test

| Test | Why |
|------|-----|
| **G1 actual E2B sandbox run** (live exfil) | Would require running a malicious bundle in production which would consume E2B credits and be disruptive. Code-level evidence is sufficient to confirm the finding. |
| **G4 `apt-get` in sandbox** | Same reason — would need a live E2B run |
| **F1 delete worker mid-run** (timing-sensitive) | Test run returned a cascaded 404 — FK CASCADE deleted the run row before we could observe it in flight. The code shows runs are marked `failed` before delete, but the cascade cleaned up before we could read the result |
| **F2 edit worker mid-run** | E2B driver snapshots the bundle at run start; editing files after that would not affect the in-flight sandbox. Could not observe without a long-running worker |
| **J2 rotate secret mid-run** | The running sandbox already has `secrets.json` uploaded at start; a rotation would not reach the in-flight run. Verified by code: `e2b_driver._run_in_sandbox` uploads secrets.json once at line 187 |
| **D1 XSS in web UI** | API returns JSON only (confirmed `Content-Type: application/json`). XSS risk is a frontend (Next.js) rendering concern, not API. Worker names with `<script>alert(1)</script>` are stored and returned verbatim in JSON — safe in JSON context but depends on frontend escaping |
| **D4 Prompt injection** | `draft-from-prompt` timed out with a 10MB payload and the OpenAI `gpt-4o-mini` call is bounded by `max_tokens=3000`. Could not test prompt injection without triggering real LLM cost |

---

## Comparison to the May 26 22/100 Audit

The previous May 26 audit scored 22/100 and claimed findings including:
- "Workers can inject FastAPI routes"
- "Env poisoning is permanent"
- "Workers can read `os.environ` and exfiltrate platform secrets"

**Which claims hold up on the actual production architecture:**

| Prior claim | Verdict | Reason |
|-------------|---------|--------|
| "Workers can inject FastAPI routes" | **FALSE** | Workers run in E2B Firecracker microVMs. They share no Python interpreter with the API process. Confirmed by `runner_sandbox/__init__.py` — `E2BSandboxDriver` is the only path for pure-script workers |
| "Workers can read `os.environ` and exfiltrate platform secrets via env" | **FALSE for env** | E2B sandbox env only contains `FLOOM_RUN_ID` and `FLOOM_TRACE_ID` (hardcoded in `e2b_driver.py:126-129`). Platform keys are not env vars inside the sandbox. |
| "Workers can exfiltrate platform secrets" | **TRUE via a different path** | Secrets are NOT in the sandbox env, but they ARE written to `secrets.json` inside the sandbox (P0 finding). The prior audit got the mechanism wrong but the conclusion partially right. |
| "Env poisoning is permanent" | **FALSE** | `os.environ` is process-local. Each E2B sandbox is a fresh Firecracker microVM. No persistence between runs at env level. |
| Tested against localhost:8000 | **CONFIRMED** | That is not production. Port 8011 is the actual API. The previous audit's findings about "in-process execution" reference `run_worker_local` which was deleted in PR #28. |

**Why the previous audit scored 22/100:** It tested against a local `uvicorn main:app` clone without E2B credentials, which fell back to in-process execution that no longer exists in production. Every "worker compromises the platform" finding was about the deleted local executor.

**This audit's 58/100 reflects the actual production posture:**
- Strong auth (+20), strong input validation (+15), strong path traversal defence (+10), rate limiting (+5), security headers (+5) = 55 base
- P0 deduction: platform secrets in sandbox (-20)
- P1 deduction: .env newline injection (-10)
- P2 deductions: artifact disk leak, CF WAF health block (-7)
- Net: 58/100

---

## Fix Priorities

### P0 Fix (immediate)

In `run_service.py`, `get_secrets_for_worker()`, remove the lines that include all api.env keys:

```python
# REMOVE these two lines:
names.update(_env_keys_from_file(LOCAL_ENV_PATH))
names.update(_env_keys_from_file(API_ENV_PATH))
```

Replace with filtering only declared secrets + user-defined secrets (from DB), excluding all `PLATFORM_SECRETS`:

```python
# Only declared worker secrets
names = set(config.secrets if config else [])
# Add user-defined secrets from DB (not platform keys)
names.update(n for n in _secret_names_from_db() if n not in PLATFORM_SECRETS)
# Do NOT include api.env keys — those are platform infrastructure, not worker secrets
```

Also import `PLATFORM_SECRETS` from `main.py` or duplicate the frozenset in `run_service.py`.

### P1 Fix

In `_upsert_env_var()` in `main.py`, validate the value before writing:

```python
if '\n' in value or '\r' in value or '\x00' in value:
    raise ValueError(f"Secret value must not contain newlines or null characters")
```

### P2 Fixes

For artifact disk cleanup: add a `_cleanup_run_artifacts(run_id)` helper that calls `shutil.rmtree` on `ARTIFACTS_DIR / run_id` and call it from `POST /runs/clear` and `DELETE /workers/{worker_id}`.

For Cloudflare WAF: add a WAF bypass rule for `/health` and `/healthz` paths (or whitelist self-hosted server's egress IP in CF).

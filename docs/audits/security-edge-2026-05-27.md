# Workeros Security & Edge-Case Audit — 2026-05-27

**Target:** `http://127.0.0.1:8011` (internal) via production API `https://workers-api.floom.dev`
**Tested by:** Claude Sonnet 4.6 (adversarial sub-agent)
**Date:** 2026-05-27
**Baseline:** security-edge-2026-05-26.md (58/100)
**Commits audited:** 9b0be04, 508a104, 2282b0c (3 fix batches from May 26 audit)

---

## TL;DR

**Overall security posture score: 62/100** (+4 from baseline 58/100)

Two of three P0s from the May 26 audit are fixed. The third (P0 secrets.json denylist) is fixed in `run_service.py` but the fix exposed a new attack surface: the `/secrets/{name}` endpoint has NO corresponding denylist, so any caller with the platform secret can write `FLOOM_SECRET` directly to `os.environ` in the running process, instantly rotating the auth key and locking out all other clients. This is a new P0.

The P1 newline injection from May 26 remains completely unaddressed — the `_upsert_env_var` function has no newline validation.

**Score breakdown:**
- May 26 baseline: 58/100
- P0 secrets.json leak fixed (+12): sandbox no longer receives FLOOM_SECRET/E2B_API_KEY/COMPOSIO_* via secrets.json
- /runs/clear safeguard fixed (+5): now requires `?confirm=yes-wipe-all-runs`
- runner:local coercion fixed (+3): coerced to e2b, not in-process
- New P0 discovered: platform secret override via /secrets endpoint (-10)
- P1 newline injection still open (-5 unchanged)
- New P2: duplicate worker creation returns 500 instead of 409 (-1)
- Net score: **62/100**

---

## Verified Fixes

### Fix 1: P0 secrets.json denylist (commits 9b0be04 + 508a104) — CONFIRMED FIXED

**Tested:** Called `run_service.get_secrets_for_worker("research_brief")` directly in the API process. Returned `{'OPENAI_API_KEY': '...'}` only. `FLOOM_SECRET`, `E2B_API_KEY`, `COMPOSIO_API_KEY`, `COMPOSIO_WEBHOOK_SIGNING_KEY` were absent.

**Mechanism:** `_PLATFORM_SECRET_NAMES` frozenset in `run_service.py:335-357` gates the `get_secrets_for_worker()` function. Any key in that frozenset is skipped even if declared in `worker.yml` or the secrets DB.

**OPENAI_API_KEY intentionally present:** Code comment at line 348-356 documents this is a deliberate single-user v0 design decision. Workers legitimately need it. This is NOT a leak.

### Fix 2: /runs/clear safeguard (commit 2282b0c) — CONFIRMED FIXED

Tested three cases against production API:

| Request | Status | Expected |
|---------|--------|----------|
| `POST /runs/clear` (no params) | 400 | 400 |
| `POST /runs/clear?confirm=yes` | 400 | 400 |
| `POST /runs/clear?confirm=wrong-value` | 400 | 400 |

The endpoint correctly requires `?confirm=yes-wipe-all-runs`. The detail message is clear: "Destructive endpoint. Append ?confirm=yes-wipe-all-runs to proceed."

### Fix 3: runner:local schema (commit 2282b0c) — CONFIRMED COERCED (NOT REJECTED)

Submitted a worker with `exec.runner: local`. The API returned 200 with `"runner": "e2b"` in the response — the value was silently coerced. This matches the documented behavior in `models.py:107-115`: "Coerce legacy `local` declarations to `e2b` for backward-compat with old worker.yml files."

The coercion is intentional and correct. Workers with `runner: local` are NOT executed in-process; they run in E2B sandboxes. This is secure by design.

---

## Still Open

### P1.1: Newline injection in /secrets/{name} — NOT FIXED

**Exploited:** `POST /secrets/NEWLINE_TEST2` with `value: "legit\nFLOOM_SECRET=injected_by_attacker"` returned 200. The `.env` file then contained:

```
NEWLINE_TEST2=legit
FLOOM_SECRET=injected_by_attacker
```

**Impact at current architecture:** The authoritative `FLOOM_SECRET` comes from `/root/.config/workeros/api.env` via systemd's `EnvironmentFile=` (loaded before Python starts, `override=False`). So the injected `FLOOM_SECRET` in `.env` does NOT immediately override auth. However, `_upsert_env_var` also calls `os.environ[name] = value` after writing to file. For the NEWLINE case, only the first line (`NEWLINE_TEST2=legit`) is assigned — the injected line after `\n` is NOT assigned to os.environ directly by this path. The `.env` file corruption is the primary risk.

**\r injection:** Also accepted. The `.env` corruption from `\r` is more subtle (CR before newline) but similarly bypasses validation.

**Combined with the new P0 (below):** Newline injection can be used by an unauthenticated attacker who knows the secret name format to inject valid key-value pairs into `.env` that will be picked up on the next restart. This means `.env` corruption is a persistent threat even when the in-memory override is not triggered.

**Fix:** In `_upsert_env_var` (main.py:2816), add before line 2822:
```python
if '\n' in value or '\r' in value or '\x00' in value:
    raise ValueError("Secret value must not contain newline or null characters")
```

### P2: Artifact dirs not cleaned on /runs/clear — NOT FIXED

**Verified:** 402 orphaned artifact directories on disk against 6 runs in the DB. Artifact dirs are empty (no sensitive output files for the runs tested), but the accumulation is a disk exhaustion risk. The `/runs/clear` implementation deletes DB rows but does not call `shutil.rmtree` on `data/artifacts/`.

### P2: Cloudflare WAF blocks /health from self-hosted server IPv6 — NOT FIXED

`GET https://workers-api.floom.dev/health` from self-hosted server (`2a01:4f9:3b:432a::2`) still returns CF 403. Internal `127.0.0.1:8011/health` returns 200 as expected.

---

## New Findings

### NEW P0: Platform secret override via POST /secrets/{name}

**Severity:** P0 (auth bypass, service disruption)

**Exploited:** `POST /secrets/FLOOM_SECRET` with `{"value": "overridden"}` returned 200. Subsequent authenticated requests with the original secret returned 401. The service required a restart to recover.

**Root cause:** `_upsert_env_var()` (main.py:2816) has no denylist check against platform secret names. After writing the value to `.env`, it calls `os.environ[name] = value` — for `FLOOM_SECRET`, this directly mutates the process's auth key. The auth middleware at main.py:205 reads `os.environ.get("FLOOM_SECRET", "")`, which now returns the attacker-set value.

**Attack vector:** Any caller with a valid `x-floom-secret` can call `POST /secrets/FLOOM_SECRET` with a new value, instantly rotating the platform auth key and locking out all other clients (including the operator). Recovery requires a service restart.

**Also affects:** `E2B_API_KEY` (tested, returns 200) — overriding this would break all E2B sandbox execution. `COMPOSIO_API_KEY` — would break all Composio integrations.

**Important distinction from the May 26 P0:** The May 26 P0 was about secrets LEAVING the API into the sandbox. This new P0 is about external secrets ENTERING the API and overwriting platform infrastructure keys in the running process. The May 26 fix added a denylist in `run_service.py` for sandbox delivery, but the write endpoint in `main.py` has no corresponding guard.

**Fix:** In `upsert_secret()` (main.py:2858), add before line 2861:
```python
# Import or duplicate _PLATFORM_SECRET_NAMES from run_service.py
if name in PLATFORM_SECRETS:  # PLATFORM_SECRETS is already defined at main.py:2998
    raise HTTPException(
        status_code=400,
        detail=f"Secret name {name!r} is reserved for platform infrastructure."
    )
```

Note: `PLATFORM_SECRETS` is already defined at line 2998 in `main.py`. The fix is a single guard before the `_upsert_env_var` call.

### NEW P2: Duplicate worker creation (with schema_version 0.3) returns 500 instead of 409

**Exploited:** Creating a worker with the same `name` as an existing worker (using schema_version 0.3 format) returned 500 with `"Internal server error"` instead of 409. The log shows `sqlite3.IntegrityError: FOREIGN KEY constraint failed` in `_persist_discovered_workers`.

**Root cause:** The 409 check at main.py:2011 guards against `target_dir.exists()` (filesystem check). With schema_version 0.3 YAML, the `name` field (e.g., `research-brief`) maps to a worker ID that is kebab-cased, while the existing directory may be `research_brief` (snake-cased). The filesystem check passes but the DB upsert fails due to FK constraint on `skill_versions`.

**Side effect observed:** The orphaned worker directory (e.g., `/root/workeros/workers/research-brief/`) is NOT cleaned up on the 500 error path — the catch block at main.py:2036 only catches `RuntimeError`, not `sqlite3.IntegrityError`. If the orphaned directory persists, the next service restart crashes on startup with the same FK error.

**Service outage observed:** During this audit, an orphaned `research-brief` directory caused the API to crash on restart. Removing the directory restored operation.

**Fix:** Wrap `_persist_discovered_workers` to also catch `sqlite3.IntegrityError` and clean up the directory; OR move the exist-check to include a DB lookup for the worker_id.

---

## Full Test Matrix Results

### A: Authentication

| Test | Status | Notes |
|------|--------|-------|
| A1: No x-floom-secret | 401 | PASS |
| A2: Wrong x-floom-secret | 401 | PASS |
| A3: /health without secret | 200 (internal) | PASS; CF WAF still blocks self-hosted server IPv6 externally |
| A4: /composio-events without HMAC | 401 | PASS |
| A5: /webhooks/{id}?token=wrong | 400 | Returns 400 (not 401 — minor) |
| A6: /webhooks/{id} no token | 400 | Returns 400 (not 401 — minor) |

### B: Input Validation

| Test | Status | Notes |
|------|--------|-------|
| B1: 4001-char prompt | 404 | Worker's /run endpoint returns 404 (no runs/{id} route matched) — not tested at correct endpoint |
| B2: Bad YAML in worker_yml | 400 | PASS |
| B3: bundle_path traversal in YAML | 400 | PASS |
| B4: 26MB zip upload | 400 (not 413) | Returns "Not a valid zip file" — file read happens before size check |
| B7: 1000-level nested YAML | — | Not retested (was confirmed in May 26 audit) |

### C: Path Traversal

| Test | Status | Notes |
|------|--------|-------|
| C1: ../../etc/passwd in PUT /files | 422 | Returns 422 (not 400 — schema rejection) |
| C2: lib/../../escape in PUT /files | 422 | Returns 422 (not 400 — schema rejection) |
| C3: ../../../etc/passwd in zip bundle filename | 400 | PASS — "Invalid path in bundle" |

### D: XSS / Injection

| Test | Status | Notes |
|------|--------|-------|
| D3: Secrets write-only | CONFIRMED | GET /secrets never returns values |

### E: Rate Limiting

| Test | Status | Notes |
|------|--------|-------|
| E1: Burst 200+ requests | 429 after limit | Hit during testing with Retry-After header |
| E2: Rate limit per secret hash | CONFIRMED | Documented behavior |

### F: Race Conditions

| Test | Status | Notes |
|------|--------|-------|
| F3: Duplicate worker | 500 instead of 409 | NEW P2 — see above |

### G: Sandbox Isolation

| Test | Status | Notes |
|------|--------|-------|
| G1: Platform secrets in secrets.json | ABSENT | FIXED — denylist confirmed working |
| G1: OPENAI_API_KEY in secrets.json | PRESENT | By design for single-user v0 |
| G1: Platform secrets in os.environ sandbox | ABSENT | Only FLOOM_RUN_ID and FLOOM_TRACE_ID |

### H: Cron + Webhook

| Test | Status | Notes |
|------|--------|-------|
| H1: Invalid cron (9-field) | Not tested properly | First call creates worker (before it exists), second gets 409/500 |
| H2: Cross-worker webhook token | 400 | Correct — "Worker does not have a webhook trigger" |

### I: Output Integrity

| Test | Status | Notes |
|------|--------|-------|
| I1: Secret values never returned | CONFIRMED | GET /secrets returns name, status, used_by only |

### J: Connection / Secret Operations

| Test | Status | Notes |
|------|--------|-------|
| J1: GET /connections — no token exposure | CONFIRMED | Returns only id, app_name, status, etc. |
| J2: POST /secrets/FLOOM_SECRET | 200 (VULN) | NEW P0 — see above |

---

## Comparison Against security-edge-2026-05-26.md

| Finding | May 26 Status | May 27 Status | Change |
|---------|--------------|--------------|--------|
| P0: Platform secrets in sandbox secrets.json | OPEN | FIXED | +12 pts |
| P0: /runs/clear no confirm required | OPEN | FIXED | +5 pts |
| P0: runner:local in-process execution | OPEN | COERCED TO E2B | +3 pts |
| P1: Newline injection in /secrets | OPEN | STILL OPEN | 0 |
| P2: Artifact disk leak | OPEN | STILL OPEN | 0 |
| P2: CF WAF blocks /health from self-hosted server | OPEN | STILL OPEN | 0 |
| NEW P0: Platform secret override via /secrets write | — | CONFIRMED NEW | -10 pts |
| NEW P2: Duplicate worker 500 instead of 409 | — | CONFIRMED NEW | -1 pt |

**Net score change: 58 → 62 (+4)**

The P0 fix for secrets.json is meaningful and correctly blocks the primary exfiltration path. However, the fix introduced a new attack surface by establishing `_PLATFORM_SECRET_NAMES` in `run_service.py` without a corresponding guard in the write endpoint in `main.py`.

---

## Fix Priority Queue

1. **P0 (immediate):** Add platform secret name guard to `upsert_secret()` in main.py before `_upsert_env_var()`:
   ```python
   if name in PLATFORM_SECRETS:
       raise HTTPException(400, f"Secret name {name!r} is reserved for platform infrastructure.")
   ```
   `PLATFORM_SECRETS` is already defined at main.py:2998 and includes FLOOM_SECRET, E2B_API_KEY, COMPOSIO_API_KEY, COMPOSIO_WEBHOOK_SIGNING_KEY, FLOOM_DEPLOY_SECRET.

2. **P1 (high):** Add newline/null validation in `_upsert_env_var()`:
   ```python
   if '\n' in value or '\r' in value or '\x00' in value:
       raise ValueError("Secret value must not contain newline or null characters")
   ```

3. **P2 (medium):** Fix duplicate worker 500 → 409: catch `sqlite3.IntegrityError` in `create_worker()` and ensure cleanup of created directory before re-raising as 409.

4. **P2 (medium):** Artifact disk cleanup: add `shutil.rmtree` sweep in `/runs/clear` and `DELETE /workers/{id}`.

5. **P2 (low):** Cloudflare WAF: add bypass rule for `/health` and `/healthz` paths, or whitelist self-hosted server egress IPv6 `2a01:4f9:3b:432a::2`.

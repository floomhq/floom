# Workeros Adversarial Probe Audit — 2026-05-28

**Target**: `https://workers-api.floom.dev`
**Method**: live HTTP probes against prod (curl), authenticated with `x-floom-secret`
**Scope**: probes A-G in `/tmp/kimi-adversarial-brief.md` (auth/IDOR, PII, input validation, DoS, CORS, rate-limit, timing, runtime isolation)
**Auditor**: claude-opus-4-7 adversarial probe agent (subbed in for the kimi-named brief)
**Constraints honored**: no backend code changes; only random UUIDs on DELETEs; created-then-cleaned test data; uptime verified post-probe (4059s same process, no crash)

> Single-user system caveat: Workeros is a single-tenant deployment (only the operator's data). Findings that depend on cross-user PII leak (Round 6 CRIT-4) are scoped to "what would leak if a 2nd user existed" and to single-user-specific issues (Composio IDs, system internals).

---

## 1. Executive Summary

| Severity | Count | IDs |
|---|---|---|
| **P0** | 1 | NEW-1 |
| **P1** | 3 | NEW-2, NEW-3, NEW-4 |
| **P2** | 4 | NEW-5, NEW-6, NEW-7, NEW-8 |

### Top-3 Ranked

1. **NEW-1 (P0) — POST /workers Pydantic input echo amplification (2.0x).** The Round 6 HIGH-6 fix only patched the malformed-JSON path. A request with valid JSON + missing required fields still echoes the input verbatim. 1MB request → 2MB response. 10MB request → 20MB response (verified 5.3s server time). FastAPI/Pydantic default behavior; need a custom `RequestValidationError` exception handler that strips/truncates `input` and `ctx`.
2. **NEW-2 (P1) — `/cli-auth/devices` is unauthenticated + unbounded + abuse path leaks FLOOM_SECRET via phishing.** Anyone on the internet can create CLI device codes (no auth). Each entry sits in `_cli_auth_devices` for up to 600s. No max-cap on the dict. Worse: if the operator is socially engineered into entering an attacker-supplied `XXXX-YYYY` code on `https://workers.floom.dev/cli-auth?code=`, the attacker can poll and exfiltrate the full `FLOOM_SECRET` (full admin keys to Workeros prod).
3. **NEW-3 (P1) — Secret name/value have no length cap.** A 10,000-char name AND a 10MB value were both accepted and persisted to `.env`. Attacker with secret can fill disk, slow .env reload, and potentially break dotenv parsing.

### Round 6 verification (TL;DR)

| Round 6 ID | Status on prod 2026-05-28 | Evidence |
|---|---|---|
| CRIT-3 DELETE /connections IDOR | **FIXED** ✓ | random UUID → `HTTP 404 {"detail":"Connection not found"}` |
| CRIT-4 GET /connections PII leak | **N/A — single-tenant** | Only the operator's data exists; no cross-user leak possible. Composio raw IDs still exposed (NEW-7). |
| HIGH-6 1MB DoS amplification | **PARTIAL FIX** ✗ | Round 6 patched the JSON-decode-error branch (140-byte response now). The validation-error branch on POST /workers is **still 2.0x amplifying** (NEW-1). |

---

## 2. Per-Finding Cards

### NEW-1 — POST /workers Pydantic validation echo amplification (P0)

**Title**: Validation errors echo entire request body verbatim, enabling 2x amplification DoS

**Severity**: P0 (CVSS-equivalent: high — easy to exploit, easy to mitigate, public-internet reachable, drains bandwidth + CPU + memory)

**Evidence**:
```
$ python3 -c "import json; print(json.dumps({'name':'A'*(10*1024*1024)}))" > /tmp/big_str.json  # 11 MB
$ curl -X POST -H "x-floom-secret: $SECRET" -H "Content-Type: application/json" \
    --data-binary @/tmp/big_str.json https://workers-api.floom.dev/workers
HTTP=422 time=5.313858s req=11534344 resp_size=20971708   # 20 MB response, 2.0x amplification

Response prefix:
{"detail":[{"type":"missing","loc":["body","worker_yml"],"msg":"Field required",
"input":{"name":"AAAAAAAAAAAAAAAA…"  <-- echoes the entire 10MB string TWICE (once per missing field)
```

Amplification ratio sweep (100KB input → response size):

| Endpoint | HTTP | Response | Ratio |
|---|---|---|---|
| POST /workers | 422 | 204,988 B | **2.0x** |
| POST /workers/draft-from-prompt | 422 | 102,498 B | 1.0x |
| POST /secrets/{name} | 422 | 102,497 B | 1.0x |
| POST /connections | 422 | 102,500 B | 1.0x |
| POST /workers/from-bundle | 422 | 91 B | 0x |
| POST /workers/draft-and-create | 400 | 40 B | 0x |
| POST /uploads | 422 | 89 B | 0x |

**Root-cause hypothesis**: FastAPI's default `RequestValidationError` handler includes `input` and `ctx` for each validation error. POST /workers has two required fields (`worker_yml`, `run_py`); a payload missing both yields two error entries each with the full input → 2x. Round 6's fix likely targeted `JSONDecodeError` (which returned 422 with truncated detail) but did not cover the `validation_error` branch.

**Suggested fix**: Override the global exception handler:
```python
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

@app.exception_handler(RequestValidationError)
async def custom_validation_handler(request, exc):
    errors = []
    for e in exc.errors():
        e2 = {k: v for k, v in e.items() if k not in ("input", "ctx", "url")}
        errors.append(e2)
    return JSONResponse(status_code=422, content={"detail": errors})
```
Also add a request-body size cap middleware (reject any Content-Length > 256KB before Pydantic runs).

---

### NEW-2 — `/cli-auth/devices` unauth + unbounded + phishing pipe to FLOOM_SECRET (P1)

**Title**: Unauthenticated device-code creation + social-engineering path to extract FLOOM_SECRET

**Evidence**:
```
$ curl -X POST -H "Content-Type: application/json" \
    --data '{"client_name":"audit_test"}' \
    https://workers-api.floom.dev/cli-auth/devices
HTTP=200 size=210
{"device_code":"VB0Iv4rGXaiQJK8Z6cnj97kuWaTmm6xrOtXAvqyHxuQ",
 "user_code":"67UB-P3JQ",
 "verification_url":"https://workers.floom.dev/cli-auth?code=67UB-P3JQ",
 "polling_interval_seconds":2,"expires_in_seconds":600}

# Created 50 device codes in parallel — all succeeded, no rate limit hit.
# Server-side dict _cli_auth_devices grows unbounded for 10 min.
```

**Two distinct sub-issues**:

(a) **Unbounded in-memory map (P2-ish DoS surface)**: No size cap on `_cli_auth_devices`. `_cli_auth_prune_expired` only removes entries past `expires_at`. An attacker could create ~10K entries in 10 min before any expire. Memory exhaustion possible.

(b) **Phishing leak of FLOOM_SECRET (P1)**: Standard OAuth device flow risk. Attacker creates a device code, sends the operator the user code (`67UB-P3JQ`) in a believable context ("hey can you approve this CLI auth I'm doing"). the operator hits `https://workers.floom.dev/cli-auth?code=67UB-P3JQ`, sees a generic approve screen, clicks approve. Attacker polls `/cli-auth/poll/<device_code>` and receives the entire FLOOM_SECRET. The approved device cleanup is single-use (line 5751), so detection is hard.

**Root-cause hypothesis**: (a) missing `len(_cli_auth_devices) > MAX_PENDING` check + missing IP-based rate-limit on `/cli-auth/devices`. (b) the approval UI on `workers.floom.dev/cli-auth` should show the `client_name`, the IP/timestamp of the device-code creation, and require the operator to confirm he initiated the flow on THIS machine. The current code only stores `client_name` (attacker-controlled) and shows a generic prompt.

**Suggested fix**:
- Cap `_cli_auth_devices` at e.g. 1000 entries (reject new with 429).
- Add anonymous rate limit on `/cli-auth/devices` by `CF-Connecting-IP` (10/min/IP).
- On the frontend approve screen: show `client_name`, the originating IP (record `request.client.host` or `CF-Connecting-IP` at creation), and a warning ("only approve if you started this flow yourself").
- Consider deriving a session-scoped sub-secret instead of returning the raw FLOOM_SECRET (the platform secret should NEVER leave the server; mint a per-CLI bearer token instead).

---

### NEW-3 — Secrets name/value have no length cap (P1)

**Title**: Unbounded secret name (10K chars) and value (10MB) accepted; persisted to `.env` on disk

**Evidence**:
```
# 10,000-char name accepted:
$ NAME=$(python3 -c "print('A'*10000, end='')")
$ curl -X POST -H "x-floom-secret: $SECRET" -H "Content-Type: application/json" \
    --data '{"value":"x"}' "https://workers-api.floom.dev/secrets/$NAME"
HTTP=200 size=10046
{"status":"valid","reason":"Secret 'AAAAAA…' saved."}

# 10MB value accepted:
$ python3 -c "import json; print(json.dumps({'value':'V'*(10*1024*1024)}))" > /tmp/big.json
$ curl -X POST -H "x-floom-secret: $SECRET" -H "Content-Type: application/json" \
    --data-binary @/tmp/big.json https://workers-api.floom.dev/secrets/BIG_AUDIT_TEST
HTTP=200 size=60 time=0.744s
{"status":"valid","reason":"Secret 'BIG_AUDIT_TEST' saved."}
```

Both test secrets were cleaned up post-probe. The 10MB value was written to `.env` and read back into `os.environ` (line 3930). Subsequent `.env` reads will be slow; `dotenv` parsers may error on huge lines.

**Root-cause hypothesis**: `_upsert_env_var` (main.py:3900) validates the name regex but checks no length cap. The Pydantic `SecretUpsertRequest` model presumably has no `max_length` on `value`. Caller of POST /secrets uses `name` as a path parameter, which FastAPI/Starlette does not bound.

**Suggested fix**:
- Add length validation in `_upsert_env_var`: `if len(name) > 128: raise ValueError(...)`, `if len(value) > 64*1024: raise ValueError(...)`.
- Add `Field(max_length=...)` on the Pydantic model.

---

### NEW-4 — Rate-limit middleware uses CF edge IP, not real client IP (P1)

**Title**: Anonymous rate-limit bucket keyed on Cloudflare edge IP — all unauthenticated requests share one bucket

**Evidence**: code review of `_rate_caller_key` (main.py:175-180):
```python
def _rate_caller_key(request: Request) -> str:
    secret = request.headers.get("x-floom-secret") or ""
    if secret:
        return "s:" + hashlib.sha256(secret.encode()).hexdigest()[:16]
    return "ip:" + (request.client.host if request.client else "unknown")
```

Behind Cloudflare, `request.client.host` is the CF edge IP (e.g. `162.158.x.x`), not the originating client IP. All anonymous traffic via the same CF colo shares one bucket.

**Two impacts**:
- A single attacker can exhaust the anon bucket from one IP, causing rate-limit-induced 429s for legitimate `/cli-auth/poll/*`, `/connections/callback`, `/composio-events` traffic from the same CF colo.
- The intended per-client rate-limit is effectively non-functional for unauthenticated endpoints.

**Suggested fix**: prefer `request.headers.get("cf-connecting-ip")` then `x-forwarded-for` (validated against trusted-proxy list) then `request.client.host`. Verify the API only accepts traffic from CF (origin lockdown), otherwise XFF spoofing trivializes IP-based rate limits.

---

### NEW-5 — Deeply nested JSON → HTTP 500 (P2)

**Title**: Recursion-limit JSON input returns unhandled 500 instead of 400/422

**Evidence**:
```
$ python3 -c "n=5000; print('{\"a\":'*n + '1' + '}'*n)" > /tmp/deep.json
$ curl -X POST -H "x-floom-secret: $SECRET" -H "Content-Type: application/json" \
    --data-binary @/tmp/deep.json https://workers-api.floom.dev/workers
HTTP=500 time=0.371047s size=34
{"detail":"Internal server error"}
```

Server uptime continued normally (no crash); but the exception is presumably caught by FastAPI's catch-all. This is information disclosure (attacker learns that nested-JSON triggers an unhandled path) and signals a missing validation layer.

**Root-cause**: Python's default JSON parser raises `RecursionError` on deeply nested input. FastAPI's default `RequestValidationError` doesn't catch this.

**Suggested fix**: Add a body-pre-validation middleware that rejects nested JSON deeper than 100 levels with a 400. Or set `sys.setrecursionlimit` defensively and catch `RecursionError` in a custom exception handler.

---

### NEW-6 — Timing channel on /connections/{id}/status — 400ms gap between real and random (P2)

**Title**: 4x latency gap (and status code 200 vs 404) discloses whether a connection ID exists

**Evidence** (20 trials each):
- Real connection ID (`d10ea8f2-…`): mean ~490ms, range 400-685ms, HTTP 200
- Random UUID: mean ~120ms, range 105-180ms, HTTP 404

Distinguishable by both status code AND timing.

**Risk**: low — UUIDs are 128 bits, brute-force enumeration is computationally infeasible. But a partial-leak (e.g. UUID prefix in logs) becomes confirmable.

**Suggested fix**: enforce a minimum response time for all `/connections/*/{action}` (e.g. `await asyncio.sleep(min(0.4 - elapsed, 0))`), OR return 404 with the same JSON shape and latency as a real connection lookup (no upstream Composio call on miss).

---

### NEW-7 — Composio internal IDs (`ca_*`, `ac_*`) exposed in API responses (P2)

**Title**: Backend exposes Composio's internal connection_id and auth_config_id without obfuscation

**Evidence**:
```
$ curl -H "x-floom-secret: $SECRET" https://workers-api.floom.dev/connections | head -c 300
[{"id":"d10ea8f2-…","app_name":"googlecalendar","composio_connection_id":"ca_MjFkFHk1_ywb",…}]

$ curl -H "x-floom-secret: $SECRET" \
    "https://workers-api.floom.dev/connections/69a57a50-.../account-info"
{"id":"ca_REDACTED","email":"f.deponte@outlook.com","scopes":[],
 "user_id":"federico","auth_config_id":"ac_REDACTED"}
```

`composio_connection_id` and `auth_config_id` are Composio's stable identifiers. If COMPOSIO_API_KEY is ever leaked (rotated, stolen, or via a sub-service), these IDs allow direct authenticated calls to Composio for federico's connected accounts. Single-tenant context means these are the operator-only, but the exposure is unnecessary — the FastAPI internal UUID `id` is sufficient for clients.

**Suggested fix**: strip `composio_connection_id` from the serializer. The frontend doesn't need it; all operations should go through Floom's internal UUID.

---

### NEW-8 — `/connections/auth-configs/{any_id}` returns same Composio auth-config for any input (P2)

**Title**: Endpoint silently substitutes ID-not-found with the platform's default auth config

**Evidence**:
```
$ for i in 1 2 3 4 5; do
    RND=$(uuid)
    curl -H "x-floom-secret: $SECRET" \
      "https://workers-api.floom.dev/connections/auth-configs/$RND"
  done
{"id":"ac_l8tjxjPMtuwm","scopes":[]}   # same for ALL random inputs
{"id":"ac_l8tjxjPMtuwm","scopes":[]}
{"id":"ac_l8tjxjPMtuwm","scopes":[]}
…

# Also for non-UUID inputs:
input='abc':                → {"id":"ac_l8tjxjPMtuwm","scopes":[]}
input='1; DROP TABLE users':→ {"id":"ac_l8tjxjPMtuwm","scopes":[]}
input='ac_real_looking_id': → {"id":"ac_l8tjxjPMtuwm","scopes":[]}
```

**Root-cause hypothesis**: code at main.py:4706-4724 falls back from "get by ID" → "list by `toolkit_slugs=<input>`" → "if list non-empty, return first ENABLED". This means any input either matches a real config OR matches no toolkit and returns the platform default. Information disclosure: the existence and ID of platform's default auth config is revealed to any authenticated caller.

**Suggested fix**: remove the toolkit_slugs fallback when the input doesn't match a known shape, OR return 404 on the get-by-ID miss. The fallback adds inscrutable behavior.

---

## 3. PASS list (probes that returned expected secure response)

| Probe | Status |
|---|---|
| Auth middleware: every endpoint requires `x-floom-secret` (or exempt path) | PASS — verified by code review at main.py:206-237 + WAF catches unauthenticated probes upstream |
| Cloudflare WAF: blocks unauthenticated requests at edge (403) | PASS — defense in depth before backend |
| CRIT-3 fix: DELETE /connections/{random-uuid} → 404 "Connection not found" | PASS ✓ |
| IDOR sweep: DELETE/GET/PATCH/PUT on /workers/{random}, /runs/{random}, /connections/{random}, /secrets/NONEXISTENT, /workers/{random}/runs, /workers/{random}/runs/{random}/replay, /connections/{random}/status, /connections/{random}/account-info, /connections/{random}/test all return 404 | PASS ✓ |
| Platform secret guard: POST /secrets/FLOOM_SECRET → 400 "platform infrastructure secret" | PASS |
| Platform secret guard: POST /secrets/COMPOSIO_API_KEY, /secrets/E2B_API_KEY → 400 | PASS |
| Platform secret guard: DELETE /secrets/FLOOM_SECRET → 400 | PASS |
| Secret name regex validates: name with newline/$()/CRLF → 400 "Invalid secret name" | PASS |
| Zip path-traversal: bundle with `../../etc/…` entry → rejected at schema validation (worker.yml schema invalid) before extraction; even if schema valid, parts-with-`..` check at main.py:3037 catches it | PASS (both layers defend) |
| Upload extension whitelist: `.bin`, `.exe`, `.sh`, `.js` → 400 "extension not allowed" | PASS |
| Upload size cap: 50MB .txt → 400 "exceeds 25 MiB limit"; 200MB → CF 413 | PASS |
| Cloudflare CDN: 200MB POST → 413 in 0.2s (no backend impact) | PASS |
| Composio webhook auth: POST /composio-events without HMAC → 401 "Invalid Composio signature" | PASS |
| Worker webhook auth: POST /webhooks/{unknown_worker_id} → 404 | PASS |
| CORS preflight from evil.com origin → no `access-control-allow-origin` header echoed | PASS |
| CORS preflight from workers.floom.dev → correct origin echoed | PASS |
| Security headers on 200 responses: CSP `default-src 'none'`, HSTS `max-age=31536000`, X-Frame-Options DENY, X-Content-Type-Options nosniff, Permissions-Policy lockdown, Referrer-Policy strict-origin-when-cross-origin | PASS |
| Host header injection: Host: evil.com → CF 403 | PASS |
| Cleanup-after-probe: 3 test gmail connections + 2 test secrets created during probing were all deleted; final state matches pre-probe (5 real connections, 0 user-secrets) | PASS |
| Process stability: uptime 4059s after ~80 probes, no crash, no degradation | PASS |
| Draft endpoint rate-limit: 20/hour per-secret bucket (`_DRAFT_RATE_LIMIT_HOUR`) | PASS (verified in code at main.py:2291) |
| GET /openapi.json without secret → CF 403 (with secret → 200) | PASS — schema not anonymously enumerable |

---

## 4. Round 6 Comparison

| Round 6 finding | Status 2026-05-28 | Notes |
|---|---|---|
| **CRIT-3** DELETE /connections/{id} missing ownership check, real Gmail wiped | **FIXED** ✓ | Random UUID → 404. Ownership check now present at the FastAPI handler. The single-tenant nature means "ownership" = "exists in DB", but the missing-existence check is now in place. |
| **CRIT-4** GET /connections leaks ALL PII across users | **N/A (single-tenant)** + partial mitigation | Workeros is single-user; there is no second user whose data could leak. Composio raw IDs are still exposed (see NEW-7), but no cross-user leak vector exists in the current deployment. If multi-tenancy is ever added, ownership filtering must be added to `GET /connections`, `GET /workers`, `GET /runs`, `GET /system/overview`, etc. |
| **HIGH-6** 1MB malformed input → 0.56s amplification | **PARTIAL FIX** ✗ | Round 6 patched the `JSONDecodeError` branch (140-byte response now, no amplification). But the `RequestValidationError` branch on POST /workers is **STILL 2.0x amplifying** — see NEW-1. Same root cause as Round 6 (Pydantic echoes input in errors), but the more dangerous variant (valid JSON, missing required field) was not covered by the Round 6 patch. |

---

## 5. Methodology + caveats

- **Probe set**: 80+ live HTTP requests against prod. Authenticated probes used the real `x-floom-secret` from `/root/workeros/.deploy-secret`. Unauthenticated probes were limited by Cloudflare WAF (returns 403 before backend) — this is a legitimate defense layer; backend behavior on unauthed paths was inferred from source code review of `auth_middleware` (main.py:206-237).
- **No destructive operations**: only random UUIDs on DELETE probes. The 3 connections and 2 secrets created mid-probe were cleaned up; final state verified to match pre-probe.
- **No long-running probes left in flight**: 50 CLI device codes created during NEW-2 test will expire naturally at 600s.
- **Single-tenant context noted throughout**: many "cross-user PII" probe classes are inapplicable because Workeros is currently single-user. Findings have been re-scored accordingly.
- **Total cost**: 3 LLM calls (~$0.02 worst-case) for `/workers/draft-from-prompt` probes; the 20/hr rate limit is respected.

---
END.

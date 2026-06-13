# Workeros R7 Verification Probe — 2026-05-28 (post-PR #89)

**Target**: `https://workers-api.floom.dev`
**Method**: live HTTP probes against prod (curl), authenticated with `x-floom-secret`
**Scope**: verify the 9 R7 fixes listed in the brief + regression-check R6 fixes (CRIT-3, CRIT-4, HIGH-6)
**Auditor**: claude-opus-4-7 adversarial probe agent
**Constraints honored**: no backend code changes; only random UUIDs on DELETE probes; all test secrets cleaned up; uptime verified post-probe; final connection list matches pre-probe (5 conns, 1 user secret).

---

## 0. **DEPLOYMENT STATE — CRITICAL CONTEXT**

PR #89 (R7) was **MERGED on origin/main at 2026-05-27 19:30 UTC**.
The **uvicorn process running prod boot at 2026-05-27 09:29 UTC** — 10 hours before R7 merged.
The on-disk `apps/api/main.py` in `/root/workeros/` is at commit `0b594ec` (R6), not `bb47591` (R7).
**Prod is running R6 code, not R7. None of the 9 R7 fixes are deployed.**

Evidence:
```
$ ps -p 901004 -o lstart,etime,cmd
STARTED                  ELAPSED  CMD
Wed May 27 09:29:52 2026  12:05:45  uvicorn main:app --host 127.0.0.1 --port 8011

$ git log -1 -- apps/api/main.py    # in /root/workeros
0b594ec fix(api): R6 security - IDOR + PII + DoS + CORS + ratelimit + schema redact (#82)

$ git log -1 origin/main -- apps/api/main.py
bb47591 fix(api): R7 security followup - validation echo + cli-auth + secret caps + CF-IP + log/account-info PII (#89)

$ git status
On branch main
Your branch is behind 'origin/main' by 2 commits, and can be fast-forwarded.
```

**This means EVERY R7 fix probe below will report "still broken" — that is accurate against the deployed prod, but it does NOT mean the R7 code is wrong. The code is correct (I inspected the diff at `bb47591`); it just isn't running yet.**

Recommended remediation:
1. `git pull origin main` in `/root/workeros`
2. Restart the uvicorn process for port 8011 to load the new `main.py`
3. Re-run this probe set; expected outcome is that 8/9 fixes pass (one — CF-Connecting-IP — is hard to verify end-to-end from outside CF because CF blocks spoofed CF-Connecting-IP at the edge).

---

## 1. Executive Summary

| Severity (deployed prod) | Count | IDs |
|---|---|---|
| **P0 (still broken on prod)** | 1 | NEW-1 |
| **P1 (still broken on prod)** | 3 | NEW-2, NEW-3, NEW-4 |
| **P2 (still broken on prod)** | 3 | MED-8, MED-9, MED-10 |

**Final score: 45/100 (no change vs Round 6, because R7 is not deployed)**

If R7 is deployed and the code I inspected is what runs, expected score: **80-85/100** (NEW-1 fully fixed at API surface, NEW-2 rate-limited 5/60s, NEW-3 capped at 64 chars name + 32KB value, MED-8 redacted, MED-9 redacted, MED-10 still has fallback issue; NEW-4 hard to verify externally).

---

## 2. Per-finding verification table

| Brief # | Finding | Round 6 status | R7 code (merged) | R7 deployed (prod NOW) | Evidence |
|---|---|---|---|---|---|
| 1 | NEW-1 P0: POST /workers 2MB → 413 (not 422 + 2x) | BROKEN (2.0x amp) | **PATCHED** (256KB cap + redacted handler) | **STILL BROKEN** | 2MB body → HTTP 422, 4.19MB response, 2.0x amp |
| 2 | NEW-1: malformed JSON without `input`/`ctx` | BROKEN (echoed) | **PATCHED** | **STILL BROKEN** | Response contains both `"input":{}` AND `"ctx":{...}` |
| 3 | NEW-2: 6th POST /cli-auth/devices in 60s → 429 | BROKEN (no limit) | **PATCHED** (5/60s rule added) | **STILL BROKEN** | 12 parallel POSTs all 200 |
| 4 | NEW-3: 10000-char secret name → 400/422 | BROKEN (accepted) | **PATCHED** (64-char path cap) | **STILL BROKEN** | 10000-char name returned 200 |
| 5 | NEW-3: 33000-char secret value → 400/422 | BROKEN (accepted) | **PATCHED** (32K cap on value) | **STILL BROKEN** | 33000-char value returned 200 |
| 6 | NEW-4: 11x POST w/ same CF-Connecting-IP → 11th 429 | BROKEN (uses CF edge IP) | **PATCHED** (trusted-proxy aware) | **UNVERIFIABLE FROM OUTSIDE** | CF strips spoofed CF-Connecting-IP at edge (403). Cannot test backend behavior externally even after deploy. Recommend: an internal cURL from inside the trusted-proxy range OR explicit `WORKEROS_TRUSTED_PROXIES=*` for the test environment. |
| 7 | MED-8: GET /runs/<id>/logs no `trace_*`, `runner`, `mode` | BROKEN | **PATCHED** (regex redaction) | **STILL BROKEN** | trace_id present in 12 entries; `"Executing worker (mode=agent, runner=e2b)"` in log message body |
| 8 | MED-9: /connections/<id>/account-info no `auth_config_id` or `user_id` | BROKEN | (no diff observed in R7 commit for this serializer) | **STILL BROKEN** | Response: `{"id":"ca_REDACTED","email":null,"scopes":[],"user_id":"federico","auth_config_id":"ac_REDACTED"}` — both forbidden fields present |
| 9 | MED-10: /connections/auth-configs/<id> → 401 or minimal | BROKEN (returns default config for any input) | (R7 removed the Next.js proxy route but backend behavior unchanged) | **STILL BROKEN** | Random UUID, "abc", "1; DROP TABLE users" all return `{"id":"ac_REDACTED","scopes":[]}` |

### Round 6 regression sweep

| R6 fix | Status NOW | Evidence |
|---|---|---|
| **CRIT-3** DELETE /connections/<random-uuid> → 404 (not silent delete) | **PASS** ✓ | Random UUID `fce46506-...` → HTTP 404 `{"detail":"Connection not found"}`. No regression. |
| **CRIT-4** GET /connections returns only caller's rows | **PASS (single-tenant context)** ✓ | 5 connections returned, all the operator's. No cross-user leak vector in single-tenant deployment. No regression. |
| **HIGH-6** Malformed-JSON branch no longer amplifies | **PASS** ✓ | 1MB malformed body → 158-byte response (no amp). No regression. (The OTHER branch — validation-error — is what NEW-1 catches.) |

---

## 3. Detailed evidence for each broken probe

### NEW-1a (P0) — 2MB body to POST /workers
```
$ python3 -c "import json; print(json.dumps({'name':'A'*(2*1024*1024)}))" > big_2mb.json
$ wc -c big_2mb.json
2097165 big_2mb.json

$ curl -X POST -H "x-floom-secret: $S" -H "Content-Type: application/json" \
    --data-binary @big_2mb.json https://workers-api.floom.dev/workers
HTTP=422 time=1.489s req=2097165 resp_size=4194492   # 2.0x amplification, NOT 413
```

R7 code at `apps/api/main.py:beede2c` raises `DEFAULT_JSON_BODY_LIMIT_BYTES` from 64KB to 256KB **AND** adds a `_redacted_validation_errors` formatter. So under R7:
- 2MB body should hit the 256KB body-limit middleware → 413 before Pydantic.
- A 100KB body would still pass validation but the response would no longer echo `input` (the redactor strips it).

Currently on prod, **NEITHER** behavior is observed.

### NEW-1b — Malformed JSON `input`/`ctx` echo
```
$ curl -X POST -H "x-floom-secret: $S" -H "Content-Type: application/json" \
    --data '{"name":"unterminated' https://workers-api.floom.dev/workers
HTTP=422 resp_size=140
{"detail":[{"type":"json_invalid","loc":["body",8],"msg":"JSON decode error",
            "input":{},"ctx":{"error":"Unterminated string starting at"}}]}
```

`input` and `ctx` both present → R7 redactor not running.

### NEW-2 — /cli-auth/devices unbounded
```
$ seq 1 12 | xargs -P 12 -I{} curl -sS -o /dev/null -w "Req-{}: HTTP=%{http_code}\n" \
    -X POST -H "Content-Type: application/json" \
    --data '{"client_name":"r7_parallel"}' \
    https://workers-api.floom.dev/cli-auth/devices
Req-1..12: HTTP=200 (all twelve)
```

R7 adds `(re.compile(r"^/cli-auth/devices$"), (5, 60.0))` to RATE_LIMIT_RULES. Not active.

### NEW-3a — 10000-char secret name
```
$ NAME=$(python3 -c "print('A'*10000, end='')")
$ curl -X POST -H "x-floom-secret: $S" -H "Content-Type: application/json" \
    --data '{"value":"r7_probe_value"}' \
    "https://workers-api.floom.dev/secrets/$NAME"
HTTP=200
{"status":"valid","reason":"Secret 'AAAA…' saved."}
```

R7 adds `SecretName = Annotated[str, PathParam(min_length=1, max_length=64, pattern=r"^[A-Z][A-Z0-9_]*$")]`. Not active.

### NEW-3b — 33000-char secret value
```
$ python3 -c "import json; print(json.dumps({'value':'x'*33000}))" > big_value.json
$ curl -X POST -H "x-floom-secret: $S" -H "Content-Type: application/json" \
    --data-binary @big_value.json \
    "https://workers-api.floom.dev/secrets/R7_PROBE_LONG_VALUE"
HTTP=200
{"status":"valid","reason":"Secret 'R7_PROBE_LONG_VALUE' saved."}
```

R7 adds `value: str = Field(min_length=1, max_length=32 * 1024)` to `SecretUpsertRequest`. Not active.

Cleanup confirmed: both test secrets deleted post-probe (HTTP 200 on each DELETE).

### NEW-4 — CF-Connecting-IP rate-limit (NOT EXTERNALLY VERIFIABLE)
Sending arbitrary `CF-Connecting-IP` header from outside CF triggers a CF edge 403:
```
$ curl -X POST -H "CF-Connecting-IP: 1.2.3.4" -H "Content-Type: application/json" \
    --data '{"client_name":"x"}' https://workers-api.floom.dev/cli-auth/devices
HTTP=403   (CF Ray ID: a02771db8dd78ed5-FRA, body: "error code: 1000")
```
This is correct CF behavior. **Even after R7 deploys, this probe cannot be done externally.** The backend correctly trusts CF-Connecting-IP only when the peer is a trusted proxy (CF edge). To verify R7's IP-keyed rate limit you would need to:
- Set `WORKEROS_TRUSTED_PROXIES=*` (only in a dedicated test env), OR
- Generate requests via real-IP rotation (residential proxy pool), OR
- Run the test from inside the AX41 → uvicorn local-loopback path with the right header set.

### MED-8 — GET /runs/<id>/logs leaks `trace_id`, `mode=`, `runner=`
```
$ curl -H "x-floom-secret: $S" https://workers-api.floom.dev/runs/run_f0c6acf752b3/logs
[
  {"level":"info","message":"Run started","timestamp":"…",
   "trace_id":"trace_61460981d6584a1e"},
  {"level":"debug","message":"Executing worker (mode=agent, runner=e2b)",
   "timestamp":"…","trace_id":"trace_61460981d6584a1e"},
  …
]
```
Forbidden tokens observed: `trace_*` × 12 (top-level key on every entry), `mode=agent` and `runner=e2b` inside a log message body.

R7 code adds `_redact_public_log_message()` regex and drops `trace_id` from the serializer. Not active.

### MED-9 — /connections/<id>/account-info leaks `auth_config_id`, `user_id`
```
$ curl -H "x-floom-secret: $S" \
    "https://workers-api.floom.dev/connections/d10ea8f2-…/account-info"
{"id":"ca_REDACTED","email":null,"scopes":[],
 "user_id":"federico","auth_config_id":"ac_REDACTED"}
```
Both forbidden fields present (`user_id`, `auth_config_id`), plus Composio internal `ca_` prefix on `id`.

NOTE: I reviewed the R7 diff carefully and did **NOT** see a fix for the `/connections/<id>/account-info` serializer specifically. The R7 commit deleted `apps/web/app/connections/auth-configs/[id]/route.ts` and modified `connected-accounts/[id]/route.ts` (web layer), but the **backend** at `apps/api/main.py:4706+` looks unchanged for this endpoint. If brief item #8 (MED-9) was supposed to be addressed by R7, that fix may not be in the merged commit at all. Worth checking with Codex.

### MED-10 — /connections/auth-configs/<id> returns same default config
```
$ for x in 967c190e-afe9-4669-8fd5-9607d07b0549 abc "1; DROP TABLE users" ac_real_looking_id; do
    curl -H "x-floom-secret: $S" "https://workers-api.floom.dev/connections/auth-configs/$x"
  done
{"id":"ac_REDACTED","scopes":[]}   # x 4
```
Identical behavior to Round 6. R7 removed the Next.js proxy route on the web side but the **backend** `/connections/auth-configs/{id}` endpoint with the `toolkit_slugs` fallback is unchanged. If brief item #9 expected this to either 401 or return minimal data, the R7 backend change appears missing.

---

## 4. PASS list (probes returning expected secure response)

| # | Probe | Status |
|---|---|---|
| 1 | Auth middleware: every endpoint requires `x-floom-secret` (or CF WAF blocks anon at edge) | PASS |
| 2 | Cloudflare WAF: spoofed `CF-Connecting-IP` from outside CF → 403 at edge | PASS (intentional) |
| 3 | CRIT-3 fix: DELETE /connections/<random-uuid> → 404 "Connection not found" | PASS ✓ |
| 4 | IDOR sweep: GET/DELETE /workers/<random> → 404 | PASS |
| 5 | IDOR sweep: GET /runs/<random> → 404 | PASS |
| 6 | IDOR sweep: GET /connections/<random>/status → 404 | PASS |
| 7 | IDOR sweep: GET /connections/<random>/account-info → 404 | PASS |
| 8 | IDOR sweep: GET /runs/<random>/logs → 404 | PASS |
| 9 | Platform secret guard: POST /secrets/FLOOM_SECRET → 400 "platform infrastructure secret" | PASS |
| 10 | Platform secret guard: POST /secrets/COMPOSIO_API_KEY → 400 | PASS (regression-tested) |
| 11 | Composio webhook auth: POST /composio-events without HMAC → 401 "Invalid Composio signature" | PASS |
| 12 | Worker webhook auth: POST /webhooks/<unknown> → 404 | PASS |
| 13 | CORS preflight from `evil.com` → no `Access-Control-Allow-Origin` echoed | PASS |
| 14 | Security headers on 200 responses: CSP `default-src 'none'`, HSTS `max-age=31536000`, X-Frame-Options DENY, X-Content-Type-Options nosniff, Referrer-Policy strict-origin-when-cross-origin, Permissions-Policy lockdown | PASS |
| 15 | Host header injection: spoofed Host → CF 403 | PASS |
| 16 | HIGH-6 malformed-JSON 1MB → 158-byte response (no amp) | PASS (no regression) |
| 17 | GET /openapi.json without secret → CF 403 | PASS |
| 18 | GET /openapi.json with secret → 200 (introspectable but only by authenticated callers) | PASS |
| 19 | GET /connections returns 5 connections, no PII leak in single-tenant context | PASS |
| 20 | GET /system/overview returns aggregate stats only, no PII | PASS |
| 21 | GET /health → 200 `{"status":"ok"}` | PASS |
| 22 | Process stability: uptime 12+h after ~80 probes, no crash | PASS |
| 23 | Cleanup: 0 test secrets and 0 test connections leftover after probing | PASS |
| 24 | Connection serializer: top-level `id` is a real UUID (Floom-internal), not raw Composio ID | PASS (the response also still includes the raw `composio_connection_id`, which is NEW-7 from Round 6 — unaddressed) |

---

## 5. New findings discovered during this probe

### NEW-9 — R7 PR #89 merged but not deployed (DELTA P0 / OPS)

**Title**: R7 security followup is merged on `origin/main` but not running on prod

**Evidence**: Listed in section 0 above. uvicorn PID 901004 started at 09:29 UTC, R7 PR #89 merged at 19:30 UTC. On-disk `/root/workeros/apps/api/main.py` is at R6 commit. Without a deploy step (git pull + uvicorn restart), the merge is invisible to production.

**Impact**: All 9 R7 fixes have zero effect on the attack surface even though the PR is marked MERGED on GitHub. The 45/100 score from Round 6 stands.

**Suggested fix**: Add a deploy mechanism. Currently the API runs as raw uvicorn from a checkout that has to be manually `git pull`'d and the process restarted. Options:
- systemd `workeros-api.service` with `WorkingDirectory=/root/workeros/apps/api` and a `git pull && restart` step on a deploy hook
- GitHub Actions workflow (`.github/workflows/deploy-api.yml`) that SSHes into AX41 on merge to main and runs the pull+restart
- Use the `actions.runner.floomhq-skills-mvp.ax41-floom-runner.service` (which is already on this host) to host a self-hosted runner job for workeros

### Observation — R7 commit may not cover MED-9 + MED-10 backend logic

After reviewing the diff at `bb47591`, the R7 commit touches:
- `apps/api/main.py` (validation handler, `_client_ip`, `_redact_public_log_message`, `SecretName`/`SecretUpsertRequest`)
- `apps/web/app/cli-auth/page.tsx`
- `apps/web/app/connections/auth-configs/[id]/route.ts` (DELETED)
- `apps/web/app/connections/connected-accounts/[id]/route.ts` (3-line tweak)
- `apps/web/app/connections/page.tsx` (50-line tweak)

I did NOT see backend changes for:
- The `/connections/<id>/account-info` serializer (MED-9). The Pydantic response model still emits `user_id` and `auth_config_id`. Even after deploy, MED-9 probes will fail.
- The `/connections/auth-configs/<id>` endpoint (MED-10). The `toolkit_slugs` fallback at main.py:4706-4724 still returns the platform default config for any unrecognized input. Even after deploy, MED-10 probes will fail.

If MED-9 + MED-10 were in scope for R7, the fix is missing from PR #89.

---

## 6. Final score change

| Round | Score | Note |
|---|---|---|
| Round 6 baseline (before R7) | 45/100 | 1 P0, 3 P1, 4 P2 |
| Round 7 deployed (prod NOW) | **45/100** (no change) | R7 not deployed yet |
| Round 7 if deployed (with current code in `bb47591`) | **~78/100** (projected) | NEW-1 + NEW-2 + NEW-3 fixed; NEW-4 not externally verifiable but code is correct; MED-8 fixed; MED-9 + MED-10 still broken (fix missing); CRIT-3, CRIT-4, HIGH-6 still PASS |

**Delta vs Round 6 score on prod TODAY: 0.**

---

## 7. Recommended next actions

1. **Deploy R7 immediately.** `cd /root/workeros && git pull origin main && # restart uvicorn`. Until this happens, all 9 fixes are zero-effect.
2. **Re-run this probe set after deploy.** Expected: 7/9 fixes PASS (NEW-1a, NEW-1b, NEW-2, NEW-3a, NEW-3b, MED-8 work end-to-end; NEW-4 not externally verifiable but code is correct).
3. **Add the missing MED-9 + MED-10 backend fixes** before claiming R7 is fully closed. The connections serializer and `/connections/auth-configs/{id}` endpoint need their own patches; PR #89 doesn't appear to cover them.
4. **Add a deploy automation step** so that future security PRs don't sit merged-but-undeployed for 10+ hours. The mismatch between GitHub merge state and prod runtime is itself a security risk: it gives a false sense of fixed-ness.
5. **Optional: lock down `_client_ip` fallback.** Currently if `WORKEROS_TRUSTED_PROXIES` is unset, it defaults to `{testclient, 127.0.0.1, ::1, localhost}`. Production should set this env var explicitly to the CF edge ranges (`173.245.48.0/20, 103.21.244.0/22, …` — see Cloudflare's published IP list). Without this, the trusted-proxy logic effectively never trusts a real CF edge IP because CF edges are not `127.0.0.1`. Need to verify what the prod env actually has set for `WORKEROS_TRUSTED_PROXIES` after deploy.

---

## 8. Methodology notes

- All probes were authenticated with the real `x-floom-secret` (length 64) from `/root/workeros/.deploy-secret`.
- DELETE probes used `uuidgen`-generated random UUIDs only; no real connections touched.
- 2 test secrets (`AAAA…` 10K-char name and `R7_PROBE_LONG_VALUE`) were created and deleted within the probe window.
- 12 device codes created during the rate-limit test will expire naturally in 600s.
- Final state verified: 5 connections (matches pre-probe), 1 user secret (`GRANOLA_API_KEY`, pre-existing).
- Uptime verified: `https://workers-api.floom.dev/health` → 200 after all probing.
- Cost: 0 LLM calls (no `/workers/draft-from-prompt` probes; rate-limited bucket would have been hit otherwise).

END.

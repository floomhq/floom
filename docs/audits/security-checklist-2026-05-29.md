# Workeros Security + Privacy Checklist — 2026-05-29

**Target**: `https://workers.floom.dev` (frontend) + `https://workers-api.floom.dev` (API)
**Method**: code review + live probes (via API localhost `127.0.0.1:8011` to bypass the Cloudflare WAF challenge on bot UAs) + unit tests
**Branch**: `lane/security-checklist-2026-05-29`
**Auditor**: claude-opus-4-8 (security-checklist lane)
**Context**: single-tenant V0 (one owner), hardened as if multi-tenant is coming
**Constraints honored**: no secret VALUES printed/committed; test data cleaned; uptime verified post-probe (no crash); coordinated — SSE concurrent-stream cap left to the backend-correctness lane.

**2026-06-09 scope update for issue #609**: worker execution has two
topologies. Pure-script workers run in E2B microVMs. Agent workers (`SKILL.md`,
`.md`, or `mode: agent`) run through AgentDriver in the API process. The
current single-tenant deployment treats agent bundles as trusted,
platform-controlled code by policy; that policy is not a sandbox boundary or
a code-enforced provenance check. Statements below about sandbox isolation
apply only to the pure-script path unless they explicitly name AgentDriver.

---

## Scorecard

| # | Item | Verdict |
|---|------|---------|
| 1 | Privacy policy / terms surface | **FIXED** — added `/privacy` + `/terms` |
| 2 | Know where user data is stored | **FIXED** — added `docs/SECURITY-DATA-MAP.md` |
| 3 | Security headers (frontend + API) | **PASS** — all 6 present on both |
| 4 | OWASP Top-10 scan | **PASS** (1 quick win in #11; see below) |
| 5 | SQLi / XSS / auth | **PASS** — parametrized, JSON-only + CSP, 401/403 without secret |
| 6 | `.env` values not leaking | **PASS** — pure-script sandbox env carries no platform secret; denylist enforced |
| 7 | API responses for sensitive data | **PASS** (email now null, account-label redacted); 1 residual P2 (`ca_*` ids) |
| 8 | Remove secrets from logs | **PASS** — no literal secrets in journald/run-logs/DB |
| 9 | Never expose API keys in frontend | **FIXED (P0)** — removed unauthenticated `/api/floom-secret` |
| 10 | Move keys server-side / behind proxy | **PASS** — `/api/proxy` injects secret server-side |
| 11 | Rate limits before bill-burn | **FIXED** — added per-user `/chat` quota |
| NEW-1 | POST /workers input echo amplification | **PASS (fixed earlier)** — verified no echo |
| NEW-2 | /cli-auth/devices unauth + phishing | **PARTIAL** — cap+rate-limit+confirm-code in place; raw-secret residual (P2) |
| NEW-3 | Secret name/value length cap | **PASS (fixed earlier)** — 422/413 |

---

## Per-item detail

### 1. Privacy / Terms — FIXED
No privacy/terms surface existed. Added minimal honest static pages
`apps/web/app/privacy/page.tsx` and `apps/web/app/terms/page.tsx` documenting:
single-tenant reality, what is stored, E2B execution, third-party providers
that may receive data (OpenAI/E2B/Composio), and owner-controlled
retention/deletion. The 2026-06-09 scope update above supersedes any inference
from that historical wording that agent workers are E2B-isolated. Not
over-built.
**Federico decision needed**: if Workeros Cloud (multi-tenant) reuses this OS
frontend, these pages must be replaced with a real processor-listed GDPR
privacy policy + ToS. For the single-tenant OS they are sufficient.

### 2. Data map — FIXED
`docs/SECURITY-DATA-MAP.md` enumerates every storage location and execution
topology: all SQLite
tables (workers/runs/logs/secrets/composio_connections/conversations/
conversation_messages/contexts/approvals/artifacts/files/worker_webhook_secrets/
cli_auth_devices/schedules/worker_state/...), artifacts dir, contexts dir,
`.env`, ephemeral E2B sandboxes for pure-script workers, API-process
AgentDriver execution, journald — each with sensitivity, at-rest encryption
(disk-level only), and retention. Includes a data-flow diagram.

### 3. Security headers — PASS
Verified live on both hosts. API (`security_headers_middleware`, main.py):
`Strict-Transport-Security`, `X-Content-Type-Options: nosniff`,
`X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`,
`Permissions-Policy`, `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`.
Frontend: full CSP with `frame-ancestors 'none'`, HSTS, X-Frame-Options DENY,
nosniff, Referrer-Policy, Permissions-Policy. (Minor: frontend HSTS lacks
`includeSubDomains` — non-blocking; CF already enforces HSTS at the edge.)

### 4. OWASP Top-10 — PASS
- A01 Broken Access Control: all endpoints behind `x-floom-secret`
  (`auth_middleware`); IDOR probes on random run/connection ids → 404; runs/
  workers scoped by `user_id`. PASS.
- A02 Crypto Failures: secrets write-only via API (never returned); platform
  secrets in `.env` (0600) never served. At-rest = disk-level (documented).
- A03 Injection: parametrized SQL (probes inert, table intact); JSON-only API
  + strict CSP defeats XSS; pure-script command execution runs in E2B.
  AgentDriver is trusted in-process execution and requires separate review of
  host-side tools, connection scopes, approvals, and secret handling.
  PASS for the audited single-tenant policy.
- A04 Insecure Design: per-user quotas, body-size caps, secret length caps.
- A05 Misconfig: CORS locked to `*.floom.dev`; auth-configs endpoint gated
  behind env flag (404 by default).
- A06 Vulnerable deps: pinned; out of scope for this pass (no `npm audit`
  run — flagged as follow-up).
- A07 Auth Failures: 401/403 without secret on every protected path.
- A08 Integrity: webhook HMAC verification (`COMPOSIO_WEBHOOK_SIGNING_KEY`).
- A09 Logging: redaction in place (see #8).
- A10 SSRF: pure-script network access happens inside E2B. Agent-worker MCP
  URLs are dialed by AgentDriver in the API process after URL validation and
  are trusted platform configuration under the current deployment policy.
  Server-side fetches (Composio/Granola/OpenAI) use the API process. PASS for
  the audited single-tenant policy; this is not an agent sandbox guarantee.

### 5. SQLi / XSS / auth — PASS
- SQLi: `?worker_id=1' OR '1'='1` → `[]`; `;DROP TABLE runs;--` inert, table
  intact. Parametrized queries throughout.
- XSS: API returns JSON only, CSP `default-src 'none'`; no field is rendered
  as HTML server-side.
- Auth bypass: every protected endpoint returns 401/403 without `x-floom-secret`.

### 6. `.env` not leaking — PASS
E2B sandboxes for pure-script workers receive only `FLOOM_RUN_ID` +
`FLOOM_TRACE_ID` as env; secrets come from `get_secrets_for_worker`, which
filters `_PLATFORM_SECRET_NAMES` (FLOOM_SECRET, COMPOSIO_API_KEY,
COMPOSIO_WEBHOOK_SIGNING_KEY, E2B_API_KEY, infra paths). AgentDriver receives
the resolved worker-secret set in the API process; its `run_command` tool
forwards only requested declared secrets plus runtime paths into E2B.
env-vars-worker dumping `os.environ` inside the E2B sandbox sees no platform
secret. (OPENAI_API_KEY is intentionally allowed into worker sandboxes in
single-tenant V0; must split to a platform-only name when multi-tenant lands —
documented in code.)

### 7. Sensitive data in API responses — PASS (1 residual P2)
- `/system/overview`: no secret-shaped strings.
- `/connections`: `account_label` redacted to "Connected account";
  `mcp_auth_secret` is a secret-NAME reference, not a value.
- `/connections/<id>/account-info`: `email` now returns `null` (NEW-7 email
  leak fixed); only scopes + connected_at.
- `/connections/auth-configs/<id>`: returns 404 unless
  `WORKEROS_ENABLE_INTERNAL_AUTH_CONFIGS=1` (NEW-8 fixed).
- **Residual P2 (not fixed)**: `composio_connection_id` (`ca_*`) is still in
  the `ConnectionItem` serializer. The kimi audit recommended stripping it as
  "frontend doesn't need it" — that is **incorrect for the current code**:
  `ConnectionsClient.tsx`, `ConnectionEventPicker.tsx`, the account-info route,
  and `TriggersEditor.tsx` all key off `composio_connection_id`. Stripping it
  would break the connections UI + trigger editor. Single-tenant: these ids
  are the owner's own and are only usable WITH the COMPOSIO_API_KEY, which
  never leaves the server. Fixing properly = refactor the frontend to key off
  the internal UUID `id` — out of scope for this lane; flagged for a follow-up.

### 8. Secrets in logs — PASS
journald (last 5000 lines): 0 occurrences of the literal FLOOM_SECRET /
COMPOSIO_API_KEY / OPENAI_API_KEY / E2B_API_KEY values; 0 secret-shaped tokens.
Run logs served via `_redact_public_log_message` (strips trace/thread/run/call/
tool ids, rewrites "Missing secrets: X" and "<VAR> not configured"). DB `logs`
table: 0 rows containing the Composio key value.

### 9. API keys in frontend — FIXED (P0)
**P0 found and fixed.** `GET https://workers.floom.dev/api/floom-secret`
returned the 64-char platform `FLOOM_SECRET` (full API admin credential) to
**any unauthenticated internet visitor** — no login wall, no header check.
Verified live: HTTP 200 + `{"api_secret":"<64-char>"}`. The route existed as a
convenience for the Settings token panel. Removed the route entirely;
`CliCommandPanel` now reads the token only from this browser's localStorage and
offers a paste-to-store input when absent (same pattern as the cli-auth page).
No `NEXT_PUBLIC_*SECRET/KEY/TOKEN` anywhere in the web source.

### 10. Keys server-side / behind proxy — PASS
`apps/web/app/api/proxy/[...path]/route.ts` reads `process.env.FLOOM_API_SECRET`
(server-only, no NEXT_PUBLIC) and injects `x-floom-secret` server-side.
`lib/server-api.ts` uses the secret only in Server Components. The browser never
receives `x-floom-secret`.

### 11. Rate limits (bill-burn) — FIXED
- run-create: per-user DB quota, `WORKEROS_RUN_CREATE_RATE_LIMIT` default
  10/60s (+ optional per-worker). Verified (test 11th → 429). PASS.
- draft-from-prompt: 4000-char cap + `_enforce_draft_rate_limit` (20/hour). PASS.
- cli-auth/devices: 5/60s IP + 100-entry cap. PASS.
- **`/chat` had NO per-user quota** — only the loose 60/60s IP limiter, despite
  calling OpenAI on every request. **Fixed**: added `_enforce_chat_quota`,
  per-user DB sliding window (default 20/60s, `WORKEROS_CHAT_RATE_LIMIT` /
  `WORKEROS_CHAT_RATE_WINDOW_SECONDS`), 429 + Retry-After. Test added.

### NEW-1 — PASS (verified fixed earlier)
100KB body to POST /workers → 239-byte 422 response, no input echo. The global
`RequestValidationError` handler strips `input`/`ctx` and caps to 10 errors.

### NEW-2 — PARTIAL (phishing residual P2)
Sub-issue (a) unbounded map: FIXED (cap 100, 5/60s IP rate-limit, prune-expired).
Sub-issue (b) phishing leak of raw FLOOM_SECRET: the approve page now requires
the user to re-type the device code (`confirmCode === code`) before approving,
a meaningful blind-approval mitigation. **Residual (P2)**: on approval the
server still hands the raw FLOOM_SECRET (full admin key) to whatever device
polls; the approve UI does not show the attacker-controlled `client_name` or
the originating IP. Proper fix = mint a per-CLI scoped token instead of
returning the platform secret (needs CLI-side coordination); deferred —
single-tenant + confirm-code gate make this low-likelihood now.

### NEW-3 — PASS (verified fixed earlier)
200-char secret name → 422; 1MB value → 413. `_upsert_env_var` caps name 1-64,
value 1-32768, rejects newline/null injection.

---

## Items needing Federico

1. **Privacy/Terms for Cloud**: the OS `/privacy` + `/terms` are single-tenant
   statements. If Workeros Cloud (multi-tenant, prospect-facing) reuses this
   frontend, replace with a real GDPR privacy policy (processor list, DSAR
   paths) + ToS. Product decision.
2. **NEW-7 `ca_*` exposure** (P2): proper fix requires a frontend refactor to
   key connections off the internal UUID. Low risk single-tenant. Schedule?
3. **NEW-2 phishing** (P2): mint a scoped CLI token instead of returning the
   raw FLOOM_SECRET. Needs CLI + API coordination.
4. **`npm audit` / dependency CVE scan** not run this pass (A06) — follow-up.

## What was fixed (this lane)
- P0: removed unauthenticated `/api/floom-secret` admin-secret leak.
- Item 11: per-user `/chat` rate quota (bill-burn).
- Item 1: `/privacy` + `/terms` pages.
- Item 2: `docs/SECURITY-DATA-MAP.md`.
- Fixed a pre-existing red security test (`test_ratelimit_uses_cf_connecting_ip`)
  that asserted obsolete per-IP run-create behavior; retargeted to the real
  IP-keyed path.

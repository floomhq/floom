# pd-14 — Reliability and catastrophic perception

**Lens:** [`docs/PRODUCT.md`](../../PRODUCT.md) (ICP, three surfaces, load-bearing paths), [`docs/ROADMAP.md`](../../ROADMAP.md) (P1: error tracking, uptime monitoring).  
**Code / docs read:** `apps/web/src/components/runner/OutputPanel.tsx`, `apps/server/src/index.ts`, `apps/server/src/routes/health.ts`, `apps/server/src/lib/sentry.ts`, `apps/server/src/types.ts` (error taxonomy), `apps/server/src/services/proxied-runner.ts` (classification at source).  
**Cross-reference:** `docs/functionality-audit/by-area/fn-01-bootstrap.md` — **not present** in this workspace at audit time; no fn-01 cross-link.

---

## 1. Executive truth table (reliability vs promise)

| Promise (PRODUCT / ROADMAP) | Observed reality | Verdict |
|------------------------------|------------------|---------|
| ICP gets from prototype to production without learning infra plumbing | Failures on run/build/deploy still surface as technical concepts in places (HTTP status in subcopy, “upstream”, Git errors); taxonomy reduces *wrong* catastrophe but not *zero* jargon | **Partial** |
| Same three surfaces (web, MCP, HTTP) for every app | Run-level error taxonomy is centered on **web runner** (`OutputPanel`); MCP/HTTP callers get protocol-native errors and must map mental model themselves | **Partial** |
| “Hosting is the product” — runs should feel trustworthy | PR #135-class fix: 4xx no longer masquerade as “can’t reach”; `error_type` + `upstream_status` persisted from `proxied-runner` | **Met** (for proxied path where fields populate) |
| Operators / Floom can observe production failures | `SENTRY_DSN` optional; `captureServerError` on Hono `onError`, `unhandledRejection`, `uncaughtException`; ROADMAP lists Sentry as **P1**, not P0 | **Partial** |
| Health checks for uptime / orchestration | `GET /api/health/` returns JSON with counts + version; no dependency probes (DB failure would still try query and 500), no “degraded” semantics | **Partial** |
| Rate limits protect run surfaces | `index.ts` documents throttling on run/job/MCP app paths; health/hub list exempt | **Met** (implementation present; perception separate) |

---

## 2. User-visible failure universe

Grouped by **where the user notices pain** and **who can fix it** (end user vs creator vs operator).

### A. Run outcome failures (primary ICP moment)

These appear after “Run” on `/p/:slug` (and analogously in any UI that reuses `OutputPanel` / `RunRecord`).

| Universe bucket | Typical signals | User-facing story (after taxonomy) | Who acts |
|-----------------|-----------------|-----------------------------------|----------|
| **Bad input / app validation** | `error_type: user_input_error`, `upstream_status` 4xx (non-auth), message in `HTTP NNN: …` | “The app didn’t accept your input”; first field focused | End user |
| **Auth / secrets** | `auth_error`, 401/403, manifest has `secrets_needed` | “Needs authentication”; Open Secrets (owner) | Owner or end user (if shared secret policy) |
| **Auth-shaped but not fixable by viewer** | Upstream 401/403, **zero** declared secrets → stored/UI class `app_unavailable` | “Isn’t available right now”; creator must fix | Creator |
| **Upstream sick / overloaded** | `upstream_outage`, 5xx, or timeout after response path | “Server error” / “took too long”; **Try again** | Retry or wait |
| **Network / URL wrong** | `network_unreachable`, DNS/TCP/TLS pre-response | “Can’t reach …”; Edit app URL (owner) | Owner |
| **Missing secret before call** | `missing_secret` → UI `missing_secret_prompt` | “This app needs a secret” | Owner |
| **Floom platform** | `floom_internal_error`, `build_error`, `oom` | Red-tint card; “Report this” → GitHub issue with `run_id` | Floom + optional owner report |
| **Deprecated model / repo access** | Heuristics on error string | “Deprecated model” / “Couldn’t access repository” | Creator / owner |
| **Unknown / legacy** | `runtime_error`, `status: error`, unclassified | “Didn’t finish” / “Didn’t complete”; retry or details | Ambiguous |

**Surfaces outside web form:** MCP (`/mcp/app/:slug`) and `POST /api/:slug/run` return structured JSON; callers do not get the amber/red cards, copy, or focus-management — **catastrophic perception is a web-runner specialty** unless clients replicate taxonomy.

### B. Request-level failures (no `RunRecord` yet)

| Case | User sees | Notes |
|------|-----------|--------|
| Uncaught exception in Hono stack | `{ "error": "internal_server_error" }` **500** | ```127:131:apps/server/src/index.ts``` — generic; Sentry may capture if configured |
| Global `FLOOM_AUTH_TOKEN` mismatch | Auth failure (middleware) | Health stays open per comments in `index.ts` |
| Rate limit | Throttled response (per middleware) | Documented in `index.ts`; user may read as “Floom broken” vs “slow down” |
| CORS / browser-only | Console / failed fetch | Open routes use `origin: '*'` without credentials; restricted routes allow-listed — **misconfigured client origin** feels like total outage |

### C. Platform / lifecycle

| Case | User perception | Evidence |
|------|-----------------|----------|
| Cloud boot: auth migrations fail | **Process exits** — total unavailable | ```928:934:apps/server/src/index.ts``` |
| Seed failure | Logged; server may still listen | ```937:945:apps/server/src/index.ts``` — partial boot |
| `unhandledRejection` / `uncaughtException` | Logged + Sentry; Node default may leave process unhealthy | ```132:139:apps/server/src/index.ts``` — no `process.exit` in snippet |
| Backend-only mode (no web dist) | JSON at `/` saying start web separately | ```906:914:apps/server/src/index.ts``` |
| Health says `ok` while app subset broken | “OK” + counts only | ```7:17:apps/server/src/routes/health.ts``` |

### D. Security-adjacent “failure” (trust, not availability)

| Case | Perception |
|------|------------|
| HTML output sanitization failure (theoretical) | XSS in Floom origin — catastrophic trust loss; mitigated by DOMPurify path in `OutputPanel` comments |

---

## 3. Truth table — signals → UI class → recommended action

Rows reflect **`classifyRunError`** precedence: control-plane `error_type` first, then legacy types, then HTTP from `upstream_status` or parsed error string, then heuristics, then fallbacks.  
Palette: **platform** = red family (`floom_internal_error`); **user** / **upstream** = amber (`OutputPanel` `palettForSeverity`).

| `run.error_type` (persisted) | `upstream_status` | Other | UI `data-error-class` | Severity | Primary action in UI |
|------------------------------|---------------------|-------|------------------------|----------|-------------------------|
| `user_input_error` | 4xx (non-auth) | — | `user_input_error` | user | Fix inputs (auto-focus) |
| `auth_error` | 401/403 | `declaredSecretsCount > 0` | `auth_error` | user | Open Secrets (owner) |
| `auth_error` | 401/403 | **0** secrets | **`app_unavailable`** | upstream | None (copy: creator must fix) |
| `upstream_outage` | 5xx | — | `upstream_outage` | upstream | Try again |
| `timeout` / timeout heuristics | optional | — | `upstream_outage` (`meta: timeout`) | upstream | Try again |
| `network_unreachable` | null | — | `network_unreachable` | upstream | Edit app URL (owner) |
| `app_unavailable` | * | — | `app_unavailable` | upstream | None |
| `floom_internal_error` | any | — | `floom_internal_error` | platform | Report this |
| `missing_secret` | null | — | `missing_secret_prompt` | user | Open Secrets (owner) |
| `build_error` | — | — | `floom_internal_error` | platform | Report this |
| `oom` | — | — | `floom_internal_error` | platform | Report this |
| `runtime_error` / `status: error` | unknown | — | **`upstream_outage`** (“didn’t finish”) | upstream | Try again |
| (none) | 429 | string heuristic | `upstream_outage` | upstream | Try again (copy: rate limit) |
| (none) | 404 | from string | `user_input_error` | user | Fix inputs |
| (none) | — | network-ish string | `network_unreachable` | upstream | Edit URL if owner |
| (none) | — | else | `unknown` | upstream | Details only |

**Server source alignment:** HTTP-class errors for proxied apps are assigned in `proxied-runner` (`classifyHttpStatus`, `app_unavailable` guard when no `secrets_needed`, `classifyPreResponseError` for timeouts vs network). See ```587:691:apps/server/src/services/proxied-runner.ts```.

---

## 4. ICP journey — failure branches (short)

1. **Land on `/p/:slug`, run succeeds** — happy path; no reliability story.
2. **Bad body / validation** — previously risk: “can’t reach” + retry loop; **now** user_input_error path; **risk residual:** generic 418/409 still bucket as user_input_error with whatever message extraction returns.
3. **Upstream down** — upstream_outage + Try again; **risk:** user equates Floom reliability with third-party API.
4. **Creator misconfigured OpenAPI URL** — network_unreachable for owner; viewer sees same copy without Edit URL — **dead-end for non-owner**.
5. **Floom bug / OOM / build** — floom_internal_error; **trust:** “not your fault” + GitHub link; depends on user willingness to file.
6. **MCP or HTTP integration** — user sees JSON `error` / HTTP code; **no** guided taxonomy — **perception gap vs web**.
7. **Whole server down / 500 before run** — generic `internal_server_error`; **catastrophic** “Floom is broken” with no run_id.

---

## 5. Risk register

| ID | Severity | Risk | Evidence | Mitigation state |
|----|----------|------|----------|------------------|
| R1 | **P0** | **Header meta vs card mismatch** for proxied apps with secrets: `metaLabelFor` always passes `declaredSecretsCount: 0`, so `auth_error` downgrades to **`app_unavailable` in the run header** while **`ErrorCard` shows `auth_error`** when manifest declares secrets. | ```722:731:apps/web/src/components/runner/OutputPanel.tsx``` vs ```353:370:apps/web/src/components/runner/OutputPanel.tsx``` | **Gap** — undermines “taxonomy agreement” called out in comments |
| R2 | **P1** | **Health lies by omission:** `ok` only proves process + trivial DB read; no runner/docker/MCP smoke, no “degraded”. | ```7:17:apps/server/src/routes/health.ts``` | **Partial** — fine for liveness, poor for “is Floom usable” |
| R3 | **P1** | **Sentry optional** — production blind spots until ROADMAP P1 “Error tracking” is operationalized per env. | ```49:85:apps/server/src/lib/sentry.ts```, ROADMAP P1 | **Shipped opt-in** |
| R4 | **P1** | **Generic 500** for unhandled errors — no correlation id in JSON body for non-run endpoints; harder support. | ```127:131:apps/server/src/index.ts``` | **Gap** |
| R5 | **P2** | **`runtime_error` → upstream_outage** in UI encourages retry when root cause might be permanent misconfiguration. | ```895:908:apps/web/src/components/runner/OutputPanel.tsx``` | **Honest ambiguity** — better than wrong bucket; still retry-bias |
| R6 | **P2** | **`uncaughtException` continues process** — can cause undefined behavior after; ops perception “random 500s”. | ```136:139:apps/server/src/index.ts``` | **Policy unclear** |
| R7 | **P2** | **Three-surface parity:** MCP/HTTP lack OutputPanel taxonomy — power users may assume Floom is “flaky” when JSON is sparse. | PRODUCT three surfaces | **Document or align** |

---

## 6. Open PM questions

1. **Correlation IDs:** Should every JSON 500 include a stable `request_id` (and should the web app show “reference XYZ” for non-run failures the way `floom_internal_error` shows run id)?
2. **Non-owner remediation:** For `network_unreachable` / `app_unavailable`, is “contact the creator” enough, or do we need an in-product “notify author” loop?
3. **MCP / HTTP error envelope:** Should `POST /api/:slug/run` and MCP tool errors echo the same `error_class` slug as `data-error-class` for client adapters?
4. **Health contract:** Do we want `/api/health/deep` (DB + optional docker ping) for operators, keeping `/api/health/` fast for k8s?
5. **Retry ethics:** For `upstream_outage` after 429, is “Try again” the right default without backoff hint in UI?
6. **Sentry P0?** ROADMAP places Sentry in P1 — does Floom Cloud commit to DSN in all prod tiers before positioning “production hosting”?
7. **Meta line fix:** Approve a small follow-up so `metaLabelFor` receives `declaredSecretsCount` (or drops meta for auth) — **product consistency** vs test churn?

---

## 7. Closing note (catastrophic perception)

The worst historical failure mode called out in code comments was **misleading collapse of distinct failures into “can’t reach / runtime_error”**, training users to **retry bad input** and eroding trust in both Floom and the app author. The 2026-04-20 taxonomy directly targets that (**PRODUCT-aligned**: respect the non-developer AI engineer who cannot debug TLS). Remaining catastrophe modes are **platform-wide 500s without narrative**, **surface inconsistency (web vs API)**, and **operational observability** still roadmap-weighted behind core launch items.

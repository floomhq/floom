# fn-08 — `routes/run.ts` (`runRouter`, `slugRunRouter`, `meRouter`)

**Lens:** `docs/PRODUCT.md` — all deployment paths must expose the same three surfaces; `run.ts` is the HTTP control plane for **starting runs** (`POST /api/run`, `POST /api/:slug/run`), **observing them** (`GET /api/run/:id`, `GET /api/run/:id/stream`, `POST /api/run/:id/share`), and **per-identity history** (`GET /api/me/runs`, `GET /api/me/runs/:id`). Execution still lives in `services/runner.ts` (hosted Docker + `proxied-runner`).

**Scope:** `apps/server/src/routes/run.ts` only, with cross-references to `runner.ts`, `proxied-runner.ts`, `lib/body.ts`, `lib/log-stream.ts`, `lib/auth.ts`, `services/session.ts`.

---

## Request validation

**JSON envelope**

- Both POST handlers use `parseJsonBody` from `lib/body.ts`: empty or whitespace-only body becomes `{}` (supports zero-input `curl`); non-whitespace that fails `JSON.parse` returns **400** with `{ error, code: 'invalid_body', details }` via `bodyParseError`.
- Top-level JSON must be an **object** (not array, primitive, or `null`); otherwise **400** `wrong_shape`.

**`runRouter.post('/')` (`POST /api/run`)**

- Requires `typeof body.app_slug === 'string'`; missing or wrong type → **400** `"app_slug" is required"`.
- Loads app by slug; missing app → **404**; `status !== 'active'` → **409**.
- Resolves manifest JSON; parse failure → **500** `"App manifest is corrupted"`.
- Action: first non-empty `body.action` string, else default `'run'` if present in manifest, else first key in `manifest.actions`. Unknown action → **400** `Action "…" not found`.
- Inputs: `validateInputs(actionSpec, (body.inputs ?? {}) as Record<string, unknown>)`; throws `ManifestError` → **400** `{ error, field }` (no `error_type` — not a persisted run failure).
- Optional `thread_id`: only accepted if `typeof body.thread_id === 'string'`; otherwise stored as `null`.

**`slugRunRouter.post('/')` (`POST /api/:slug/run`)**

- Slug from path param; same app status, visibility, manifest, action, and `validateInputs` path as above.
- **No** `app_slug` or `thread_id` in body: `thread_id` is always inserted as **`NULL`**, so slug-based HTTP runs cannot attach to a thread the way `POST /api/run` can.

**Gaps**

- `app_slug` that is `""` (empty string) passes the `string` check and typically yields **404** `App not found` — acceptable but slightly asymmetric vs explicit validation.
- No route-local cap on body size; limits depend on the HTTP server / reverse proxy.

---

## `error_type` classification

**This file does not classify run failures.** It only **reads** `runs.error_type` (and `upstream_status`) from SQLite for responses.

- **POST** paths never set `error_type`; they enqueue work via `dispatchRun` and return `{ run_id, status: 'pending' }`.
- **`formatRun`** passes through `error_type` and `upstream_status` from the row for owner/admin views.
- **`formatPublicShareView`** forces `error_type: null` (with `error`, `logs`, `inputs`, `upstream_status` null) so public viewers do not see taxonomy intended for the owner.

**Where classification actually happens (consistency)**

- **`services/runner.ts` → `runProxiedWorker`:** on proxied completion, persists `result.error_type` from `runProxied`, defaulting to `'runtime_error'` when `status === 'error'` and `error_type` is missing; `upstream_status` from proxied result; on thrown exception → `'floom_internal_error'`.
- **`services/runner.ts` → `runActionWorker`:** Docker/entrypoint path sets `error_type` for timeout (`'timeout'`), OOM (`'oom'`), silent output errors (`'runtime_error'`), structured `ok: false` (`parsed.error_type || 'runtime_error'`), and internal failures (`'floom_internal_error'`).

So HTTP GET responses stay aligned with `proxied-runner` / `runner` as long as those services write the row correctly — `run.ts` is not a second source of truth.

---

## Auth for `/api/me/*`

**`meRouter.get('/runs')`**

- Calls `resolveUserContext(c)` (device cookie always ensured; cloud mode attaches Better Auth workspace/user when logged in).
- **Authenticated:** `WHERE runs.workspace_id = ? AND runs.user_id = ?`.
- **Not authenticated:** `WHERE runs.workspace_id = ? AND runs.device_id = ?`.
- **Does not** call `requireAuthenticatedInCloud`: in cloud mode, anonymous callers still receive a **device-scoped** history (same pattern as run ownership for unclaimed runs).
- **Does not** re-join or re-check `apps.visibility`:** list can include runs for apps that are now private or deleted (`LEFT JOIN` yields null app fields) — metadata leak surface is limited to rows the user/device already created.

**`meRouter.get('/runs/:id')`**

- Same scope clause + `runs.id = ?`; missing row → **404** `Run not found` (including cross-tenant or other user’s id — no oracle beyond “not found”).
- Returns full owner payload including `logs`, `inputs`, `upstream_status` (unlike list endpoint, which omits `logs` / `thread_id` by design).

**`/api/me` vs run read gates**

- `GET /api/run/:id` uses `checkRunAccess` + optional public redacted view + `hasValidAdminBearer` bypass.
- `/api/me/runs*` uses **only** SQL scoping on workspace + user_id or device_id — no `is_public` share semantics (expected: “my runs” is owner history only).

---

## Streaming (`GET /api/run/:id/stream`)

**Authorization**

- Same app visibility gate as GET (`loadAuthorizedRunApp` → `checkAppVisibility`).
- **No** public-share path: if `checkRunAccess` is not `'owner'` and `hasValidAdminBearer` is false → **404** (live logs treated as sensitive; matches comment in file).

**Protocol**

- Hono `streamSSE`: events `log` (`{ stream, text, ts }`) and `status` (full `formatRun` snapshot).
- Subscriber receives **replay** (`handle.history`) then **live** lines via `getOrCreateStream(id).subscribe`.

**Limits**

- **SSE wait:** hard stop **10 minutes** (`setTimeout` + unsubscribe); client can still poll `GET /api/run/:id`.
- **`lib/log-stream`:** in-memory append per run until `finish()`; no per-run line cap in `run.ts`. Completed streams are deleted after **60s** if no listeners remain — long SSE reconnect windows could miss lines if they reconnect after eviction (edge case).

**Ordering / errors**

- `send` wraps `writeSSE` in try/catch for client disconnect.
- Admin bearer bypasses ownership for stream same as GET.

---

## Limits (pagination, concurrency, rate)

- **`GET /api/me/runs`:** `limit` query clamped with `Math.max(1, Math.min(200, Number(c.req.query('limit') || 50)))`. If `limit` is non-numeric (e.g. `?limit=foo`), `Number(...)` is **NaN** and the expression yields **NaN** — passed into SQL `LIMIT ?` (SQLite behavior is undefined / may error). Worth hardening with `Number.isFinite` + fallback.
- **No** explicit rate limiting or max concurrent runs in this file (would be global middleware or runner queue elsewhere).

---

## Consistency with `proxied-runner` / `runner`

**Dispatch**

- Both POST routes call `dispatchRun(row, manifest, runId, actionName, validated, undefined, ctx)` — same sixth argument (`perCallSecrets` unused on HTTP path; MCP can supply overrides), same seventh argument **`SessionContext`** so per-user secrets and workspace match web/MCP (`runner.ts` documents this W4 gap-close).

**App type branching**

- `dispatchRun` chooses `runProxied` vs `runAppContainer` from `app.app_type`; `run.ts` does not duplicate that logic — good single control plane.

**Fields exposed to HTTP clients**

- `formatRun` includes `upstream_status` with comment that `/p/:slug` uses it with `error_type` — matches `types.ts` and `proxied-runner` / `runner` persistence.
- Slug route omits `thread_id` on insert only; otherwise same runner contract.

**Product alignment (`docs/PRODUCT.md`)**

- `run.ts` sits on the execution boundary called out for path 2 (Docker runner) and path 3 (proxied): it must not fork semantics; current design delegates all classification and secret merge to `runner.ts` / `proxied-runner.ts`, which matches the “three surfaces, one runner” model.

---

## Summary table

| Area | Verdict |
|------|---------|
| Request validation | Strong for JSON shape and manifest inputs; minor edge cases (`limit` NaN, empty `app_slug` string). |
| `error_type` | Owned by runner/proxied-runner; routes pass through or redact for public share — consistent. |
| `/api/me` auth | Workspace + user_id or device_id SQL scope; no cloud forced-login on list; no app visibility re-check on list. |
| Streaming | Owner/admin only; 10m SSE cap; log bus memory/eviction behavior is separate from this file. |
| Limits | List `limit` clamp mostly sane; invalid `limit` query is a robustness hole. |
| Runner consistency | Same `dispatchRun` + `ctx` as other entrypoints; no duplicate proxied/hosted selection. |

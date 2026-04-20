# Auxiliary routes — functionality audit (FN-21)

Scope: server handlers in `apps/server/src/routes/` that correspond to `parse.ts`, `pick.ts`, `thread.ts`, `feedback.ts`, `reviews.ts`, and `deploy-waitlist.ts`. Product context is [`docs/PRODUCT.md`](../../PRODUCT.md): these paths support discovery (NL → app / picker), run UX (thread persistence), trust signals (reviews), product feedback, and lead capture around deployment—not one of the three primary execution surfaces (`/p/:slug`, `/mcp/...`, `/api/:slug/run`), but they sit on the same API host and share global middleware.

Global stack (applies unless a route overrides): `app.use('/api/*', globalAuthMiddleware)` when `FLOOM_AUTH_TOKEN` is set (Bearer or `access_token` query on GET); `app.onError` returns `{ error: 'internal_server_error' }` with status 500 for uncaught errors. These six routers are **not** behind the run/job rate limiter mounted on `/api/run`, `/api/:slug/run`, `/api/:slug/jobs`, and `/mcp/app/:slug`.

---

## `parse.ts` (`POST /api/parse`)

### Auth

- No session, cookie, or per-user check inside the handler.
- Subject to optional **global** bearer gate via `FLOOM_AUTH_TOKEN` like all `/api/*` routes.
- Any caller who passes global auth (or runs with token unset) can invoke parsing for **any** `app_slug` present in `apps` (no visibility or ownership check on the app row).

### Validation

- JSON body read with `.catch(() => ({}))`; missing fields yield 400.
- `prompt` and `app_slug` must be non-empty strings.
- `action` optional string; resolved to `body.action`, else `run` if present in manifest, else first action key.
- Manifest JSON parsed from DB; invalid JSON → 500 `"App manifest is corrupted"`.
- Unknown action name → 400 `"Action \"...\" not found"`.

### Abuse

- **No dedicated rate limit** on this path; each call can trigger `parsePrompt` (LLM when `OPENAI_API_KEY` is set), so an open instance is a cost and latency amplifier.
- Reveals whether a slug exists (404 vs 200) and exposes internal action names via errors—minor information disclosure.
- Large prompts are not bounded in this route (limits depend on `parsePrompt` / upstream).

### Error envelopes

- Success: 200 JSON `{ app_slug, action, inputs, confidence, reasoning }` (no `error` field).
- Client errors: `{ error: string }` (400, 404)—no `code` or `details`.
- Server errors: `{ error: 'App manifest is corrupted' }` (500).
- Unhandled exceptions: global envelope `{ error: 'internal_server_error' }` (500).

---

## `pick.ts` (`POST /api/pick`)

### Auth

- None in-handler; optional global `FLOOM_AUTH_TOKEN` only.

### Validation

- `prompt` required non-empty string → 400 `{ error: '"prompt" is required' }`.
- `limit`: if `typeof body.limit === 'number'` and in `(0, 10]`, used; else default **3**. Non-numeric strings fall through to default (no error), which is permissive.

### Abuse

- **No rate limit** on this path; with `OPENAI_API_KEY` set, each request may call OpenAI embeddings (`pickApps`); failures fall back to keyword scoring inside the service, so abuse still costs CPU/DB reads over all active public apps.
- Response is limited to **public** (`visibility = 'public'` or null) active apps per `pickApps` query—does not leak private app metadata through this service.

### Error envelopes

- Success: `{ apps }` only.
- Validation failure: `{ error: string }` (400)—no `code`.
- No explicit JSON parse error response: invalid JSON becomes `{}` and fails the `prompt` check with the same 400 shape.

---

## `thread.ts` (`POST /api/thread`, `GET /api/thread/:id`, `POST /api/thread/:id/turn`)

### Auth

- Explicitly **none** (file comment: browser-generated thread id, “same anon waitlist model as the marketplace”).
- Optional global `FLOOM_AUTH_TOKEN` only.

### Validation

- `POST /`: no body; always creates a row with `newThreadId()` (`thr_` + nanoid-style id).
- `GET /:id`: no format validation on `id`; missing thread → 404 `{ error: 'Thread not found' }`.
- `POST /:id/turn`: `kind` must be exactly `"user"` or `"assistant"` → 400. `payload` optional, defaults to `{}` when stringified. **Auto-creates** the thread if `id` does not exist (intended for client flow), so arbitrary `id` in the path becomes a writable thread.

### Abuse

- **No rate limit**; unbounded inserts into `run_turns` / thread rows for anyone who can reach the API.
- **IDOR model**: knowledge of a thread id grants read and append; ids are short prefixed random strings (not user-scoped), so guessing is unlikely but sharing a URL leaks the thread.
- Auto-create removes the need to `POST /` first, so clients can spam new thread ids without a separate creation call.

### Error envelopes

- Mostly `{ error: string }` for 400/404.
- Success payloads omit a unified `code` field.
- `safeParse` on stored payloads returns `null` on invalid JSON without surfacing an error to the client (data integrity degradation, not an HTTP error).

---

## `feedback.ts` (`POST /api/feedback`, `GET /api/feedback`)

### Auth

- **POST**: `resolveUserContext(c)` runs (device cookie minted via `getOrCreateDeviceId`; OSS uses synthetic `local` workspace/user; cloud uses Better Auth session when present). No requirement to be logged in; authenticated users get `user_id` stored, anonymous get `null` user with `device_id` / `ip_hash`.
- **GET (admin list)**: `FLOOM_FEEDBACK_ADMIN_KEY` must be set; otherwise 403 `{ error, code: 'admin_disabled' }`. Caller must present the exact key as `Authorization: Bearer <key>` or `?admin_key=` query. Plain string compare (not timing-safe vs a peer secret, but single static admin key).

### Validation

- **POST**: Zod schema—`text` 1–4000 chars, optional `email` (valid email, max 320), optional `url` max 2000. Invalid JSON → 400 `code: 'invalid_body'`. Zod failure → 400 with `details: parsed.error.flatten()`.

### Abuse

- **POST**: Rolling in-memory rate limit **20 requests per IP hash per hour** (`x-forwarded-for` / `x-real-ip`, first hop only; salted hash via `FLOOM_FEEDBACK_SALT`). 429 `{ error, code: 'rate_limited' }`. Buckets are **process-local** (reset on restart; weak under multi-instance).
- **GET**: No rate limit in code; guarded only by admin secret. Query param `admin_key` risks logging/leak via referrers and access logs.

### Error envelopes

- Structured: `{ error, code }` and optional `details` (Zod flatten) on 400/429; success `{ ok: true, id }`.
- Admin misconfig: 403 with `code: 'admin_disabled'`; wrong credentials: **401** `{ error: 'Unauthorized', code: 'unauthorized' }` (note: 403 used when admin feature disabled).
- CORS: `/api/feedback/*` uses **restricted** CORS with credentials (`apps/server/src/index.ts`), unlike several other auxiliary routes.

---

## `reviews.ts` (`GET /api/apps/:slug/reviews`, `POST /api/apps/:slug/reviews`)

### Auth

- **GET**: Public; no user context.
- **POST**: `resolveUserContext(c)` always; **no check** for `ctx.is_authenticated`. In OSS mode context is always the synthetic `local` workspace and `local` user. In cloud mode, anonymous sessions still receive that same synthetic default from `resolveUserContext` when there is no Better Auth session (`apps/server/src/services/session.ts`), so the handler still runs with `user_id = 'local'`. File comments state anonymous callers cannot review in cloud and POST is “logged-in users only”; **the code does not enforce that**—all unauthenticated cloud traffic shares the same `(workspace_id, user_id)` as OSS for the upsert key, so reviews collapse to a single shared row for anonymous users.

### Validation

- **GET**: `limit` query clamped to 1–50 (default 20). `slug` from path, no existence check (empty slug still runs query; returns empty summary/reviews).
- **POST**: App must exist → 404 `{ error, code: 'app_not_found' }`. Body JSON required; Zod `rating` int 1–5, optional `title`/`body` max lengths; invalid shape returns 400 with `details` flatten.

### Abuse

- **No rate limit** on GET or POST; POST can repeatedly upsert the same row (per workspace/app/user) or create rows for every app slug enumeration (404 cheap, 201/200 expensive).
- GET exposes `author_email`-derived display fragment in serializer (email local-part) for joined users—by design for public reviews.

### Error envelopes

- Documented in-file as `{ error, code, details? }` for errors; success returns `{ summary, reviews }` or `{ review }` with 201/200.

---

## `deploy-waitlist.ts` (`POST /api/deploy-waitlist`)

### Auth

- None in-handler; optional global `FLOOM_AUTH_TOKEN` only.

### Validation

- JSON required; non-JSON → 400 `{ error: 'invalid json' }`.
- `email` trimmed; rejected only if empty or **does not include `@`** (not RFC-grade email validation). `spec_url` optional, trimmed, stored as null if empty (max length not enforced in route).

### Abuse

- **No rate limit**, no CAPTCHA, no deduplication; trivial spam to SQLite `deploy_waitlist` and table **created at module import** (`CREATE TABLE IF NOT EXISTS`), which is a side effect on every server load.

### Error envelopes

- Errors: `{ error: string }` (400)—no `code`.
- Success: `{ ok: true }` only.

---

## Cross-cutting summary

| File | Session / user | Strong validation | Abuse controls | Error shape |
|------|----------------|-------------------|----------------|-------------|
| `parse.ts` | None | Partial (strings, action) | None on route | `{ error }` only |
| `pick.ts` | None | Prompt only; loose `limit` | None on route | `{ error }` only |
| `thread.ts` | Anonymous by design | `kind` enum | None on route | `{ error }` only |
| `feedback.ts` | Context + admin key | Zod | IP-hash bucket (POST) | `{ error, code, details? }` |
| `reviews.ts` | Context without auth gate on POST | Zod + app exists | None on route | `{ error, code, details? }` |
| `deploy-waitlist.ts` | None | Weak email | None on route | `{ error }` / `{ ok }` |

For operators aligning with [`docs/PRODUCT.md`](../../PRODUCT.md): tightening these routes (rate limits, consistent envelopes, cloud-only `is_authenticated` on reviews POST, app visibility on parse) reduces risk to the “paste repo, we host it” story without touching the load-bearing execution paths listed there.

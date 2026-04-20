# ax-01 — AuthZ matrix (mutating routes × caller classes)

Scope: `apps/server` Hono routes and `globalAuthMiddleware` / `requireAuthenticatedInCloud` / `checkAppVisibility` / signature-based edges. Cross-link `docs/PRODUCT.md` (three surfaces, paste-first), `docs/product-audit/deep/` for ICP expectations.

## Caller classes (columns)

| ID | Class | How recognized |
|----|--------|----------------|
| A | **OSS synthetic** | `FLOOM_CLOUD_MODE` unset/false → `resolveUserContext` always `workspace_id=user_id='local'` + device cookie |
| B | **Cloud anonymous** | Cloud mode, no Better Auth session → same synthetic `local`/`local` ids + device cookie (see `session.ts` fallback) |
| C | **Cloud authenticated** | Better Auth session → real `workspace_id`, `user_id`, `is_authenticated: true` |
| D | **Bearer `FLOOM_AUTH_TOKEN`** | When env set: all `/api/*`, `/mcp/*`, `/p/*` require matching bearer (`lib/auth.ts`); health/metrics exempt per path |
| E | **Verified external** | `/hook/*` HMAC (`webhook.ts`); Stripe `/api/stripe/webhook` signature (`stripe.ts`) |
| F | **Metrics scraper** | `GET /api/metrics` with `METRICS_TOKEN` (own gate; not `FLOOM_AUTH_TOKEN`) |

**Note:** D is orthogonal: if `FLOOM_AUTH_TOKEN` is set, classes A–C still need the bearer for HTTP access; self-host docs should say operators use bearer for scripts/MCP.

## Global gates (baseline)

- `globalAuthMiddleware`: `/api/*`, `/mcp/*`, `/p/*` only — **not** `/renderer/*`, `/hook/*`, `/og/*`, static `/*` SPA (`index.ts` ~140–145).
- `requireAuthenticatedInCloud`: blocks B-style callers on routes that call it (401 `auth_required`).
- `checkAppVisibility`: enforces app `visibility` + optional admin bearer for private apps on run-like surfaces.

## Mutating routes — matrix (abbrev.)

Legend: **Y** allowed, **N** denied, **—** not applicable, **(c)** conditional (visibility / ownership / signature).

| Route / method | A OSS | B Cloud anon | C Cloud auth | D bearer | Notes / `file:line` |
|----------------|-------|--------------|--------------|----------|----------------------|
| `POST /api/hub/detect` | Y | Y | Y | (c) | No `requireAuthenticatedInCloud` — spec discovery; SSRF risk tracked in `ax-02` (`hub.ts` ~103) |
| `POST /api/hub/ingest` | Y | **N** | Y | (c) | `requireAuthenticatedInCloud` (`hub.ts` ~132–135) |
| `PATCH/DELETE /api/hub/:slug` | Y | **N** | Y + owner | (c) | Cloud gate + owner (`hub.ts` ~330–395) |
| `POST/DELETE /api/hub/:slug/renderer` | Y | **N** | Y + owner | (c) | Same pattern (`hub.ts` ~712+) |
| `POST /api/run`, `POST /api/:slug/run` | (c) | (c) | (c) | (c) | `checkAppVisibility` (`run.ts` ~152+) |
| `POST /api/:slug/jobs`, cancel | (c) | (c) | (c) | (c) | `checkAppVisibility` (`jobs.ts` ~34+) |
| `POST /api/parse` | Y | Y | Y | (c) | **Gap:** no `checkAppVisibility` — may leak parse behavior for non-public apps (`parse.ts` ~9+) |
| `POST /api/pick` | Y | Y | Y | (c) | Relies on `pickApps` / embeddings filtering — **verify** private apps excluded for B/C |
| `POST /api/thread`, `POST /api/thread/:id/turn` | Y | Y | Y | (c) | Intentionally unauthenticated thread model (`thread.ts` ~1–4) — abuse/spam risk |
| `POST /api/deploy-waitlist` | Y | Y | Y | (c) | Open write (`deploy-waitlist.ts` ~16+) — rate limit / captcha product question |
| `POST /api/feedback` | Y | Y | Y | (c) | IP-hash rate limit only (`feedback.ts`) |
| `POST /api/apps/:slug/reviews` | Y | **Y (bug)** | Y | (c) | **P0/P1 gap:** no `requireAuthenticatedInCloud`; cloud anon uses synthetic `user_id='local'` like OSS — shared identity across all anonymous browsers (`reviews.ts` ~89+, `session.ts` ~146–153) |
| `POST /api/memory/*`, `POST/DELETE /api/secrets/*` | Y | **N** | Y | (c) | `requireAuthenticatedInCloud` (`memory.ts`) |
| Workspaces / invites / members mutating | Y | **N** | Y | (c) | `requireAuthenticatedInCloud` (`workspaces.ts`) |
| `POST /api/connections/*` | Y | **N** | Y | (c) | Gates present (`connections.ts`) |
| Triggers `POST /api/hub/:slug/triggers`, `PATCH/DELETE /api/me/triggers/:id` | Y | **N** / owner | Y | (c) | `requireAuthenticatedInCloud` (`triggers.ts`) |
| `POST /hook/:path` | Y | Y | Y | **N** (by design) | HMAC auth, outside `/api/*` so D does not apply (`webhook.ts` ~16–18, `index.ts` ~217–220) |
| `POST /api/stripe/*` (non-webhook) | Y | **N** | Y | (c) | Session/business rules in router |
| `POST /api/stripe/webhook` | — | — | — | E | Stripe signature (`index.ts` comment ~198–201) |
| MCP tools (mutating, e.g. `ingest_app`) | mirrors hub | **N** for ingest in cloud anon | Y | (c) | `mcp.ts` ~419+ mirrors hub ingest |

## Gap list (`file:line`)

1. **Reviews POST missing cloud anon gate** — `apps/server/src/routes/reviews.ts` (~89): add `requireAuthenticatedInCloud` or explicit `ctx.is_authenticated` check so cloud anonymous callers cannot write; align with file header intent ("logged-in users only (cloud mode)").
2. **Parse POST missing visibility** — `apps/server/src/routes/parse.ts` (~9): consider `checkAppVisibility` + session same as run, or document as intentional public surface.
3. **Doc drift: renderer auth** — `apps/server/src/routes/renderer.ts` (~28–31) claims renderer is behind `globalAuthMiddleware`; implementation only mounts global auth on `/api/*`, `/mcp/*`, `/p/*` (`index.ts` ~143–145). `/renderer/*` is public when `FLOOM_AUTH_TOKEN` unset — fix comment or add optional gate for self-host hardening.
4. **Thread / deploy-waitlist open writes** — product decision: acceptable for OSS demo vs need captcha / auth in cloud (`thread.ts`, `deploy-waitlist.ts`).

## PM questions

1. Should **any** anonymous cloud user be able to create threads, join deploy waitlist, and submit feedback at current limits?
2. Is **parse** intentionally callable without visibility checks (e.g. for SEO landing), or should it match run semantics?
3. For **self-host + `FLOOM_AUTH_TOKEN`**, should `/renderer/*` require the bearer (breaks iframe `src` unless parent sends cookies — today open CORS, no credentials)?

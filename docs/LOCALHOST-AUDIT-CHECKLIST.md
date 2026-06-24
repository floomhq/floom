# Localhost audit checklist — 2026-06-23 fixes

**Engine pin:** `01fe1e65` ([floomhq/floom#1959](https://github.com/floomhq/floom/pull/1959))  
**Cloud commit:** see `main` after engine bump + `ops/dev-local-api.sh`

## Dev recipe (real Gmail OAuth — no mock login)

```bash
# Terminal A — requires repo-root `.env` with SUPABASE_SERVICE_ROLE_KEY
bash ops/dev-local-api.sh

# Terminal B — forces localhost OAuth callback (overrides web/.env.local prod API)
cd web && npm run dev:local
```

Required env (also in `.env.example`):

| Variable | Local value |
|----------|-------------|
| `WORKEROS_ROLE` | `web` |
| `WORKEROS_API_BASE` | `http://127.0.0.1:8000` |
| `WORKEROS_OAUTH_CALLBACK_BASE` | `http://localhost:3000/app/api/proxy` |
| `WORKEROS_COOKIE_DOMAIN` | `none` |
| `WORKERS_FRONTEND_URL` | `http://localhost:3000/app` |
| `WORKEROS_DASHBOARD_ORIGIN` | `http://localhost:3000` |

Supabase redirect allowlist must include:

`http://localhost:3000/app/api/proxy/auth/callback`

Login path: `/app/login` → **Continue with Google** → `/app/overview`.

> **Note:** If `web/.env.local` points `WORKEROS_API_BASE` at prod, OAuth callbacks land on `workeros-api.floom.dev` and cookies get `Domain=.floom.dev`. Use `npm run dev:local` + local API instead.

## Automated verification (2026-06-24)

| Suite | Result |
|-------|--------|
| `web` vitest: collection-view, connections-redirect-flow-guard, medium-issue-batch-source | **32 pass, 1 skip** |
| `tests/test_auth_email_flows.py::test_localhost_google_oauth_forces_fresh_account_prompt` | **pass** |
| `web` `npm run check-drift` | **pass** |
| Landing `start-channel-819.dom.test.tsx` | **5 pass** |

## Checklist

| # | Item | Status | Evidence |
|---|------|--------|----------|
| 1 | Dashboard login adopts **landing design** (#665): “Hire AI workers.” panel, Today activity card, centered “Welcome back” + “Magic link, password, or OAuth.” (not old “Floom Cloud / Recent worker runs” overlay) | ✅ localhost (2026-06-24 re-verify) | `test-results/localhost-audit-report-2026-06-24/screenshots/01-localhost-login-welcome-back.png` |
| 2 | MCP install panel — 6 client icons in a row | ✅ prod UI* | `screenshots/05-prod-mcp-install-panel.png` |
| 3 | MCP config shows `workeros-api.floom.dev` host | ✅ prod UI* | same |
| 4 | Emily home empty — real PromptInput composer | ✅ code + tests | engine `EmilyHomeEmpty` + vitest |
| 5 | Collection control strip (search / view toggle / add) | ✅ prod UI* | `screenshots/03-prod-workers-collection.png` |
| 6 | Settings collection — **list view default** (not gallery), search + view toggle | ⏳ code fix on disk | engine `settings/page.tsx` — needs engine PR + bump |
| 7 | Connections collection + humanized provider names | ✅ prod UI* + test | `screenshots/06-prod-connections-collection.png`, redirect test |
| 8 | Connections redirect — no stale router.replace after unmount | ✅ test | `connections-redirect-flow-guard.dom.test.tsx` |
| 9 | Connections redirect — terminal “Still waiting” state | ⚠️ manual | test skipped (jsdom timer); verify in browser |
| 10 | User avatar squircle (not circle) | ✅ code | `Avatar.tsx` in engine #1959; deploy to see in UI |
| 11 | Emily send button squircle | ✅ code | `PromptInput.tsx` in engine #1959; deploy to see in UI |
| 12 | Localhost Gmail OAuth callback path | ✅ unit test | `test_localhost_google_oauth_forces_fresh_account_prompt` |
| 13 | `/start/slack`, `/start/whatsapp` landing routes | ✅ code / ❌ prod | tests pass; prod still 404 until landing redeploy |

\*Prod screenshots use an authenticated session on `workeros.floom.dev`. UI is byte-synced with localhost via `npm run sync` (zero drift). Authenticated localhost screenshots require completing Gmail OAuth with the dev recipe above.

HTML report: `test-results/localhost-audit-report-2026-06-24/index.html`

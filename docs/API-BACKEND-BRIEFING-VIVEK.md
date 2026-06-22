# Workeros API Backend Briefing for Vivek

Date: 2026-06-01

## Product Boundary

There are two products and two production API backends.

| Surface | Repo | Public app URL | API backend | Auth model |
| --- | --- | --- | --- | --- |
| Workeros OSS app | `floomhq/floom` | `https://workers.floom.dev` | `https://workers-api.floom.dev` | `x-floom-secret` / OSS token |
| Workeros Cloud wrapper | `floomhq/workeros-cloud` | `https://workeros.floom.dev/app` | `https://workeros-api.floom.dev` | Supabase session JWT + workspace header |

The OSS app is the information-worker OS. The Cloud repo is the hosted wrapper around that app: OAuth, Supabase auth, workspaces, billing-ready user/account boundaries, and Cloud-specific routing.

## Routing Rules

OSS frontend routes API traffic through:

```text
workers.floom.dev/api/proxy/* -> workers-api.floom.dev/*
```

Cloud frontend routes API traffic through:

```text
workeros.floom.dev/app/api/proxy/* -> workeros-api.floom.dev/api/*
```

Cloud server-rendered pages use:

```text
web/lib/server-api.ts
```

That file is an overlay-owned Cloud file and sends:

```text
Authorization: Bearer <Supabase access token>
x-workeros-workspace: <active workspace id>
```

Cloud executable routing now reads `WORKEROS_API_BASE` and falls back to `https://workeros-api.floom.dev`. It does not read `FLOOM_API_BASE`; that variable belongs to the OSS app.

## Local Development

For OSS/local Workeros development:

```bash
FLOOM_API_BASE=http://127.0.0.1:8000
```

For Cloud wrapper development against a local Cloud API:

```bash
WORKEROS_API_BASE=http://127.0.0.1:8000
NEXT_PUBLIC_WORKEROS_API_BASE=http://127.0.0.1:8000
```

For Cloud wrapper development against production Cloud API:

```bash
WORKEROS_API_BASE=https://workeros-api.floom.dev
NEXT_PUBLIC_WORKEROS_API_BASE=https://workeros-api.floom.dev
```

Do not use `FLOOM_API_BASE` in `floomhq/workeros-cloud`.

## Current Verification

OSS production worker list:

```bash
curl -sS https://workers.floom.dev/api/proxy/workers?shape=list
```

Verified result on 2026-06-01:

```text
HTTP 200
59 workers
first IDs: weekly_update, cv_writeup, dach_compliance, reverse_match_crm, gmail_intake_brief
```

Cloud routing source check:

```bash
rg -n "FLOOM_API_BASE|workers-api\\.floom\\.dev|WORKEROS_API_BASE|workeros-api\\.floom\\.dev" \
  web/app web/lib web/middleware.ts web/overlay web/components web/scripts
```

Verified result on 2026-06-01:

- Executable Cloud routing uses `WORKEROS_API_BASE` / `workeros-api.floom.dev`.
- Remaining `workers-api.floom.dev` strings are OSS copy/examples in UI text, not Cloud request routing.

Cloud build verification:

```bash
cd web
npm run sync
npm run lint
npm run check-drift
npm run build
```

Verified result on 2026-06-01:

```text
lint: 0 errors, existing warnings only
check-drift: PASS
build: compiled and type-checked successfully
```

## Recent `/workers` Incident

`https://workers.floom.dev/workers` rendered empty because the OSS API list endpoint crashed:

```text
GET /workers?shape=list -> HTTP 500
AttributeError: 'NoneType' object has no attribute 'get'
```

Root cause: one worker contained a malformed/null connection entry. The worker-detail endpoint still worked, but the list-card projection assumed every non-string connection was a dict with an MCP object.

Fix landed in `floomhq/floom`:

```text
33b43be fix(api): tolerate malformed worker connections in list
```

The fix skips malformed connection entries and accepts the known manifest shapes:

- plain slug string
- `{ app: "..." }`
- `{ slug: "..." }`
- `{ toolkit: "..." }`
- `{ label: "..." }`
- `{ name: "..." }`
- `{ mcp: { label: "..." } }`

Regression tests:

```bash
python3 -m pytest apps/api/tests/test_monitoring_apis.py tests/test_pr_h_worker_cards.py -q
```

Verified result:

```text
64 passed
```

## Deployment Notes

`floomhq/workeros-cloud` vendors the app from `floomhq/floom` through the `engine` submodule plus overlay files.

When syncing Cloud with the app:

```bash
cd /root/workeros-cloud/engine
git fetch origin main
git checkout <workeros commit>

cd /root/workeros-cloud/web
npm run sync
npm run check-drift
npm run build
```

Overlay-owned files are listed in:

```text
web/scripts/sync-engine-web.mjs
```

Cloud-only files that must stay overlay-owned:

- `web/overlay/lib/server-api.ts`
- `web/overlay/app/api/proxy/[...path]/route.ts`
- `web/overlay/app/api/cli-auth/[action]/route.ts`
- `web/overlay/app/connections/connected-accounts/[id]/route.ts`
- workspace/auth/layout overlay files

The Cloud wrapper can sync UI and shared app code from Workeros, but Cloud auth/workspace routing must stay Cloud-specific.

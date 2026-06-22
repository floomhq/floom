# Cloud Deploy Recovery - 2026-06-06

## Summary

Cloud production is live on Cloud commit `1670e10933240c28c7428aad13c141470d6d1431`.

Final Cloud `engine/` pin:

```text
e8fd80c8d7f673cacc445cd9d5fc09ecd26ffb35
```

Current OSS `floomhq/floom` `main` at deploy time:

```text
e8fd80c8d7f673cacc445cd9d5fc09ecd26ffb35
```

Final Cloud engine pin equals current OSS main: **yes**.

## Source Change

Clean recovery worktree:

```text
/tmp/workeros-cloud-deploy-recovery-20260607
```

Commit pushed to Cloud `main`:

```text
1670e10933240c28c7428aad13c141470d6d1431 chore(engine): bump to e8fd80c
```

Changes:

- Bumped `engine/` submodule from `efb480fe888d5b3f22e99c5ba5ab0a600fe6bb8c` to `e8fd80c8d7f673cacc445cd9d5fc09ecd26ffb35`.
- Added `query_string: b""` to synthetic Starlette `Request` scopes in auth/workspace tests so the existing query-workspace path is tested under current Starlette.

## API Autodeploy Fast-Forward Divergence

Service:

```text
workeros-cloud-api-autodeploy.service
```

Script:

```text
/usr/local/bin/workeros-cloud-api-autodeploy
```

Deploy checkout:

```text
/opt/workeros-cloud-deploy
```

Root cause:

- `/opt/workeros-cloud-deploy` had no uncommitted files.
- Its `main` branch had diverged from `origin/main`: 7 local commits ahead and 12 upstream commits behind.
- The autodeploy script runs `git merge --ff-only origin/main`; with local-only commits on `main`, fast-forward was impossible and systemd exited with Git status 128.

Local commits found on the divergent deploy checkout:

```text
7eb4a27 fix(cloud): resolve engine workers dir before imports
3a581f6 fix(cloud): allow worker-author system runs
ad6c4f4 fix(cloud): register worker-author system row
4cf160d fix(cloud): supply platform key to worker-author
904c609 fix(cloud): avoid decorated read after run status update
1d4c1d8 fix(cloud): tolerate worker-author secret store disconnect
ec61e8c Merge remote-tracking branch 'origin/main'
```

Preserved:

- Branch in the old checkout: `deploy-checkout-diverged-20260606` at `ec61e8c9ed3fd0d89934379d921738e7d45ab354`.
- Full original checkout directory: `/opt/workeros-cloud-deploy.diverged-20260606-ec61e8c`.

Reconciliation:

- Created a fresh clean checkout at `/opt/workeros-cloud-deploy` from Cloud `main`.
- Initialized `engine/` at `e8fd80c8d7f673cacc445cd9d5fc09ecd26ffb35`.
- Restarted `workeros-cloud-api`.
- Ran `workeros-cloud-api-autodeploy.service`; it completed with status `0/SUCCESS`.

## Deployments

### Landing

Deployment:

```text
dpl_Dzk9sVyCRFnRHvhgUbwgd6x22dsH
https://workeros-cloud-landing-q1mdlgtdy-fedes-projects-5891bd50.vercel.app
```

Status: `Ready`.

Aliases:

```text
https://workeros.floom.dev
https://www.workeros.floom.dev
https://workeros-cloud-landing.vercel.app
https://workeros-cloud-landing-fedes-projects-5891bd50.vercel.app
https://workeros-cloud-landing-git-main-fedes-projects-5891bd50.vercel.app
```

### Dashboard

The git-triggered dashboard production deployment from repo root failed:

```text
dpl_9w7E1dvEs9YPHcWCsaK2TJqfvxwD
https://workeros-cloud-dashboard-r8341ausp-fedes-projects-5891bd50.vercel.app
status: Error
```

This matched the known dashboard deploy constraint: the dashboard must deploy from `web/` with the synced tree already present. The successful production deploy was run from the clean `web/` directory after `npm run sync`.

Successful dashboard deployment:

```text
dpl_GCshmuQGwsv1yLBtCEru5ch1eqjt
https://workeros-cloud-dashboard-dhz3eujb8-fedes-projects-5891bd50.vercel.app
```

Status: `Ready`.

Aliases:

```text
https://workeros-cloud-dashboard.vercel.app
https://workeros-cloud-dashboard-fedes-projects-5891bd50.vercel.app
```

### Public API

Public API DNS:

```text
workeros-api.floom.dev -> ngp92ufc.up.railway.app
```

Railway deployment:

```text
c60606bb-b01f-426e-abde-e8a2e8044d6e
```

Status: `SUCCESS`.

Deploy command:

```bash
RAILWAY_TOKEN="$(cat /root/.config/railway-token)" railway up --service workeros-cloud-api --detach
```

## Verification

Local source verification from `/tmp/workeros-cloud-deploy-recovery-20260607`:

```text
npm run sync && npm run check-drift
PASS: synced tree matches engine/apps/web (overlay excluded). Zero drift.

python3 -m py_compile apps/api/main.py engine/apps/api/main.py
PASS

python3 -m pytest
143 passed, 21 warnings in 12.72s

npm run build
PASS

cd web && npm run build
PASS
```

API checkout verification:

```text
/opt/workeros-cloud-deploy HEAD: 1670e10933240c28c7428aad13c141470d6d1431
/opt/workeros-cloud-deploy/engine HEAD: e8fd80c8d7f673cacc445cd9d5fc09ecd26ffb35
/opt/workeros-cloud-deploy status: ## main...origin/main
```

Public API verification:

```text
GET https://workeros-api.floom.dev/healthz
HTTP 200
{"status":"ok","deploy":"cloud"}

GET https://workeros-api.floom.dev/health
HTTP 200
status=ok, db=ok, disk=ok, e2b=ok, openai=ok, composio=ok

POST https://workeros-api.floom.dev/api/workers/nonexistent-worker/share-link
HTTP 401
{"detail":"missing bearer token"}
```

Route smoke:

```text
bash ops/smoke-routes.sh cloud
SMOKE PASSED - all routes are non-508 and non-5xx.
```

Public dashboard route verification:

```text
GET https://workeros.floom.dev/app
HTTP 307 -> /app/login?next=%2Fapp -> HTTP 200

GET https://workeros.floom.dev/assistant
HTTP 307 -> /app/assistant -> HTTP 307 -> /app/login?next=%2Fapp%2Fassistant -> HTTP 200
```

Both HTML responses referenced deployment asset query `dpl=dpl_GCshmuQGwsv1yLBtCEru5ch1eqjt`.

Screenshots captured with headless Chrome:

```text
/tmp/workeros-prod-app.png
/tmp/workeros-prod-assistant.png
```

Both screenshots show the rendered Floom login page with the email input and OAuth buttons; no loading or skeleton state was present.

## Dirty Checkout Preservation

The canonical checkout at `/root/workeros-cloud` was dirty before recovery began and was not reset, rebased, cleaned, or overwritten. Git work was done in `/tmp/workeros-cloud-deploy-recovery-20260607`; the API deploy checkout was preserved by moving the full divergent directory aside before installing a clean checkout.


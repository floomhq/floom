# Cloud Fix Report - 2026-06-05

Scope: Cloud launch-readiness follow-up for the live 508 dashboard fix, engine sync, and Cloud API dependency audit. No secret values are recorded in this report.

## 508 Fix

Target source: `origin/main@856d42015ec7557774a3b4f6fb37aeffcc21e894`, where `web/vercel.json` is deleted.

Before deploy, verified at 2026-06-05 20:09 CEST:

| URL | Result |
| --- | --- |
| `https://workeros.floom.dev/` | `HTTP 200` |
| `https://workeros.floom.dev/app` | `HTTP 508`, `x-vercel-error: INFINITE_LOOP_DETECTED` |
| `https://workeros-cloud-dashboard.vercel.app/app` | `HTTP 508`, `x-vercel-error: INFINITE_LOOP_DETECTED` |

Deploy path:

- Clean worktree: `/tmp/workeros-cloud-deploy-856d420`
- `git submodule update --init --recursive` checked out `engine@b30c53f591027c6ecc1772884d8b96f9338e022e`.
- `cd web && npm run sync` completed with 155 engine files copied, 31 overlay files layered, and `web/vercel.json` absent.
- Direct `vercel deploy --prod --yes` created `workeros-cloud-dashboard-dxjy74cva-fedes-projects-5891bd50.vercel.app` but remained `UNKNOWN` with no build logs.
- `vercel pull --yes --environment=production`, `vercel build --prod`, and `vercel deploy --prebuilt --prod --yes` completed.
- Ready deployment: `workeros-cloud-dashboard-4vwd5966o-fedes-projects-5891bd50.vercel.app`
- Vercel deployment id: `dpl_ArgHSGspVWyYHTp9nd9K7rEcp6A4`
- Aliased production domain: `https://workeros-cloud-dashboard.vercel.app`

After deploy, verified at 2026-06-05 20:18 CEST:

| URL | Result |
| --- | --- |
| `https://workeros-cloud-dashboard.vercel.app/app` | final `HTTP 200`, effective URL `/app/login?next=%2Fapp%2Foverview` |
| `https://workeros.floom.dev/app` | final `HTTP 200`, effective URL `/app/login?next=%2Fapp%2Foverview` |
| `https://workeros.floom.dev/` | `HTTP 200` |

Landing was not redeployed because apex `/app` stopped looping after the dashboard production alias moved to the fixed READY deployment.

## Engine Sync

Branch: `codex/cloud-launch-fixes-20260605`, created fresh from `856d42015ec7557774a3b4f6fb37aeffcc21e894`.

Engine target verified from the submodule remote:

- Previous Cloud pin: `b30c53f591027c6ecc1772884d8b96f9338e022e`
- WorkerOS `main`: `e45032e62a32ecc33f403bbe446f14e1f0b221dd`
- Engine commit subject: `fix backend bugpass connections and reliability (#439)`

Sync verification:

- `cd web && npm run sync`: completed with 156 engine files copied and 31 overlay files layered.
- `web/vercel.json`: absent before and after sync.
- `cd web && npm run check-drift`: `PASS: synced tree matches engine/apps/web (overlay excluded). Zero drift.`
- `cd web && npm run build`: passed Next.js production build and TypeScript.

## Dependency Result

Cloud-owned dependency changes:

- `apps/api/requirements.txt`: `cryptography==43.0.1` -> `cryptography==48.0.0`
- `apps/api/requirements.txt`: `supabase==2.15.3` -> `supabase==2.31.0`
- `Dockerfile`: removed the obsolete `websockets` override install path; the root requirements now resolve directly.

Resolution evidence:

- `python3 -m pip install --dry-run -r requirements.txt`: resolved successfully. The resolved Supabase lane includes `supabase==2.31.0`, `realtime==2.31.0`, and `websockets==15.0.1`, satisfying `openai-agents==0.17.4`.
- `python3 -m pip_audit -r apps/api/requirements.txt --progress-spinner off`: `No known vulnerabilities found`.
- `docker build -t workeros-cloud-api-depcheck:20260605 .`: passed and installed the resolved requirements without the previous `websockets` override. Docker reported the pre-existing build warning `SecretsUsedInArgOrEnv` for `ARG GIT_TOKEN`.

Python test verification:

- Focused startup/auth/security slice: `6 passed, 3 warnings`.
- Broader Cloud launch-readiness slice: `91 passed, 14 warnings`.

Commands run for the broader slice:

```bash
python3 -m pytest tests/test_workspace_api_tokens.py tests/test_workspace_header.py tests/test_supabase_auth_provider.py tests/test_workspaces_migration.py tests/test_workspace_routes.py tests/test_members.py tests/test_cloud_security_hardening.py tests/test_registration.py tests/test_auth_email_flows.py tests/test_auth_logout.py tests/test_cli_auth_devices.py tests/test_cli_exchange.py tests/test_cli_approve_claim.py tests/test_cloud_workspace_agent.py tests/test_workspace_agent_migration.py tests/test_secret_crypto.py -q
```

## Open Notes

- The API was not deployed.
- The unsafe `cloud-engine-sync-20260605` branch was not merged or modified.
- `npm ci` in `web/` reports 2 moderate npm audit findings from the existing frontend dependency graph; this report only resolved the requested Cloud API dependency audit lane.

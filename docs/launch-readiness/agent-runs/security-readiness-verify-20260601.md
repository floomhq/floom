# Security Readiness Verification: Round 2 Claims

Date: 2026-06-01 08:44-08:53 CEST
Lane: C, security/readiness verification only
Repos:
- OSS source: `/tmp/workeros-ui-round2` at `7d820b1aa545e5e388d622602bb099d0a26d9a9b`
- Cloud wrapper source: `/root/workeros-cloud` at `d635005ac46d53d1b25e5fb945cf2e404823ac73`
- Cloud engine submodule: `7d820b1aa545e5e388d622602bb099d0a26d9a9b`
Live/API hosts:
- OSS public API: `https://workers-api.floom.dev`
- Cloud public API: `https://workeros-api.floom.dev`
- Hosted OSS origin on AX41: `http://127.0.0.1:8011`
- Hosted Cloud origin on AX41: `http://127.0.0.1:8030`

## Scope

I verified the pasted Round 2 report against current source and live/origin behavior. I did not edit application code and did not run destructive API calls. Authenticated origin checks used the local configured secret without printing the value.

## Repo State

Command:

```bash
git -C /tmp/workeros-ui-round2 fetch origin
git -C /tmp/workeros-ui-round2 rev-list --left-right --count HEAD...origin/main
git -C /tmp/workeros-ui-round2 status --short
git -C /root/workeros-cloud fetch origin
git -C /root/workeros-cloud rev-list --left-right --count HEAD...origin/main
git -C /root/workeros-cloud status --short
git -C /root/workeros-cloud submodule status
```

Result:

```text
/tmp/workeros-ui-round2: 0 0, clean working tree, HEAD 7d820b1
/root/workeros-cloud: 0 0, clean working tree, HEAD d635005
submodule: 7d820b1 engine (remotes/origin/HEAD)
```

Operational note:

```bash
systemctl cat workeros-api
git -C /opt/workeros-live rev-parse HEAD
git -C /opt/workeros-live status --short
git -C /root/workeros rev-parse HEAD
git -C /root/workeros status --short
```

Result:

```text
workeros-api WorkingDirectory=/opt/workeros-live/apps/api
workeros-api ExecStart=/root/workeros/apps/api/venv/bin/uvicorn main:app --host 127.0.0.1 --port 8011
/opt/workeros-live HEAD bfc4090c99193285e064b90240b651b0945d6b72, dirty
/root/workeros HEAD b516b717723924639b00957f0c306f30156b2e75, large dirty tree
```

This means committed source, hosted origin code, and `/root/workeros` are not identical. The current deployed OSS origin has several newer security fixes present in `/opt/workeros-live`, but stock worker files/data are split across `/root/workeros` and `/opt/workeros-live`.

## Live API Verification

### OSS Public API: Cloudflare Claim Confirmed

Commands:

```bash
curl -sS -i https://workers-api.floom.dev/healthz | sed -n '1,40p'
curl -sS -i https://workers-api.floom.dev/health | sed -n '1,60p'
curl -sS -i -X OPTIONS https://workers-api.floom.dev/workers \
  -H 'Origin: https://workers.floom.dev' \
  -H 'Access-Control-Request-Method: GET' | sed -n '1,80p'
```

Results:

```text
/healthz: HTTP/2 403, server: cloudflare, content-type: text/html; charset=UTF-8
/health: HTTP/2 403, server: cloudflare, content-type: text/html; charset=UTF-8
OPTIONS /workers: HTTP/2 403, server: cloudflare, content-type: text/html; charset=UTF-8
HTML title: "Attention Required! | Cloudflare"
```

Verdict: Round 2 P0 claim is confirmed for the public OSS API from AX41.

### OSS Origin: Backend Itself Is Healthy

Commands:

```bash
curl -sS -i http://127.0.0.1:8011/healthz | sed -n '1,40p'
curl -sS -i -X OPTIONS http://127.0.0.1:8011/workers \
  -H 'Origin: https://workers.floom.dev' \
  -H 'Access-Control-Request-Method: GET' | sed -n '1,80p'
```

Results:

```text
/healthz: HTTP/1.1 200 OK, {"status":"ok"}
OPTIONS /workers: HTTP/1.1 200 OK
access-control-allow-origin: https://workers.floom.dev
access-control-allow-methods: DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT
```

Verdict: Cloudflare, not FastAPI, is the public blocker for OSS health/CORS.

### Cloud Public API: Different Behavior

Commands:

```bash
curl -sS -i https://workeros-api.floom.dev/healthz | sed -n '1,40p'
curl -sS -i https://workeros-api.floom.dev/health | sed -n '1,60p'
curl -sS -i -X OPTIONS https://workeros-api.floom.dev/api/workers \
  -H 'Origin: https://workeros.floom.dev' \
  -H 'Access-Control-Request-Method: GET' | sed -n '1,80p'
```

Results:

```text
/healthz: HTTP/2 200, {"status":"ok","deploy":"cloud"}
/health: HTTP/2 404, {"detail":"Not Found"}
OPTIONS /api/workers: HTTP/2 200 OK with access-control-allow-origin: https://workeros.floom.dev
```

Verdict: Round 2 Cloudflare health/OPTIONS claim does not apply to the Cloud API. Cloud has `/healthz` and CORS on `/api/workers`; `/health` is missing.

## Worker Protection And Stock Worker State

### Source Protection Set

Command:

```bash
nl -ba /tmp/workeros-ui-round2/apps/api/main.py | sed -n '246,268p'
python3 - <<'PY'
from pathlib import Path
text = Path('/tmp/workeros-ui-round2/apps/api/main.py').read_text()
block = text[text.find('PROTECTED_STOCK_WORKER_IDS'):text.find('PUBLIC_STOCK_WORKER_IDS')]
for wid in ['search_console_insights','gmail_inbox_manager','linkedin_post_engagements','linkedin-post-engagements','gmail_intake_brief']:
    print(f'{wid}:', wid in block)
PY
```

Result:

```text
PROTECTED_STOCK_WORKER_IDS includes linkedin-post-engagements and gmail_intake_brief.
search_console_insights: False
gmail_inbox_manager: False
linkedin_post_engagements: False
linkedin-post-engagements: True
gmail_intake_brief: True
```

Command:

```bash
find /tmp/workeros-ui-round2/workers -maxdepth 2 -name worker.yml -print | sort
```

Relevant result:

```text
workers/search_console_insights/worker.yml exists
workers/gmail_inbox_manager/worker.yml does not exist
workers/linkedin-post-engagements/worker.yml exists
workers/linkedin_post_engagements/worker.yml does not exist
```

Verdict: Round 2 protection claim is partially confirmed against current source. `search_console_insights` is a shipped worker directory but is not protected. `gmail_inbox_manager` and `linkedin_post_engagements` are not shipped in the clean current OSS tree.

### Test Confirmation

Command:

```bash
python3 -m pytest tests/test_round8_worker_authz.py -q
```

Result:

```text
FAILED tests/test_round8_worker_authz.py::test_shipped_worker_directories_match_protected_set
AssertionError: Extra items in the left set: 'search_console_insights'
1 failed, 24 passed, 3 warnings in 21.49s
```

Command from Cloud wrapper, same engine test:

```bash
python3 -m pytest engine/tests/test_round8_worker_authz.py -q
```

Result:

```text
FAILED engine/tests/test_round8_worker_authz.py::test_shipped_worker_directories_match_protected_set
AssertionError: Extra items in the left set: 'search_console_insights'
1 failed, 24 passed, 3 warnings in 22.35s
```

Verdict: Confirmed P0. The guardrail test still fails.

### Hosted OSS Origin Worker State

Commands used the configured origin secret without printing it:

```bash
set -a; . /root/.config/workeros/api.env; set +a
for id in search_console_insights gmail_inbox_manager linkedin_post_engagements linkedin-post-engagements linkedin_engagements; do
  code=$(curl -sS -o /tmp/worker-$id.json -w '%{http_code}' \
    -H "x-floom-secret: ${FLOOM_SECRET}" \
    http://127.0.0.1:8011/workers/$id)
  printf '%s %s\n' "$id" "$code"
done
```

Result:

```text
search_console_insights 404
gmail_inbox_manager 404
linkedin_post_engagements 404
linkedin-post-engagements 200
linkedin_engagements 200
```

Detail check:

```bash
curl -sS -H "x-floom-secret: ${FLOOM_SECRET}" http://127.0.0.1:8011/workers/linkedin-post-engagements | jq '{id,name,enabled,trigger_type,cron,status}'
curl -sS -H "x-floom-secret: ${FLOOM_SECRET}" http://127.0.0.1:8011/workers/linkedin_engagements | jq '{id,name,enabled,trigger_type,cron,status}'
```

Result:

```json
{"id":"linkedin-post-engagements","name":"LinkedIn Post Engagements","enabled":false,"trigger_type":"schedule","cron":null,"status":"healthy"}
{"id":"linkedin_engagements","name":"LinkedIn Post Engagements","enabled":true,"trigger_type":"schedule","cron":null,"status":"ready"}
```

Verdict: Round 2 data-loss claim is confirmed on the hosted OSS origin for `search_console_insights` and `gmail_inbox_manager` returning 404. LinkedIn duplication is confirmed on the hosted origin, but the clean current repo only contains the kebab-case worker.

## System Endpoint Auth

### OSS Origin

Commands:

```bash
curl -sS -i http://127.0.0.1:8011/system/info | sed -n '1,80p'
curl -sS -i http://127.0.0.1:8011/system/platform-config | sed -n '1,100p'
curl -sS -i http://127.0.0.1:8011/integrations/triggers | sed -n '1,80p'
```

Result:

```text
/system/info: HTTP/1.1 401 Unauthorized
/system/platform-config: HTTP/1.1 401 Unauthorized
/integrations/triggers: HTTP/1.1 401 Unauthorized
```

Verdict: Round 2 "missing auth" claim is not true for the current hosted OSS origin. The endpoint functions do not all declare `Depends(get_auth_context)`, but middleware gates them when `FLOOM_SECRET` is set.

### Cloud Direct API

Commands:

```bash
curl -sS -i https://workeros-api.floom.dev/api/system/info | sed -n '1,80p'
curl -sS -i https://workeros-api.floom.dev/api/system/platform-config | sed -n '1,100p'
curl -sS -i https://workeros-api.floom.dev/api/integrations/triggers | sed -n '1,80p'
```

Results:

```text
/api/system/info: HTTP/2 200, {"version":"0.1.0","started_at":"2026-06-01T06:34:47Z","python_version":"3.12.3","runner":"e2b"}
/api/system/platform-config: HTTP/2 200, {"all_required_set":false,"missing":["FLOOM_SECRET"],"set_count":5,"required_count":6}
/api/integrations/triggers: HTTP/2 200, content-length: 1446337, large Composio trigger catalog
```

Relevant Cloud source:

```text
/root/workeros-cloud/apps/api/main.py:41-42 pops FLOOM_SECRET in cloud mode.
/root/workeros-cloud/apps/api/main.py:168 mounts engine_main.app under /api.
/root/workeros-cloud/web/overlay/app/api/proxy/[...path]/route.ts:51-53 protects frontend proxy calls when no session exists.
```

Verdict: Confirmed P1 for the Cloud public API. The browser proxy blocks unauthenticated frontend calls, but direct public `/api/...` calls to engine endpoints can bypass that proxy for endpoints without endpoint-level auth dependencies.

## Agent Driver Scoping

Command:

```bash
nl -ba /tmp/workeros-ui-round2/apps/api/runner_sandbox/agent_driver.py | sed -n '1413,1513p'
nl -ba /opt/workeros-live/apps/api/runner_sandbox/agent_driver.py | sed -n '1413,1495p'
nl -ba /root/workeros/apps/api/runner_sandbox/agent_driver.py | sed -n '1397,1485p'
```

Results:

```text
/tmp/workeros-ui-round2:
  _invoke_worker(args, state_user_id=...) requires authenticated owner, checks repos.workers.get(user_id=state_user_id,...), creates/executes child run with user_id.
  _composio_execute(..., connection_ids, user_id) lists connections via repos.connections.list(user_id=user_id).

/opt/workeros-live:
  Same scoped behavior as current committed source.

/root/workeros:
  _invoke_worker(args) has no user_id and calls create_run/execute_run without user scope.
  _composio_execute() queries active composio_connections by app_name/status only.
```

Verdict: Round 2 P1 agent-driver scoping claim is obsolete for current committed source and the hosted `/opt/workeros-live` origin. It remains present in the dirty `/root/workeros` tree.

## Composio Proxy Allowlist And Run Token

Commands:

```bash
nl -ba /tmp/workeros-ui-round2/apps/api/main.py | sed -n '806,881p;9067,9188p'
python3 -m pytest apps/api/tests/test_composio_proxy.py apps/api/tests/test_run_token.py -q
```

Results:

```text
auth_middleware validates X-Workeros-Run-Token and only permits /runs/{id}/composio-execute/{tool}.
composio_execute_proxy verifies token_run_id == run_id.
composio_execute_proxy checks declared_composio_connections(config).
composio_execute_proxy rejects tool slugs that do not match declared worker connections.
pytest: 26 passed in 8.20s
```

Verdict: Round 2 "arbitrary tool execution" claim is fixed in current committed source and deployed origin code.

## Dependency And Targeted Test Verification

Commands:

```bash
python3 - <<'PY'
mods = ['agents', 'croniter']
for m in mods:
    try:
        mod = __import__(m)
        print(f'{m}: OK {getattr(mod, "__version__", "unknown")}')
    except Exception as exc:
        print(f'{m}: FAIL {type(exc).__name__}: {exc}')
PY

rg -n "openai-agents|croniter" /tmp/workeros-ui-round2/apps/api/requirements.txt
python3 -m pytest apps/api/tests/test_composio_proxy.py apps/api/tests/test_run_token.py apps/api/tests/test_contexts_system_packs.py -q
python3 -m pytest apps/api/tests/test_scheduled_worker_defaults.py apps/api/tests/test_trigger_type_aliases.py apps/api/tests/test_workspace_agent_endpoint.py -q
python3 -m pytest apps/api/tests/test_versioning.py -q
python3 -m pytest apps/api/tests/db/test_sqlite_workers.py apps/api/tests/db/test_db_factory.py -q
python3 -m pytest tests/test_workspace_routes.py tests/test_supabase_auth_provider.py tests/test_cli_auth_devices.py -q
```

Results:

```text
agents: OK 0.17.4
croniter: OK unknown
requirements.txt: openai-agents==0.17.4
requirements.txt: croniter>=2.0.0
Composio/run-token/context tests: 26 passed
Scheduled/defaults/trigger/workspace-agent tests: 9 passed, 17 warnings
Versioning tests: 16 passed
SQLite worker/db-factory tests: 7 passed
Cloud workspace/auth/CLI tests: 8 passed, 1 warning
```

Verdict: Round 2 missing `openai-agents` and missing `croniter` claims are fixed in this environment. The tested macOS/context path slice passed through `test_contexts_system_packs.py`; I did not find a current named failing macOS path test file in either requested repo.

## Other Verified Claims

### PATCH Nonexistent Worker

Commands:

```bash
curl -sS -i -X PATCH -H "x-floom-secret: ${FLOOM_SECRET}" \
  -H 'content-type: application/json' --data '{}' \
  http://127.0.0.1:8011/workers/nonexistent | sed -n '1,80p'

curl -sS -i -X PATCH -H 'content-type: application/json' --data '{}' \
  https://workeros-api.floom.dev/api/workers/nonexistent | sed -n '1,80p'
```

Results:

```text
OSS origin: HTTP/1.1 404 Not Found, {"detail":"Worker not found"}
Cloud public direct: HTTP/2 401, {"detail":"missing bearer token"}
```

Verdict: Round 2 "PATCH nonexistent returns 422" is fixed/currently not reproduced.

### Trusted Proxy Wildcard

Command:

```bash
nl -ba /tmp/workeros-ui-round2/apps/api/main.py | sed -n '507,535p'
grep -E '^(TRUSTED_PROXIES|WORKEROS_TRUSTED_PROXIES)=' /root/.config/workeros/api.env || true
```

Results:

```text
Source supports '*' in TRUSTED_PROXIES / WORKEROS_TRUSTED_PROXIES.
No TRUSTED_PROXIES or WORKEROS_TRUSTED_PROXIES entry is configured in /root/.config/workeros/api.env.
```

Verdict: Code still permits wildcard trusted proxies, but the current OSS origin env does not activate it.

### Rate Limiting Bypass

Relevant source:

```text
/tmp/workeros-ui-round2/apps/api/main.py:785-786:
if not os.environ.get("FLOOM_SECRET") and os.environ.get("WORKEROS_RATE_LIMIT_DEV") != "1":
    return await call_next(request)

/root/workeros-cloud/apps/api/main.py:41-42:
if WORKEROS_DEPLOY == cloud:
    os.environ.pop("FLOOM_SECRET", None)
```

Verdict: Rate limiting is active on the OSS origin with `FLOOM_SECRET` configured. In Cloud, stripping `FLOOM_SECRET` disables the engine middleware rate limiter for directly exposed unauthenticated engine endpoints. The frontend proxy has its own auth barrier, but direct API exposure remains.

### Hardcoded Dev Secrets

Command:

```bash
rg -n "dev-secret-not-set|local-dev-upload-url-signing|WORKEROS_USER_ID.*federico|FLOOM_USER_ID.*federico" \
  /tmp/workeros-ui-round2/apps/api /tmp/workeros-ui-round2/workers -S
```

Relevant results:

```text
apps/api/auth/local.py: FLOOM_SECRET is required for local auth
apps/api/auth/local.py: defaults local user id to "federico" if WORKEROS_USER_ID absent
apps/api/auth/dependency.py: fallback default user_id "federico" only when FLOOM_SECRET is absent
apps/api/main.py: upload URL signing fallback includes "local-dev-upload-url-signing"
apps/api/webhook_service.py: webhook fallback uses "dev-secret-not-set" if FLOOM_SECRET absent
```

Verdict: No real secret value was found by this bounded grep. Dev fallback strings and single-user defaults remain in source. In production, OSS origin auth returned 401 without `x-floom-secret`, confirming `FLOOM_SECRET` is set there. Cloud direct exposure makes these fallback branches more important because Cloud strips `FLOOM_SECRET`.

## Verified P0/P1/P2 List

### P0

1. `workers-api.floom.dev` Cloudflare blocks health checks and browser preflight.
   - Evidence: public `/healthz`, `/health`, and `OPTIONS /workers` return Cloudflare 403 HTML.
   - Scope: OSS public API.

2. Stock worker protection guard still fails for `search_console_insights`.
   - Evidence: `tests/test_round8_worker_authz.py` fails in both OSS and Cloud engine with extra shipped worker `search_console_insights`.
   - Scope: source and Cloud submodule.

3. Hosted OSS origin is missing stock workers that Round 2 named.
   - Evidence: authenticated origin `GET /workers/search_console_insights` -> 404, `GET /workers/gmail_inbox_manager` -> 404, `GET /workers/linkedin_post_engagements` -> 404.
   - Scope: live/origin data state.

### P1

1. Cloud direct API exposes engine endpoints without bearer auth.
   - Evidence: `GET https://workeros-api.floom.dev/api/system/info` -> 200; `/api/system/platform-config` -> 200; `/api/integrations/triggers` -> 200 and returns a 1.4 MB trigger catalog.
   - Scope: Cloud public API direct path, not the Next.js `/app/api/proxy` path.

2. LinkedIn worker duplication exists on hosted OSS origin.
   - Evidence: `linkedin-post-engagements` and `linkedin_engagements` both return 200 with the same display name; only `linkedin_engagements` appears in the list endpoint.
   - Scope: hosted origin state and `/root/workeros` dirty tree. Clean `/tmp/workeros-ui-round2` only has `linkedin-post-engagements`.

3. `/root/workeros` dirty local tree still has stale agent scoping vulnerabilities.
   - Evidence: `/root/workeros/apps/api/runner_sandbox/agent_driver.py` invokes workers and selects Composio connections without user scoping.
   - Scope: dirty local tree, not current committed source and not `/opt/workeros-live`.

### P2

1. Cloud `/health` is missing.
   - Evidence: `https://workeros-api.floom.dev/health` -> 404 while `/healthz` -> 200.
   - Scope: Cloud monitoring compatibility.

2. Engine rate limiting is bypassed when `FLOOM_SECRET` is absent, and Cloud strips `FLOOM_SECRET` before mounting the engine.
   - Evidence: source lines listed above.
   - Scope: direct Cloud `/api/...` calls.

3. Trusted proxy wildcard is still supported by source.
   - Evidence: `_trusted_proxy_peer` accepts `"*"`.
   - Current origin env does not set the wildcard.

4. Dev fallback strings and single-user default identity remain.
   - Evidence: `local-dev-upload-url-signing`, `dev-secret-not-set`, and default `"federico"` branches exist.
   - Production origin auth is currently active; this remains a hardening item.

5. Missing `openai-agents`, missing `croniter`, and PATCH nonexistent worker claims are fixed/currently not reproduced.
   - Evidence: imports succeed, requirements contain both packages, targeted tests pass, PATCH nonexistent returns 404 or 401.

## Overall Verification Verdict

Round 2 score of 67/100 is directionally still fair for the security/readiness lane because the main blocking class remains: public OSS API is Cloudflare-blocked and stock-worker protection/data state is inconsistent. Some P1/P2 items are now fixed in current source, especially agent-driver scoping and Composio proxy allowlisting. The Cloud wrapper introduces a separate direct-API exposure issue because it removes `FLOOM_SECRET` and mounts the engine under `/api`; frontend proxy auth does not cover direct API hits.

Recommended next security fixes, in order:

1. Add `search_console_insights` to `PROTECTED_STOCK_WORKER_IDS`, rerun `tests/test_round8_worker_authz.py`, and decide whether `gmail_inbox_manager` belongs in current shipped source or needs removal from live expectations.
2. Restore/redeploy missing stock workers on the hosted OSS origin or intentionally remove them from product/docs/API state.
3. Fix Cloudflare rules for `workers-api.floom.dev` `/healthz`, `/health`, and `OPTIONS`.
4. Add a Cloud-layer auth middleware or route filter around mounted engine endpoints so direct `/api/system/*` and `/api/integrations/triggers` require bearer auth unless explicitly public.
5. Consolidate `linkedin-post-engagements` and `linkedin_engagements` on the hosted origin.
6. Keep `/root/workeros` from being used as source-of-truth until its dirty stale security state is reconciled.

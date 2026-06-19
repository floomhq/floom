# Workeros Cloud Deployment

This is the operator checklist for the hosted Cloud stack.

## Targets

| Surface | Target |
| --- | --- |
| Dashboard | `https://workeros.floom.dev` |
| API | `https://workeros-api.floom.dev` |
| Railway service | `workeros-cloud-api` |

Cloud deploys are manual Railway deploys from this repository. The engine ships
from the checked-in `engine/` submodule, so Cloud must be bumped whenever an
engine fix is required in production.

## Before Deploy

1. Confirm Cloud `main` points at the intended engine commit:

   ```bash
   git submodule status engine
   ```

2. Confirm tracked source is clean. Local logs, test output, and temp files
   should not be committed.

3. Run the relevant tests for the change. For engine bumps, include the engine
   tests that cover the changed path before bumping the submodule.

4. Apply any new Supabase migrations in `supabase/migrations/` before or during
   the API deploy. For the current security hardening batch, confirm
   `0044_git_workspace_config_admin_select.sql` has been applied; otherwise
   active workspace members can still read raw Git config rows through
   PostgREST even though the application code is fixed.

5. Confirm required Railway env vars are set on `workeros-cloud-api`.

## Required Runtime Env

Core values are managed in Railway and should not be committed:

```bash
WORKEROS_DEPLOY=cloud
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
SUPABASE_JWT_SECRET=...
WORKEROS_CLOUD_SECRETS_ENCRYPTION_KEY=...
E2B_API_KEY=...
OPENAI_API_KEY=...
COMPOSIO_API_KEY=...
```

The scheduler is part of the API process and must hold a Postgres advisory lock
in Cloud. The API now fails startup if the lock DB env is missing:

```bash
WORKEROS_CLOUD_DB_HOST=...
WORKEROS_CLOUD_DB_PORT=5432
WORKEROS_CLOUD_DB_NAME=...
WORKEROS_CLOUD_DB_USER=...
WORKEROS_CLOUD_DB_PASS=...
```

`railway.toml` also pins `numReplicas = 1`. Do not increase API replicas until
scheduled-run dispatch is split into a dedicated single-replica worker service
or the scheduler lock/readiness flow is reviewed for the new topology.

Slack, signing, upload, approval, and webhook secrets must also be set when
those surfaces are enabled:

```bash
SLACK_CLIENT_ID=...
SLACK_CLIENT_SECRET=...
SLACK_SIGNING_SECRET=...
WORKEROS_MAGIC_LINK_SECRET=...
WORKEROS_UPLOAD_URL_SIGNING_SECRET=...
WORKEROS_APPROVAL_LINK_SECRET=...
WORKEROS_WEBHOOK_TOKEN_SECRET=...
WORKEROS_WORKER_CALL_SECRET=...
```

## E2B Runtime Env

Set warm-pool envs for repeat E2B runs:

```bash
WORKEROS_E2B_WARM_POOL_ENABLED=1
WORKEROS_E2B_WARM_POOL_SIZE_PER_KEY=1
WORKEROS_E2B_WARM_POOL_MAX_AGE_SECONDS=900
```

Memory-specific E2B templates are required for workers that declare
`resources.memory_mb`. For the NovaSearch 2GB path:

```bash
WORKEROS_E2B_PYTHON_TEMPLATE_MEMORY_2048=<python-2gb-template-id-or-alias>
WORKEROS_E2B_NODE_TEMPLATE_MEMORY_2048=<node-2gb-template-id-or-alias>
```

If the template env var is missing, the engine logs a warning and falls back to
the normal runtime template. That means increasing memory in code is not enough;
the matching E2B template mapping must exist in Railway.

NovaSearch workers that keep a memory pack mounted for reads should also mark
the pack writable only for the feedback/write operation, otherwise the E2B warm
pool will treat every run as mutable and cold-start it:

```yaml
memory:
  context: memory-novasearch-v5
  writeable_when:
    input: operation
    equals: record_candidate_feedback
```

## LLM Quota Controls

LLM-heavy workers, such as NovaSearch judge runs, must declare:

```yaml
llm_intensive: true
```

Set the deployment-wide cap on the API service so heavy runs queue instead of
stacking into shared Vertex/Gemini quota:

```bash
WORKEROS_MAX_CONCURRENT_LLM_RUNS=1
```

For pooled quota and shared 429 backoff, deploy the engine LiteLLM gateway
(`engine/ops/llm-gateway`) with Redis and then set:

```bash
WORKEROS_LLM_GATEWAY_URL=https://<gateway-host>/v1
WORKEROS_LLM_GATEWAY_KEY=<litellm-virtual-key>
```

Leaving the gateway vars unset is the kill switch; workers call providers
directly. The scheduler cap still works without the gateway.

## Deploy

From the Cloud repo root:

```bash
railway up --service workeros-cloud-api
```

Use the Railway project/environment that owns `workeros-api.floom.dev`. This
command uploads the current checkout, including the `engine/` submodule content.

After deployment, verify the deployment details show `numReplicas = 1` from
`railway.toml` and that `/healthz` is served by the new deployment.

## Post-Deploy Smoke

Run the read-only route smoke gate:

```bash
bash ops/smoke-routes.sh cloud
```

Expected:

- API `/healthz` returns `200`.
- `/` and `/app/login` return `200`.
- Authenticated `/app/*` routes may return `307` to login when unauthenticated.
- Final line is `SMOKE PASSED`.

For runtime-sensitive deploys, also run the relevant authenticated smoke:

- Worker create/run path after engine runtime changes.
- One NovaSearch CRM/search run after E2B memory, warm-pool, bundle, or LLM quota changes.
- Approvals create/approve/reject after approval or signing changes.

## Rollback

If smoke fails:

1. Do not promote the deploy.
2. Revert or reset Cloud `main` to the last known-good Cloud commit.
3. Re-run `railway up --service workeros-cloud-api`.
4. Re-run `bash ops/smoke-routes.sh cloud`.

If the issue is only an optional runtime env, prefer unsetting the feature flag
or gateway env first:

```bash
WORKEROS_E2B_WARM_POOL_ENABLED=
WORKEROS_LLM_GATEWAY_URL=
WORKEROS_LLM_GATEWAY_KEY=
```

## Common Misses

- Bumping engine in `workeros` but not updating Cloud's `engine/` submodule.
- Setting `resources.memory_mb` without provisioning the matching E2B template env.
- Deploying LLM scheduling code without `WORKEROS_MAX_CONCURRENT_LLM_RUNS`.
- Forgetting `llm_intensive: true` on the worker manifest.
- Assuming the LiteLLM gateway is active when `WORKEROS_LLM_GATEWAY_URL` is unset.
- Forgetting to apply Supabase migrations before deploying code that depends on
  new RLS or schema behavior.
- Missing `WORKEROS_CLOUD_DB_*` lock envs; Cloud API startup now fails closed
  rather than running an unlocked scheduler.
- Rotating or omitting `WORKEROS_CLOUD_SECRETS_ENCRYPTION_KEY`; GitHub PATs and
  legacy encrypted secrets use this key.
- Treating old systemd/autodeploy incident notes as current Cloud deployment docs.

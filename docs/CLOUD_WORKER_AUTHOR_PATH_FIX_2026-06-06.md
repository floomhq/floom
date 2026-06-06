# Cloud Worker Author Path Fix - 2026-06-06

## Root Cause

Cloud worker creation failed with:

```text
worker-author bundle not found. Ensure workers/worker-author/ exists on disk.
```

The engine resolves `worker_registry.WORKERS_DIR` once at import time from
`FLOOM_WORKERS_DIR`. On the live Cloud API, systemd set:

```text
FLOOM_WORKERS_DIR=/opt/workeros-cloud/var/workers
```

That directory is Cloud's old worker cache. It does not contain the stock
engine `worker-author` bundle. In the Cloud deploy, the vendored engine bundle
exists under:

```text
/opt/workeros-cloud-deploy/engine/workers/worker-author
```

The bundle directory was verified live with `run.py`, `SKILL.md`,
`requirements.txt`, and `worker.yml` present.

## Fix

Cloud now configures the engine workers directory in `apps/api/_engine.py`,
before any engine module import can freeze `worker_registry.WORKERS_DIR`.

In Cloud mode:

- `WORKEROS_WORKERS_DIR`, when set, is resolved and bridged into
  `FLOOM_WORKERS_DIR`.
- Otherwise, Cloud defaults `FLOOM_WORKERS_DIR` to the vendored
  `engine/workers` directory.

No files under `engine/` were edited.

The same live verification exposed additional Cloud wrapper assumptions in the
worker-author path. The PR also fixes those cloud-owned seams:

- `apps/api/startup.py` preserves the engine `create_run(..., status=None)`
  default in the member-run attribution override.
- `apps/api/db/supabase_repos.py` allows `worker-author` system runs to bypass
  tenant worker ownership prechecks while still stamping the active workspace.
- `apps/api/db/supabase_repos.py` registers the missing `worker-author`
  Supabase worker row from the vendored engine bundle before inserting a run.
- `apps/api/startup.py` supplies the process `OPENAI_API_KEY` only to the
  first-party `worker-author` system worker when the operator has not stored a
  user secret, and tolerates transient user-secret store disconnects for that
  system worker only.
- `apps/api/db/supabase_repos.py` avoids an unnecessary decorated read after
  `runs.update_status(...)`, so a stale Supabase read cannot turn a completed
  run into a failed run.

The live systemd environment was also corrected to point `FLOOM_WORKERS_DIR` at:

```text
/opt/workeros-cloud-deploy/engine/workers
```

No secret values are included in this document.

## Verification

Local verification:

```text
pytest tests/test_cloud_engine_workers_dir.py tests/test_cloud_worker_author_run.py tests/test_cloud_security_hardening.py tests/test_cloud_workspace_agent.py
```

Result: 21 passed.

Live verification:

- `systemctl restart workeros-cloud-api`: completed.
- Process env check: live PID has `WORKEROS_DEPLOY=cloud` and
  `FLOOM_WORKERS_DIR=/opt/workeros-cloud-deploy/engine/workers`.
- `POST http://127.0.0.1:8030/api/workers/new/from-prompt` with a
  workspace-scoped Cloud PAT no longer returns the original 503
  `worker-author bundle not found`.
- Verified successful start response:

```text
{"run_id":"run_86729ffed48e","worker_id":"worker-author","status":"running"}
```

- Verified worker-author executed in E2B, called the LLM, produced
  `out/bundle.json`, and completed:

```text
run_86729ffed48e status=completed output={"bundle":"out/bundle.json"}
```

- Auto-registration did not complete for that run because the generated bundle
  failed schema validation:

```text
Could not auto-register the drafted worker: scalar field 'prefixed_text' must declare type
```

- A retry with a stricter schema prompt (`run_756b23818113`) timed out in the
  worker-author run. This confirms the original path bug is fixed and the
  worker-author bundle executes, but a fully registered created worker was not
  verified in this session.
- `bash ops/smoke-routes.sh cloud`: passed; all Cloud routes returned non-508
  and non-5xx.

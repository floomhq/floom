# Runbook — worker-bundle offload to Storage (the workers-list speedup)

Moves worker bundle code (`_files`) out of `skill_versions.manifest_json` into the
`worker-bundles` Storage bucket so `GET /workers` stops transferring ~18 MB it never
displays. Behaviour is otherwise identical. See `docs/CLOUD-WORKER-STORAGE-MODEL.md`.

**Golden rule:** a worker whose bundle is offloaded is `worker_not_found` on any
executor that does NOT have the new read-path code. So **every executor on this
Supabase must run the new code before the backfill.** The `WORKEROS_BUNDLE_OFFLOAD`
flag (default OFF) makes the code deploy a no-op until you deliberately cut over.

## Executors that read `sgizlsyygvlqosgwdimb` (all must be on new code first)
- Railway `workeros-cloud-api`  (serves the API)
- Railway `workeros-cloud-worker`  (drains/executes runs)
- AX41 `:8030` dev mirror, if it drains this DB
- Any local backend (e.g. `:8002`) you have pointed at this DB

## Phase 1 — Deploy the code everywhere (safe; no behaviour change)
1. Merge the branch to `main` → Railway auto-deploys api + worker
   (`.github/workflows/railway-deploy.yml`), runs the smoke gate.
2. Update any non-Railway executor (AX41 mirror, local `:8002`) to the same commit and restart.
3. Verify each is up. Flag is OFF, so the list is still slow but everything works exactly as before
   (plus the secrets-page speedup, which is independent).
   - Sanity: `GET /healthz` on each; create + run a throwaway worker — still works.

## Phase 2 — Backfill (the moment the list gets fast)
Only after Phase 1 is confirmed on ALL executors.
```bash
# Dry-run first (read-only): shows rows + MB to move
SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
  python ops/backfill_worker_bundles.py --dry-run
# Apply
SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
  python ops/backfill_worker_bundles.py
```
Idempotent (skips rows already `_files_in_storage`); safe to re-run. The API keeps an
inline-`_files` read fallback, so workers run throughout.

## Phase 3 — Enable offload for new writes
Set on every executor so newly created/edited workers also stay lean:
```
WORKEROS_BUNDLE_OFFLOAD=1
```
(Railway service vars + AX41 + local env.) Without it, new workers re-inline `_files`
(still correct, just re-grows the column until the next backfill).

## Verify
- Payload: `skill_versions?select=manifest_json` REST size drops ~18.5 MB → ~0.3 MB.
- `GET /workers?shape=list` end-to-end drops ~10 s → ~1 s.
- Run a big-bundle worker (novasearch/reltix) twice — fetches bundle from Storage, warm
  path holds (stable `runtime.bundle_sha256`). Open its detail → Source tab still shows files.

## Rollback
- Immediate: set `WORKEROS_BUNDLE_OFFLOAD=0` (stops new offloads). Already-offloaded
  workers still run on new code (read path stays active).
- Full revert of a worker to inline: re-run its normal write path (re-captures `_files`
  from disk), or restore `manifest_json._files` from the bucket's `{skill_version_id}/files.json`.
- If an executor was left on OLD code and a backfilled worker fails `worker_not_found`:
  deploy the new code to it (do NOT roll back the DB).

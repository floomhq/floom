# fn-23 — Embeddings, Fast Apps sidecar, user cleanup

**Scope:** `apps/server/src/services/embeddings.ts`, `apps/server/src/services/fast-apps-sidecar.ts`, `apps/server/src/services/cleanup.ts` (full file read). **Call sites reviewed:** `apps/server/src/index.ts` (`boot()`), `apps/server/src/lib/better-auth.ts` (`afterDelete`), `apps/server/src/db.ts` (`workspace_members` FKs). **Lens:** `docs/PRODUCT.md` (ICP, three surfaces unchanged by these modules; hub/MCP discovery quality and operator simplicity). **Code changes:** none (audit only).

---

## Summary

| Area | Embeddings (`embeddings.ts`) | Fast Apps sidecar (`fast-apps-sidecar.ts`) | Cleanup (`cleanup.ts`) |
|------|------------------------------|---------------------------------------------|-------------------------|
| **Startup cost** | When `OPENAI_API_KEY` is set, `backfillAppEmbeddings()` runs after seed; one OpenAI request per app missing a row in `embeddings`, strictly sequential (`await` in a loop). `pickApps()` loads every stored vector from SQLite on each call and recomputes cosine similarity in-process. | Forks `examples/fast-apps/server.mjs`, polls `/health` for up to ~5s (100ms intervals, 500ms fetch timeout per attempt), writes a temp `apps.yaml`, then runs `ingestOpenApiApps` (network fetches per app spec — see OpenAPI ingest module). Registers shutdown hooks each boot. | None at process startup; runs only on Better Auth `afterDelete`. |
| **API keys** | `OPENAI_API_KEY` optional; unset → no DB writes in `upsertAppEmbedding`, `backfillAppEmbeddings` logs and returns, `pickApps` uses keyword fallback. `EMBED_MODEL` defaults to `text-embedding-3-small`. | No dedicated API key; inherits `process.env` for the child. OpenAI not involved. | No external APIs. |
| **Failure modes (sidecar)** | N/A | Script missing → skip ingest, no child. Health timeout → logs, returns `started: false` **but child process is left running** and `sidecarProcess` remains set → later `startFastApps` treats as `already_running`; no automatic kill/retry. Ingest throws → sidecar kept up, `ingested`/`failed` zeros with `reason` message. Child `exit` clears `sidecarProcess` and logs. | N/A |
| **Cleanup / data loss** | `upsertAppEmbedding` failures are logged only; stale or missing vectors possible. | Ingest mutates `apps` via shared pipeline; featured flags updated in a transaction after ingest. | Single `db.transaction`; `workspace_members.user_id` is `ON DELETE CASCADE` from `users`, so deleting the mirrored user removes membership rows before workspace emptiness checks use fresh counts. **Risk:** user-global deletes treat `visibility IS NULL` like non-public (`(visibility != 'public' OR visibility IS NULL)`), while workspace branch uses `visibility != 'public'` only for some deletes — inconsistent treatment of `NULL` visibility across paths. |
| **Concurrency** | No mutex; concurrent `pickApps` can issue parallel OpenAI embedding calls for the same query and duplicate SQLite reads. `backfillAppEmbeddings` only safe if single boot invocation (guaranteed by current `boot()`). | Module-level `sidecarProcess`; second `startFastApps` is a no-op (`already_running`). Unhealthy first boot leaves a running child and blocks logical retry without `stopFastApps` or process restart. | SQLite transaction serializes cleanup per invocation; overlapping `cleanupUserOrphans` for the same user after delete is unlikely; second call is mostly harmless (user/memberships already gone). Hub cache invalidated after commit via `invalidateHubCache()`. |

---

## Findings

### 1 — Fast Apps: unhealthy sidecar still running and `started: false`

- **Severity:** Medium (operability / resource leak)  
- **Evidence:** `apps/server/src/services/fast-apps-sidecar.ts:278–322` (`sidecarProcess = child` before health check; on `!healthy`, returns without `kill`; `started: false`).  
- **Issue:** A crashed, port-conflicted, or slow sidecar can leave a Node child bound to `FAST_APPS_PORT` while the server reports startup as if the sidecar did not start; a subsequent `startFastApps` short-circuits on `already_running`, so ingest never runs without manual intervention.  
- **Recommended fixes:** On failed health probe, `kill` the child, clear `sidecarProcess`, and optionally support bounded retries; align `FastAppsBootResult.started` with “process exited or never forked” vs “listening and healthy”.

### 2 — Embeddings backfill: sequential OpenAI cost at boot

- **Severity:** Low (cost / tail latency)  
- **Evidence:** `apps/server/src/services/embeddings.ts:91–95` (`for ... await upsertAppEmbedding`).  
- **Issue:** Many new apps imply many sequential HTTP calls to `api.openai.com` before the process is “warm”; spikes billable tokens and extends the window where `pickApps` cosine path sees zero vectors for new rows until each finishes.  
- **Recommended fixes:** Batch inputs if the API contract allows, cap concurrency with a small pool, or defer backfill to a lazy path on first hub index.

### 3 — `pickApps`: full-table embedding read every request

- **Severity:** Low (scale / CPU)  
- **Evidence:** `apps/server/src/services/embeddings.ts:137–139` (`SELECT app_id, vector FROM embeddings` with no `WHERE`).  
- **Issue:** Hub-scale growth turns every semantic search into O(apps) buffer reads and float work in-process, plus one OpenAI call per query when the key is set.  
- **Recommended fixes:** Restrict query to candidate `app_id`s, add an ANN index/store, or cache query embeddings briefly if duplicate queries matter.

### 4 — Cleanup: `visibility NULL` semantics differ between user path and workspace path

- **Severity:** Medium (data-loss risk for legacy rows)  
- **Evidence:** `apps/server/src/services/cleanup.ts:31–37` and `42–45` (`(visibility != 'public' OR visibility IS NULL)` for user-authored deletes); `apps/server/src/services/cleanup.ts:78–92` (`visibility != 'public'` only for workspace-scoped deletes).  
- **Issue:** On account deletion, apps authored by the user with `visibility` NULL are deleted with secrets stripped in step 2a. In the “last member leaves workspace” branch, NULL may not match `visibility != 'public'` in SQL, so behavior diverges from the user-global path and from OpenAPI ingest docs that imply default public.  
- **Recommended fixes:** Normalize `NULL` to `'public'` at ingest, or use identical predicates in both branches; add a migration to backfill visibility.

### 5 — Cleanup: Better Auth already deleted user when Floom cleanup runs

- **Severity:** Low (documented tradeoff)  
- **Evidence:** `apps/server/src/lib/better-auth.ts:252–267` (comment: afterDelete post-commit; try/catch logs).  
- **Issue:** If `cleanupUserOrphans` throws, Better Auth state is already final; Floom may retain orphans until manual repair. Matches comment that cleanup should be idempotent / re-runnable for operators who can script a second pass.  
- **Recommended fixes:** Expose a guarded admin/maintenance entry point to re-run cleanup by `user_id` if audit logs show failures.

### 6 — Fast Apps: temp `apps.yaml` directories accumulate

- **Severity:** Low (disk on long-lived hosts)  
- **Evidence:** `apps/server/src/services/fast-apps-sidecar.ts:196–198` (`mkdtempSync`); comment says OS cleans on reboot.  
- **Issue:** Frequent restarts without reboot fill temp with `floom-fast-apps-yaml-*` dirs.  
- **Recommended fixes:** Reuse a single path under `FLOOM_DATA_DIR`, or `rmSync` after successful ingest.

### 7 — Embeddings: silent partial hub after OpenAI errors

- **Severity:** Low (product consistency)  
- **Evidence:** `apps/server/src/services/embeddings.ts:68–70` (`upsertAppEmbedding` catch logs only); `146–148` (`pickApps` falls back to keyword on vector failure).  
- **Issue:** MCP/hub “semantic” ranking degrades without surfacing to the operator beyond logs. Aligns with `docs/PRODUCT.md` ICP only if defaults remain acceptable.  
- **Recommended fixes:** Metrics counter for fallback; optional strict mode that surfaces degraded mode in `/api/health`.

---

## Evidence index (this file)

| Topic | Location |
|--------|----------|
| Embeddings env and model | `apps/server/src/services/embeddings.ts:7–8` |
| Backfill loop / OpenAI | `apps/server/src/services/embeddings.ts:32–50`, `77–96` |
| `pickApps` vector + fallback | `apps/server/src/services/embeddings.ts:112–165` |
| Sidecar fork / health / ingest | `apps/server/src/services/fast-apps-sidecar.ts:258–367` |
| Shutdown kill | `apps/server/src/services/fast-apps-sidecar.ts:302–310`, `373–377` |
| Cleanup transaction + visibility predicates | `apps/server/src/services/cleanup.ts:19–113` |
| FK cascade `workspace_members` → `users` | `apps/server/src/db.ts:294–300` |
| Boot wiring (non-blocking) | `apps/server/src/index.ts:957–983` |
| Auth hook | `apps/server/src/lib/better-auth.ts:257–267` |

---

## `docs/PRODUCT.md` alignment

- These services support **discoverability** (semantic app picker vs keyword), **default utility apps** on the hub (fast-apps ingest aligns with “paste repo / hosted utilities” operator story), and **account lifecycle** in cloud mode without leaving orphaned private assets on disk.
- None of the three files are listed in the **load-bearing paths** table as standalone entries; they sit adjacent to hub quality, demo defaults, and auth-adjacent data integrity. Treat changes to cleanup predicates and visibility semantics as **hub trust** issues for the same ICP who should not need to manually repair SQLite.

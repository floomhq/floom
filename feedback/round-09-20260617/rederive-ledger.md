# Round-09 re-derive — RESOLUTION LEDGER

Controlled merge of `origin/fix/overlay-r9` onto `origin/main` for both repos.
Per `codex-rederive-verdict.md`. Worktrees only, no deploy.

- Engine base main: `a71880a9b05da60ba6cdc9cfecfe4fd7e68db3b9`
- Engine R9 tip merged: `093b6af97684c57dbb9400ff90ab50ef29ce5324` (`origin/fix/overlay-r9`)
- Engine release branch: `release/round-09-20260618`

---

## ENGINE — conflicted files & resolutions

### 1. `apps/api/routers/workspace.py` (content conflict)
- **main had:** two helpers `_workspace_md_git_rel()` + `_workspace_git_versioning_disabled()` (used at lines 941/1027/1049 for engine-source-checkout git gating).
- **R9 had:** a block of GitHub-export helpers (`WorkspaceGitHubExportRequest/Response`, `_active_workspace_git_key`, `_workspace_owner_user_id`, `_read_owner_secret`, `_as_mapping`, `_secret_reference`, `_pat_from_github_connections`, `_resolve_owner_github_pat`, `_repo_html_url`, `_default_export_repo_name`) used by the GitHub-export route (lines 411/423/464/473/484).
- **Resolution: KEEP BOTH** (non-overlapping additions, concatenated main's helpers then R9's). Verified both sets are referenced downstream; neither is dead.

### 2. `apps/web/app/approvals/ApprovalsCollection.tsx` (content conflict)
- **main had:** `reportError(...)` on the `api.workers.list()` catch (better error surface).
- **R9 had:** a 10s safety timeout + cleanup `return () => clearTimeout(timeout)` (avoids stuck skeleton).
- **Resolution: KEEP BOTH** — main's `reportError` on the catch AND R9's safety timeout + cleanup.

### 3. `apps/web/app/runs/RunsCollection.tsx` (2 conflicts)
- **Import conflict:** main added `reportError, logError` from `@/lib/notify`; R9 added `ShareModal` + `useRuns`. **KEEP BOTH imports.**
- **useEffect conflict:** main kept `void loadInitial()` + `reportError` on workers.list; R9 removed `loadInitial` entirely and loads the first page via the cache-first `useRuns`/`runsQuery` query.
  - **Resolution: take R9's structure (cache-first query; no `loadInitial`) + keep main's `reportError` on the workers.list catch.**
  - **INTENTIONAL DROP (not a lost fix):** main's `void loadInitial()` call. `loadInitial` no longer exists in the merged file (R9 replaced its `useCallback` definition with `useRuns`). Keeping the call would reference an undefined symbol = build break. The first-page load it performed is fully superseded by `runsQuery.data` (R9's feature replaces main's now-removed code path; the data still loads). Verified: `grep loadInitial` → 0 refs after resolution.

### 4. `apps/web/app/settings/page.tsx` (content conflict)
- **main had:** `spend_cap_usd` spend-cap row + a NEW `worker_call_fanout_limit` row.
- **R9 had:** corrected spend-cap key `monthly_spend_cap_usd` (B1 trust fix — `run_cost.py` + the workspace-settings allow-list only accept this key; the old `spend_cap_usd` 422'd on save and was a silent no-op).
- **Resolution: take R9's corrected `monthly_spend_cap_usd`, DROP the wrong `spend_cap_usd` key, KEEP main's `worker_call_fanout_limit` row.** Verified backend allow-list (`routers/workspace.py:1349/1356`) accepts BOTH `monthly_spend_cap_usd` and `worker_call_fanout_limit`; a DOM test asserts `spend_cap_usd` must NOT be sent. So dropping `spend_cap_usd` is the correct fix, not a lost main feature.

### 5. `apps/web/app/workers/WorkersCollection.tsx` (3 conflicts)
- **Import conflict:** main added `reportError, logError`; R9 added `useWorkers`. **KEEP BOTH imports.**
- **`useWorkerDetail` conflict:** main = single `api.workers.get()` with `logError` on fail; R9 = retry-once + 25s safety-timeout structure (the cleanup `clearTimeout(timeout)` references R9's `timeout`).
  - **Resolution: take R9's retry/timeout structure + fold main's `logError("Could not load worker details.", err)` into R9's final-failure branch** (R9 silently set null; now it logs first).
- **Account-role useEffect conflict:** main = `logError` on the me() catch + imperative `api.workers.list({include_archived:true})` with `setLoading(false)`; R9 = `useWorkers`/`workersQuery` drives the list, `loading` is a derived const (no `setLoading` setter).
  - **Resolution: take R9's cache-first structure + keep main's `logError` on the me() role-lookup catch.**
  - **INTENTIONAL DROP (not a lost fix):** main's imperative `api.workers.list({include_archived:true})...finally(setLoading(false))` block. `setLoading` no longer exists (R9 replaced `[loading,setLoading]` state with `const loading = workersQuery.isLoading && ...`). Keeping it = undefined `setLoading` = build break. The workers list still loads — via the cache-first `workersQuery`. R9's feature replaces main's now-removed loader; no fix lost.

### 6. `apps/web/components/sharing/ShareModal.tsx` (2 conflicts)
- **Import conflict:** main added `reportError` + `Alert/AlertDescription/AlertTitle` + type `AssetVisibility`; R9 added types `AssetVisibility, ShareGrant`. **KEEP BOTH** — merged the type import (`AssetVisibility, ShareGrant`), kept main's `reportError` + Alert imports.
- **`listGrants` useEffect conflict:** main = `reportError` on catch; R9 = swallow. Same `api.share.listGrants(...)` call. **Resolution: KEEP main's `reportError`** (identical call, better error surface).

---

## ENGINE — KEEP rules from the verdict (verified in final files)

- **Upload cap = main's 50MB.** `apps/api/core/config.py:55` = `DEFAULT_CONTEXT_UPLOAD_LIMIT_BYTES = 50 * 1024 * 1024`. (Auto-merged to main's value; R9's 25MB NOT taken.) VERIFIED.
- **R9's `_normalized_request_path()` mount-prefix fix kept** (`main.py:1261`) AND **extended** to the two matchers Codex flagged:
  - `rate_limit_middleware` now uses `_normalized_request_path(request)` (was raw `request.url.path`).
  - `auth_middleware` (run-token + `_RE_RUN_LLM_PROXY` block + `path.split("/",3)[2]` run_id extraction) now uses `_normalized_request_path(request)`.
  - Proven by `tests/test_b10_mounted_api_run_token_proxy.py` (new): app mounted under `/api`, `/api/runs/{id}/llm` + `/api/runs/{id}/embeddings` resolve 200; run token on `/api/workers` still 403; standalone path still works. 4/4 pass.
- **main's context mount `when` support kept** (`apps/api/contexts.py` lines ~733-801). VERIFIED present (R9 did NOT delete it in the merged result).
- **main's `_workspace_root()` fallback to `FLOOM_WORKERS_DIR` kept** (`apps/api/chat_service.py:152-154`). VERIFIED.
- **R9's chat fast-path kept** (`apps/api/chat_service.py`: direct `_llm.agent_model(_default_chat_model())` Emily path at ~2285, plus R9's COO persona + split-brain resolver-parity). Merged chat_service = R9 + main's workspace_root fallback + WorkerMemoryConfig. VERIFIED.

---

## ENGINE — gate results

- New mounted-API run-token proxy tests (`test_b10_mounted_api_run_token_proxy.py`): **4 passed.**
- `test_request_body_size_middleware.py` + `test_managed_llm_proxy.py`: **10 passed.**
- `pytest -k "upload or body or approval or split or chat or context"`: **419 passed, 6 failed, 1671 deselected.**
  - The 6 failures are ALL in `tests/test_615_brain_git_clone_paths.py` and are **PRE-EXISTING on clean `origin/main`**, NOT caused by this merge.
  - Root cause: `_upload_contexts_to_sandbox()` requires a keyword-only `inputs` arg (a main-side change) but `test_615` calls it without `inputs=`. The signature in the merged file is byte-identical to `origin/main`; my merge did not touch `e2b_driver.py` or `test_615`. Confirmed `origin/main`'s own copy of the test omits `inputs=` at lines 73/99.
  - NOT fixed here — it is a stale main test, orthogonal to the R9 re-derive. Flagged for a separate fix.
- `apps/web` build: see report (Turbopack worktree caveat noted there).

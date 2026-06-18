# Reconcile Ledger — round-09 RELEASE onto NEW main (engine)

Direction: `git merge --no-commit --no-ff origin/main` INTO
`release/round-09-20260618` so the release ⊇ main. Both R9 work and the new-main
backend-owner fixes are preserved. NO merge to main was performed; only the
reconcile branch `reconcile/round-09-onto-main` is pushed.

- Release tip (HEAD): `f5db7ad5` (R9 + timeout fix + stale-test fixes)
- New main tip (merged in): `272a4093`
- New-main commits preserved (all 4 verified present in merged tree):
  - `1196dcf0` fix api security regressions
  - `0a65db45` perf: cache hot backend read paths
  - `25d63c86` fix shared worker mutation gates
  - `272a4093` fix E2B resource defaults and manifest alias

## Conflicted files (2)

### 1. `apps/api/core/hot_cache.py`
- **What new-main had:** `_CACHE_TTL_SECONDS = 10.0` (set by the named perf
  commit `0a65db45`; base was `2.0`).
- **What release (R9) had:** `_CACHE_TTL_SECONDS = 30.0` (R9 perf commit
  `b78e386b` independently tuned the same scalar up).
- **Resolution:** Kept **`10.0`** — the value from the explicitly-named perf
  commit `0a65db45` (the one the reconcile brief requires preserving). This is a
  single scalar TTL; both sides intend "cache hot reads", so caching behavior is
  preserved regardless. Only the owner's deliberate named-commit value is taken.
- **Dropped:** R9's `30.0` scalar value (NOT R9 behavior — caching still on; just
  the TTL magnitude differs and the owner's named perf-commit value wins).

### 2. `apps/api/routers/connections.py`
This is the load-bearing conflict: **R9 and new-main both added independent
caching to the SAME `list_connections` endpoint**, with two different cache
backends.

- **What new-main (`0a65db45`) had:** a per-router local cache dict
  `_connection_list_cache` with helpers `_connection_list_cache_get/set/clear`
  (own lock + 10s TTL), reads/writes on `list_connections`, and
  `_connection_list_cache_clear(...)` invalidation calls at every mutation
  endpoint (initiate, create_mcp, callback, dedupe, delete).
- **What release (R9) had:** a cache on the same endpoint using the shared
  `core.hot_cache` module with key `("connections", user_id)`, an
  `_invalidate_connections_cache()` helper (calling `hot_cache.delete(...)`), and
  a raw `hot_cache.delete(...)` in the OAuth callback.
- **Why semantic conflict:** two parallel caches for the same data = split-brain.
  A mutation that cleared only one store would leave a stale entry in the other,
  serving stale connection lists. They cannot both independently back the reads.
- **Resolution (keep BOTH intents, one coherent cache):**
  1. The **live cache backing reads/writes** on `list_connections` is new-main's
     `_connection_list_cache_*` system (the named perf commit `0a65db45`). Both
     conflicted read (top of `list_connections`) and write (end of
     `list_connections`) hunks resolved to new-main's helpers.
  2. **R9's invalidation intent is preserved** by making R9's
     `_invalidate_connections_cache()` helper clear **BOTH** stores
     (`_connection_list_cache_clear(user_id)` **and**
     `hot_cache.delete(("connections", user_id))`). So every R9 call site that
     invalidated via the shared hot_cache now also clears the live cache, and any
     residual `hot_cache` usage is still honored. (Comment added in code.)
  3. The two conflicted invalidation hunks (`create_mcp_connection`,
     `delete_connection`) resolved to `_invalidate_connections_cache()` (now
     dual-clearing). The raw `hot_cache.delete(...)` in the OAuth callback was
     routed to `_invalidate_connections_cache(...)` for the same reason.
  4. Removed one redundant duplicate `_connection_list_cache_clear()` immediately
     adjacent to an `_invalidate_connections_cache()` at the initiate site (the
     latter now covers both stores). Pure dedup, no behavior change.
  5. New-main's own `_connection_list_cache_clear(...)` calls (callback pre-dedup,
     dedupe helper) were left intact — they correctly clear the live cache.
- **Dropped:** NOTHING functional. Both R9's "cache list + invalidate on every
  mutation" behavior and new-main's identical-but-more-complete implementation
  are present; they are unified onto a single coherent cache so invalidation is
  not split-brained. The only removed lines are duplicate/no-op invalidation
  calls.
- **Security note:** the security commit `1196dcf0` ALSO touched
  `connections.py`, but those hunks auto-merged cleanly (different regions — auth
  on connection rows). They are present in the merged tree; no security fix was
  lost.

## Auto-merged files touched by both sides (no manual resolution needed)

`chat_service.py`, `contexts.py`, `db/sqlite.py`, `main.py`, `models.py`,
`services/worker_mutation.py`, `routers/auth.py`, `auth/local.py`,
`auth/local_workspaces.py`, `auth/multi_member.py`, `routers/worker_versions.py`,
`routers/worker_lifecycle.py`, `runner_sandbox/e2b_driver.py`,
`routers/integrations.py`, `ops/e2b/node-base/template.py`, plus docs and ~15
test files — all auto-merged. Spot-verified that the new-main additions
(`include_workspace_context`, `_worker_for_mutation`, E2B `resources` alias +
`memory_mb=2048`, integrations catalog/tools cache) AND R9-only content
(`pin_safe_outbound_url` SSRF helper, `stage` maturity labels, cron-timezone
reconciliation, `input_values`) all coexist in the merged tree.

## Round-09 KEEP rules re-confirmed post-merge

- 50MB upload cap: present (`contexts.py:26`, `core/config.py:55/64`,
  `services/context_access.py:731`, `routers/worker_create.py:133`).
- `_normalized_request_path` + run-token normalization: present (`main.py:1261`
  and four call sites).
- contexts `when`: present (`contexts.py:749-785`).
- `_workspace_root` FLOOM_WORKERS_DIR fallback: present (`chat_service.py:148-196`,
  `worker_registry.py:19`).
- chat fast-path: present (chat_service path intact; no conflict touched it).

The security fix did not regress any of these KEEP areas; where it touched the
same files (chat_service.py, contexts.py, main.py) the changes are in distinct
regions and both intents are kept.

## Unresolved / dropped

None. Every conflict resolved keeping both the new-main fix and R9's change.

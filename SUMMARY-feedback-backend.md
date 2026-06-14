# Backend Feedback Summary

Date: 2026-06-14
Branch: `feat/backend-feedback`

## Commits

- `4f66ca11 Fix scoped writable context writeback`
- `5f787e7f Add candidate feedback event recording`

## Issue #1020: Scoped Writable Context Writeback

Approach chosen: backward-compatible opt-in include paths.

- Existing writable context mounts with no `writeback_paths` keep the legacy whole-directory writeback behavior.
- New mounts can declare `writeback_paths`, for example:
  `contexts: [{name: novasearch-data, writeable: true, writeback_paths: ["feedback-memory.json"]}]`
- When paths are declared, only those relative files or folders are merged back from the staged run context. Other host-side files are left untouched, so feedback written after run start survives stale worker snapshot writeback.
- An explicit empty list writes back no paths.

Files changed:

- `apps/api/models.py`
  - Added optional `WorkerContextMount.writeback_paths`.
  - Validates entries as relative file/folder paths and de-duplicates them.
- `apps/api/contexts.py`
  - `normalize_context_mount` now preserves `writeback_paths`.
  - Added shared `merge_context_tree(source_dir, target_dir, writeback_paths)` used by both runners.
  - Kept whole-pack replacement for `writeback_paths is None`.
- `apps/api/runner_sandbox/e2b_driver.py`
  - `_extract_context_tar` accepts optional `writeback_paths`.
  - E2B writable context persistence passes the mount-scoped include paths into the merge helper.
- `apps/api/runner_sandbox/agent_driver.py`
  - Agent-mode writable context persistence now uses the same merge helper and include-path semantics.
- `tests/test_e2b_artifact_collection.py`
  - Added regression proving an externally added `feedback/raw/...` file is not erased when a path-scoped worker writes back only `feedback-memory.json`.

## Issue #1019: Candidate Feedback Event Recording

Added `record_candidate_feedback` as a brain-native immutable event primitive.

- REST endpoint: `POST /contexts/{name}/record-candidate-feedback`
- MCP tool: `record_candidate_feedback`
- Requires the target context pack to be marked `writeable`.
- Writes one new JSON file per event under:
  `feedback/raw/<YYYY-MM-DD>/<uuid>.json`
- Event content:
  `{uuid, run_id, candidate_id, rank, feedback_text, outcome, scope, reporter, ts}`
- The server generates `uuid`, `ts`, and the file path.
- The implementation writes through the existing context file-write helper (`_write_context_file`), not a read-modify-write append path.

Files changed:

- `apps/api/main.py`
  - Added request/response models for candidate feedback records.
  - Added REST endpoint and helper.
  - Exposed the same capability on both MCP surfaces.
- `apps/api/contexts.py`
  - Made context metadata temp writes unique per thread and protected by a process lock. The concurrent feedback test exposed the old shared `.workeros-contexts.tmp` path as a race.
- `apps/api/tests/test_candidate_feedback_recording.py`
  - Added concurrent REST test proving two calls produce two distinct event files.
  - Added MCP test proving the MCP tool writes a feedback event file.

## Verification

- Focused #1020 regression:
  `/tmp/workeros-api-py311/bin/python -m pytest tests/test_e2b_artifact_collection.py -q`
  - Result: `23 passed`
- Focused #1019 + MCP regression:
  `/tmp/workeros-api-py311/bin/python -m pytest apps/api/tests/test_candidate_feedback_recording.py apps/api/tests/test_langdock_workspace_agent_mcp.py tests/test_e2b_artifact_collection.py -q`
  - Result: `42 passed`
- Full API suite:
  `cd apps/api && /tmp/workeros-api-py311/bin/python -m pytest -q`
  - Result: `1701 passed, 3 skipped, 938 warnings in 746.22s (0:12:26)`

## Follow-up Flags

- `gh issue view 1020 --repo floomhq/workeros` and `gh issue view 1019 --repo floomhq/workeros` failed in this environment with: `GraphQL: Could not resolve to a Repository with the name 'floomhq/workeros'.` The prompt text was used as the issue source of record.
- The current implementation intentionally leaves legacy whole-pack writeback unchanged unless `writeback_paths` is declared.
- `save_context_metadata` is now safe from same-process temp-file collisions. Cross-process lost-update semantics are unchanged.

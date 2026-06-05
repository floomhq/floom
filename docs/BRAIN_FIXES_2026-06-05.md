# Brain Fixes - 2026-06-05

## M85a - Brain attach HTTP 500 on Cloud

Status: fixed in engine and Cloud source, public Railway deploy pending.

Root cause found:
- The shared engine upload endpoint required the pack directory to exist before accepting files. Drag/drop into an empty Brain had no backend create path, so the first-file flow could not be one atomic operation.
- Cloud also did not register the engine `asset_access` repository for Brain packs. Newer engine code probes `repos.asset_access` for Brain visibility and permissions, but Cloud startup omitted that repository and Supabase had no `brain_packs` or `assistants` mirror tables.
- Direct live API upload to an existing pack returned 200 before the patch. Upload with `create_if_missing=true` returned 200 against the patched AX41 production service on `127.0.0.1:8030`.
- Public `https://workeros-api.floom.dev` is served by Railway, confirmed by `server: railway-hikari` and `x-railway-*` headers. It still returns the pre-patch 404 until the Cloud PR is merged and Railway deploys.
- No traceback was captured for the reported HTTP 500 because direct live API probes did not reproduce a 500. Browser reproduction was blocked by login before the patch could be exercised through the UI.

Fix:
- Added `create_if_missing` to `POST /contexts/{name}/upload`.
- Added Cloud `SupabaseAssetAccessRepository`.
- Added Supabase migration `0029_brain_asset_access.sql` for `brain_packs`, `assistants`, and `brain_files`, including hashed share-token columns for the separate share lane.

Verification:
- `python3 -m pytest apps/api/tests/test_contexts_system_packs.py apps/api/tests/test_brain_assistant_visibility_api.py -q` passed, 19 tests.
- `python3 -m pytest tests/test_brain_asset_access.py -q` passed, 4 tests.
- `python3 -m py_compile` passed for touched Cloud API files.
- Engine web `npm run lint -- app/contexts/page.tsx lib/api.ts` and `npx tsc --noEmit` passed.
- Cloud web targeted ESLint and `npx tsc --noEmit` passed after adding the missing tracked `vitest` dev dependency used by existing tests.
- Patched AX41 service accepted live `create_if_missing` upload on `127.0.0.1:8030`.

## M85b - Brain file download returns Context not found

Status: fixed in Cloud source, public deploy pending.

Root cause found:
- Browser download links are plain `<a href>` requests and cannot attach the `x-workeros-workspace` header that JSON and upload calls send.
- The frontend appended `workspace_id` to the file URL, but the Cloud proxy and auth provider ignored that query parameter and fell back to cookie/default workspace resolution.
- That made list/detail calls resolve in the selected workspace while downloads resolved in a stale/default workspace, producing `{"detail":"Context not found"}` for an existing listed file.

Fix:
- Cloud proxy now promotes `workspace_id` query to `x-workeros-workspace`.
- Cloud auth provider now accepts `workspace_id` query as a workspace selector for direct file URLs.

Verification:
- Static regression test covers proxy query-to-header promotion.
- Static regression test covers auth provider query handling.
- Existing API download with workspace-scoped token returned 200 in live probes.

## M85c - Drag/drop auto-create pack

Status: fixed in UI and backend source, public deploy pending.

Root cause found:
- The Brain UI upload handler returned immediately when `selectedName` was empty.
- The empty-state pane did not register file-drop handlers.
- Backend upload could not create a missing pack, so UI had no atomic first-drop endpoint.

Fix:
- Empty Brain pane accepts file drops.
- First drop derives a duplicate-safe pack name from the first file.
- UI sends `create_if_missing=true`; backend creates the pack and uploads the file in one request.

Verification:
- Backend test verifies upload without the flag still returns 404 and upload with the flag creates the pack and file.
- Frontend lint and TypeScript checks passed in the engine web app.

## M85e - Brain write path

Status: fixed in UI/API source, public deploy pending.

Root cause found:
- Backend write endpoints already existed for upload, text edit, and delete, but the UI did not expose create-from-scratch and first-drop create.
- Cloud Brain visibility/permission rows were missing, so Cloud could not consistently expose write/share permissions from the engine model.

Fix:
- Added "New text file" UI control backed by existing `PUT /contexts/{name}/files/{path}`.
- Kept upload, edit, delete controls for writable packs.
- Replaced visible Brain UI em dashes with hyphens.
- Added Cloud asset-access mirror repository and schema.

Verification:
- Targeted ESLint passed for touched Cloud Brain/proxy files.
- Engine and Cloud web `npx tsc --noEmit` passed in clean worktrees.
- `ops/smoke-routes.sh cloud` passed before the production patch attempt.

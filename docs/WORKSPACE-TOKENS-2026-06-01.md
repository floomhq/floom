# Workspace-Scoped API Tokens — 2026-06-01

Problem verified:
- Cloud PATs were stored by `user_id` only in `public.api_tokens`.
- Switching workspaces showed the same token list.
- A PAT could authenticate API requests for any workspace owned by the same user if the request supplied a different `x-workeros-workspace`.

Fix in this branch:
- Migration `supabase/migrations/0015_workspace_api_tokens.sql` adds `workspace_id` to `public.api_tokens`, backfills legacy rows to the owner's oldest workspace, makes it non-null, adds a workspace index, and replaces the RLS policy with a workspace ownership check.
- `SupabaseApiTokenRepository` now creates, lists, checks, and deletes tokens inside the active workspace.
- PAT auth now binds the request to the token's `workspace_id`. A mismatched `x-workeros-workspace`/cookie returns `403`.
- Settings copy now says "Workspace API tokens" and shows the token's workspace id in the token list.

Verification:

```bash
python3 -m py_compile apps/api/auth/supabase_provider.py apps/api/db/supabase_repos.py
python3 -m pytest tests/test_workspace_api_tokens.py tests/test_workspace_header.py tests/test_supabase_auth_provider.py -q
```

Result: `11 passed`.

Deployment requirement:
- Apply `0015_workspace_api_tokens.sql` to Supabase before deploying the API code that selects/inserts `api_tokens.workspace_id`.

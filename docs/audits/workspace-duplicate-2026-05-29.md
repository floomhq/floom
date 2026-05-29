# Workspace duplicate (Notion-template style) — 2026-05-29

Duplicate / remix a WHOLE WORKSPACE as a single downloadable `.zip` template.
A workspace = the operator's **workers** + **knowledge packs** (contexts) +
the **workspace-agent config** (`workspace.md`). Built by composing primitives
that already existed (`_register_worker_from_files`, the `/workers/from-bundle`
import path, per-worker bundle layout, the contexts create/upload path).

## Endpoints

### `GET /workspace/export`
Returns a single `application/zip` template (Content-Disposition: attachment).

Scope: `auth.user_id`. Includes:
- every NON-EXAMPLE, non-system, non-archived operator **worker** bundle
  (`worker.yml` + `run.py` / `SKILL.md` + `requirements.txt` + `lib/*`),
- every OPERATOR **knowledge pack** (contexts visible to the user) — EXCLUDES
  system packs (`worker-author-style`) and other users' packs,
- the workspace-agent config `workspace.md` (if present),
- a `workspace.json` manifest.

Excluded: example/stock workers (`is_example: true`, `PUBLIC_STOCK_WORKER_IDS`,
`PROTECTED_STOCK_WORKER_IDS`), `system_worker: true`, archived/hidden workers,
system context packs.

**Security — no secret VALUES, ever.** Only the NAMES of required
secrets/connections are written (in the manifest), so the importer knows what
to reconnect. Defense-in-depth: any secret-bearing file
(`.env`, `.env.*`, `*.env`, `.netrc`, `.npmrc`, `*.pem`, `*.key`,
`credentials*`, `secrets.*`, …) in a worker dir OR a knowledge pack is dropped
from the export. Verified by grepping the whole zip for the secret value /
`FLOOM_SECRET` / tokens — zero hits.

Optional query param: `exported_at` (ISO string) overrides the manifest
timestamp; defaults to `datetime.now(timezone.utc)`.

### `POST /workspace/import` (multipart `bundle`)
Unpacks a template and merges it into the caller's workspace.

- Sanitizes every zip member path (rejects absolute paths and `..` traversal →
  HTTP 400; rejects symlink members → HTTP 400).
- Registers each worker via the shared `_register_worker_from_files(...,
  dedupe_id=True)` path — a colliding id is rewritten to a free id (e.g.
  `foo` → `foo-2`), never clobbering an existing worker.
- Creates each knowledge pack via the contexts path; an existing pack is
  SKIPPED (never clobbered).
- Reuses the from-bundle rate limit (`_enforce_draft_rate_limit`) and a bounded
  body cap (`WORKSPACE_IMPORT_BODY_LIMIT_BYTES = 50 MiB`, registered in the
  body-size middleware allowlist).

Returns `WorkspaceImportResponse`:
```json
{
  "workers_imported": ["my-authored-worker"],
  "contexts_imported": ["my-knowledge-pack"],
  "skipped": [{"type": "context", "id": "x", "reason": "already exists"}],
  "id_remaps": {"foo": "foo-2"},
  "required_secrets": ["OPENAI_API_KEY"],
  "required_connections": [],
  "workspace_md_present": true
}
```

`required_secrets` / `required_connections` are read back from the template's
`workspace.json` so the UI can prompt the operator to reconnect. `workspace.md`
is carried in the template and surfaced via `workspace_md_present`, but is NOT
auto-overwritten on import (it is operator-agent config the importer reviews).

## `workspace.json` manifest schema (schema_version 1)
```json
{
  "schema_version": 1,
  "exported_at": "2026-05-29T18:59:00+00:00",
  "workers": [
    {
      "id": "my-authored-worker",
      "name": "My Authored Worker",
      "trigger_type": "manual",
      "required_secrets": ["OPENAI_API_KEY"],
      "required_connections": [],
      "file_count": 4
    }
  ],
  "contexts": [
    { "name": "my-knowledge-pack", "file_count": 2, "writeable": false }
  ],
  "has_workspace_md": true,
  "required_secrets": ["OPENAI_API_KEY"],
  "required_connections": [],
  "counts": { "workers": 1, "contexts": 1 }
}
```

## Frontend
`/settings` → "Workspace agent" tab → new "Duplicate workspace" section:
- **Export this workspace as a template** → downloads the `.zip`
  (one line: bundles your workers + knowledge packs, not secrets — you'll
  reconnect those).
- **Import a workspace template** → file picker → upload → import summary
  (workers + packs imported, items skipped, secrets/connections to reconnect).

`api.workspace.exportTemplate()` / `api.workspace.importTemplate()` in
`apps/web/lib/api.ts`; `WorkspaceImportResult` type in `apps/web/lib/types.ts`.

## Tests
`apps/api/tests/test_workspace_duplicate.py` (5 tests, all green):
1. export excludes example workers + system packs; manifest surfaces required
   secret names,
2. export carries no secret value (drops a planted `.env`),
3. export → import round-trip into a FRESH workspace: worker + pack appear and
   are runnable on disk; re-import dedups (worker remapped, pack skipped, no
   clobber),
4. zip path traversal rejected (HTTP 400),
5. worker member without `worker.yml` is skipped (not a hard failure).

## Live proof (isolated instance, then prod)
Local isolated run (worktree code, temp DB/dirs, port 8099/8100):
- export zip listed only `workers/my-authored-worker/*` + `contexts/my-knowledge-pack/*`
  + `workspace.md` + `workspace.json`; example worker + system pack absent;
  `grep topsecretvalue / FLOOM_SECRET` → 0 hits after the `.env` exclusion fix.
- import into a fresh empty workspace → worker `my-authored-worker` (remapped
  from dir name via manifest), pack `my-knowledge-pack` appeared in `/workers`
  and `/contexts`; re-import → `my-authored-worker-2`, pack skipped
  "already exists"; traversal zip → HTTP 400.

(See report for merged PR # + deploy SHA + /health.)

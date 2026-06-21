# Git Workspace E2E API Test Flows

End-to-end test script for all git workspace features. Run against a live OSS
server started with a dedicated workspace directory (see Setup below).

All requests use `x-floom-secret: dev` (OSS dev auth header).

---

## Setup

```powershell
$ws = "C:\path\to\workeros-workspace-test"
New-Item -ItemType Directory -Force "$ws\workers" | Out-Null
New-Item -ItemType Directory -Force "$ws\contexts" | Out-Null

$env:WORKEROS_WORKSPACE_DIR = $ws
$env:FLOOM_WORKERS_DIR      = "$ws\workers"
$env:FLOOM_CONTEXTS_DIR     = "$ws\contexts"
$env:FLOOM_SECRET           = "dev"

cd workeros/apps/api
python -m uvicorn main:app --port 8000
```

Requires a GitHub PAT (classic, `repo` scope) and a worker on disk.

```powershell
$h   = @{"x-floom-secret"="dev"; "Content-Type"="application/json"}
$pat = "<YOUR_GITHUB_PAT>"
```

---

## Flow 1 — Connect GitHub PAT

```
POST /system/git/connect
{"pat": "<PAT>"}
```

Expected: `{"username": "...", "avatar_url": "...", "name": ...}`

```powershell
Invoke-RestMethod -Uri "http://localhost:8000/system/git/connect" -Headers $h `
  -Method POST -Body (@{pat=$pat} | ConvertTo-Json)
```

---

## Flow 2 — Check Status (disconnected until repo linked)

```
GET /system/git
```

Expected: `{"connected": false, ...}` — PAT stored but no repo linked yet.

```powershell
Invoke-RestMethod -Uri "http://localhost:8000/system/git" -Headers $h
```

---

## Flow 3 — List Floom Repos

```
GET /system/git/repos
```

Expected: array of repos matching `workeros-*` prefix or `workeros-workspace` topic.

```powershell
Invoke-RestMethod -Uri "http://localhost:8000/system/git/repos" -Headers $h
```

---

## Flow 4 — Create GitHub Repo

```
POST /system/git/repos
{"name": "my-workspace"}   # prefix "workeros-" added automatically
```

Expected: `{"full_name": "<user>/workeros-my-workspace", "private": true, ...}`

```powershell
Invoke-RestMethod -Uri "http://localhost:8000/system/git/repos" -Headers $h `
  -Method POST -Body (@{name="my-workspace"} | ConvertTo-Json)
```

---

## Flow 5 — Link Repo (initial push)

```
POST /system/git/link
{"repo_full_name": "<user>/workeros-my-workspace"}
```

Expected: `{"connected": true, "repo_full_name": "...", "last_pushed_at": "..."}`.
Workspace git repo is cloned/initialized and pushed to GitHub.

```powershell
Invoke-RestMethod -Uri "http://localhost:8000/system/git/link" -Headers $h `
  -Method POST -Body (@{repo_full_name="<user>/workeros-my-workspace"} | ConvertTo-Json)
```

---

## Flow 6 — Manual Push

```
POST /system/git/push
```

Expected: `{"connected": true, "last_pushed_at": "<updated timestamp>"}`.

```powershell
Invoke-RestMethod -Uri "http://localhost:8000/system/git/push" -Headers $h -Method POST
```

---

## Flow 7 — Worker File Save → Auto-commit + Push

Every save auto-commits and pushes in the background (~2-4 s).

```
PUT /workers/{worker_id}/files
{
  "files": [
    {"path": "SKILL.md",   "content": "# My Worker\n\nUpdated."},
    {"path": "worker.yml", "content": "<existing yml content>"},
    {"path": "run.py",     "content": "def run(inputs, context):\n    pass\n"}
  ]
}
```

Expected: `WorkerDetail` response. After ~5 s, commit appears on GitHub:
`workers/{worker_id}/SKILL.md`, `workers/{worker_id}/worker.yml`, `workers/{worker_id}/run.py`.

```powershell
$w = Invoke-RestMethod -Uri "http://localhost:8000/workers/my-worker" -Headers $h
$files = $w.files | ForEach-Object {
    if ($_.path -eq "SKILL.md") { @{path="SKILL.md"; content="# Updated`n`nNew content."} }
    else { @{path=$_.path; content=$_.content} }
}
Invoke-RestMethod -Uri "http://localhost:8000/workers/my-worker/files" -Headers $h `
  -Method PUT -Body (@{files=$files} | ConvertTo-Json -Depth 4)
Start-Sleep 5
# Verify on GitHub: GET /repos/{owner}/{repo}/contents/workers/my-worker/SKILL.md
```

---

## Flow 8 — Worker Version List

```
GET /workers/{worker_id}/versions
```

Expected: array of `{sha, message, author, timestamp}`, newest first.
Current version has `(current)` in the UI; all are equal in the API response.

```powershell
Invoke-RestMethod -Uri "http://localhost:8000/workers/my-worker/versions" -Headers $h
```

---

## Flow 9 — Worker Version Preview (read-only)

```
GET /workers/{worker_id}/versions/{sha}
```

Expected: `{"files": [{"path": "SKILL.md", "content": "..."}, ...]}` — exact
file contents at that commit. No side effects.

```powershell
$versions = Invoke-RestMethod -Uri "http://localhost:8000/workers/my-worker/versions" -Headers $h
$sha = $versions[1].sha   # second newest
Invoke-RestMethod -Uri "http://localhost:8000/workers/my-worker/versions/$sha" -Headers $h
```

---

## Flow 10 — Worker Rollback

```
POST /workers/{worker_id}/rollback/{sha}
```

Expected: `204` or updated worker. Creates a new git commit
`rollback: restore {worker_id} to {sha}` on top — history is never rewritten.
After ~5 s the rollback commit appears on GitHub.

```powershell
$versions = Invoke-RestMethod -Uri "http://localhost:8000/workers/my-worker/versions" -Headers $h
$sha = $versions[-1].sha   # oldest version
Invoke-RestMethod -Uri "http://localhost:8000/workers/my-worker/rollback/$sha" -Headers $h -Method POST
```

To **roll forward**: same endpoint, pass a newer SHA. Same mechanism, no special case.

---

## Flow 11 — Worker Visibility → Git Commit

```
PUT /workers/{worker_id}/visibility
{"visibility": "workspace"}   # or "private"
```

Expected: `{"visibility": "workspace"}`. Commits `worker.yml` with `visibility:` field updated.

```powershell
Invoke-RestMethod -Uri "http://localhost:8000/workers/my-worker/visibility" -Headers $h `
  -Method PUT -Body (@{visibility="workspace"} | ConvertTo-Json)
```

---

## Flow 12 — Secrets → .secrets.enc → Commit + Push

```
POST /secrets/{name}
{"value": "<secret value>"}
```

Expected: `201`. After save, `.secrets.enc` (AES-256-GCM encrypted blob) is
committed to the workspace repo. Key is stored as a GitHub Actions Variable
`WORKEROS_SECRETS_KEY` on the linked repo.

```powershell
Invoke-RestMethod -Uri "http://localhost:8000/secrets/MY_API_KEY" -Headers $h `
  -Method POST -Body (@{value="sk-test-12345"} | ConvertTo-Json)
# Verify: GET /repos/{owner}/{repo}/contents/.secrets.enc → size > 0
```

Delete a secret → `.secrets.enc` re-encrypted without that key:

```powershell
Invoke-RestMethod -Uri "http://localhost:8000/secrets/MY_API_KEY" -Headers $h -Method DELETE
```

---

## Flow 13 — MCP Tool Create → workspace-tools.yml

```
POST /mcp-tools
{"name": "my-tool", "worker_id": "my-worker", "description": "Does things"}
```

Expected: `{"id": "...", "name": "my-tool", ...}`.
Commits `workspace-tools.yml` with `tools: update workspace-tools.yml (1 tool)`.

```powershell
$tool = Invoke-RestMethod -Uri "http://localhost:8000/mcp-tools" -Headers $h `
  -Method POST -Body (@{name="my-tool"; worker_id="my-worker"; description="Does things"} | ConvertTo-Json)
# After ~5s: workspace-tools.yml on GitHub contains the tool entry
```

Delete → commits `workspace-tools.yml (0 tools)`:

```powershell
Invoke-RestMethod -Uri "http://localhost:8000/mcp-tools/$($tool.id)" -Headers $h -Method DELETE
```

---

## Flow 14 — Context (Brain) File Write → Commit + Push

```
PUT /contexts/{name}/files/{file_path}
{"content": "# My Brain\n\nContext content here."}
```

Expected: `200`. Commits `contexts/{name}/{file_path}` to git.

```powershell
Invoke-RestMethod -Uri "http://localhost:8000/contexts/my-brain/files/intro.md" -Headers $h `
  -Method PUT -Body (@{content="# My Brain`n`nContent here."} | ConvertTo-Json)
```

---

## Flow 15 — Context Rollback

```
GET  /contexts/{name}/versions              → list versions
GET  /contexts/{name}/versions/{sha}        → preview at sha
POST /contexts/{name}/rollback/{sha}        → restore to sha
```

```powershell
$versions = Invoke-RestMethod -Uri "http://localhost:8000/contexts/my-brain/versions" -Headers $h
$sha = $versions[-1].sha
Invoke-RestMethod -Uri "http://localhost:8000/contexts/my-brain/rollback/$sha" -Headers $h -Method POST
```

---

## Flow 16 — Workspace Instructions (workspace.md) → Commit + Push

```
GET /workspace          → read current content
PUT /workspace          → update; commits workspace.md to git
{"content": "# Workspace\n\nInstructions here."}
```

```powershell
Invoke-RestMethod -Uri "http://localhost:8000/workspace" -Headers $h `
  -Method PUT -Body (@{content="# My Workspace`n`nInstructions."} | ConvertTo-Json)
```

Versions and rollback:

```
GET  /workspace/versions
GET  /workspace/versions/{sha}
POST /workspace/rollback/{sha}
```

```powershell
$versions = Invoke-RestMethod -Uri "http://localhost:8000/workspace/versions" -Headers $h
$sha = $versions[-1].sha
Invoke-RestMethod -Uri "http://localhost:8000/workspace/rollback/$sha" -Headers $h -Method POST
```

---

## Flow 17 — Import from GitHub (restore / new install)

```
POST /system/git/import
```

Clones the linked repo into a temp dir, parses all `workers/` and `contexts/`
directories, upserts each into the DB, then deletes the temp clone.
Safe on existing installs (updates, not duplicates).

Expected: `{"imported": {"workers": N, "contexts": M, "secrets": K, "tools": L}}`

```powershell
Invoke-RestMethod -Uri "http://localhost:8000/system/git/import" -Headers $h -Method POST
```

---

## Flow 18 — Disconnect

```
DELETE /system/git
```

Expected: `204`. Config cleared, git remote detached. Subsequent `GET /system/git`
returns `{"connected": false}`.

```powershell
Invoke-RestMethod -Uri "http://localhost:8000/system/git" -Headers $h -Method DELETE
```

---

## Notes

- Background pushes are fire-and-forget (~2–5 s). Wait before verifying on GitHub.
- Rollback creates a **new commit** on top — history is never rewritten.
- Roll forward = rollback to a newer SHA. Same endpoint, same behavior.
- `.secrets.enc` is AES-256-GCM encrypted. The plaintext never leaves the server.
- In cloud, secrets live in Supabase only — `.secrets.enc` is not pushed.
- `WORKEROS_WORKSPACE_DIR` must be outside the source code tree to avoid
  the source repo's `.gitignore` blocking `contexts/` and `workspace.md`.

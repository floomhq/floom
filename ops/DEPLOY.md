# Workeros Backend Deploy Runbook

## How to deploy the backend

```bash
cd /root/workeros
./ops/deploy-api.sh
```

That is the complete command. It handles everything: DB backup, source sync, dependency install into the service venv, service restart, health gate, schema check.

For unattended deploys, install `ops/autodeploy-api.sh` through the matching
`workeros-api-autodeploy.service` or `managed-deployment-api-autodeploy.service`.
The autodeploy wrapper is intentionally stricter than this manual command: it
fetches `origin/main`, refuses dirty or locally-ahead deploy checkouts, resets a
clean mirror to the remote SHA, and can notify `WORKEROS_AUTODEPLOY_ALERT_WEBHOOK`
on failure. This prevents server-side hotfix drift from wedging `git pull` and
silently leaving production behind.

### Dry-run first (recommended on first use)

```bash
./ops/deploy-api.sh --dry-run
```

Prints every step with "DRY-RUN: would…" — no changes made.

### Flags

| Flag | Effect |
|------|--------|
| `--dry-run` | Show actions without executing |
| `--skip-drain` | Deploy even if runs are currently active (risk: mid-flight run may fail) |

---

## What the script does (in order)

1. Pre-flight: verifies root, sqlite3, systemctl, git, python3 are available.
2. **Backs up DB** to `/root/backups/manual/floom-predeploy-<unix-ts>.db` using `sqlite3 .backup` (safe while API is running; uses SQLite online backup API).
3. `git fetch origin main` and logs the target SHA.
4. Checks for active runs (`status IN ('running','queued')`). If found, waits up to 80 s for them to drain. Aborts if drain times out (use `--skip-drain` to override).
5. `git checkout origin/main -- apps/api apps/mcp workers docs` — syncs only tracked source files. Does NOT touch `data/`, `.env`, `workspace.md`, `contexts/`, or any other runtime state.
6. Removes `*.rej` and `*.bak` patch-failed cruft under `apps/`.
7. Installs `$WORKEROS_ROOT/apps/api/requirements.txt` into the actual service venv at `$WORKEROS_ROOT/apps/api/venv` using `$WORKEROS_ROOT/apps/api/venv/bin/python -m pip install -r ...`, then runs `pip check`.
8. `systemctl restart workeros-api`.
9. Polls `/health` every 2 s until `status=ok` or 90 s timeout. Fails loudly on timeout.
10. Asserts HTTP 200 on: `/healthz`, `/health`, `/workspace`, `/conversations`, `/approvals`, `/workers`.
11. Runs `ops/verify-schema.py` — fails deploy if any expected table is missing.
12. Prints `DEPLOY SUCCESS` with deployed SHA, service venv, requirements path, and migration version.

### API dependency install path

The production service runs from `/root/workeros/apps/api/venv`. The deploy script installs the tracked deployed requirements file `/root/workeros/apps/api/requirements.txt` into that venv before restart, so dependency changes take effect without a manual pip install. Operators can override the paths for a different host with:

```bash
WORKEROS_API_VENV=/path/to/apps/api/venv \
WORKEROS_API_REQUIREMENTS=/path/to/apps/api/requirements.txt \
./ops/deploy-api.sh
```

---

## How to roll back

### Roll back the DB

```bash
# Find the pre-deploy snapshot
ls /root/backups/manual/

# Restore (API must be stopped first)
systemctl stop workeros-api
sqlite3 /root/workeros/data/floom.db ".restore '/root/backups/manual/floom-predeploy-<ts>.db'"
systemctl start workeros-api
```

### Roll back the code

```bash
cd /root/workeros
git checkout <previous-sha> -- apps/api apps/mcp workers docs
systemctl restart workeros-api
```

Find the previous SHA with `git log --oneline`.

---

## Schema drift check

Run manually at any time:

```bash
python3 /root/workeros/ops/verify-schema.py
# or with an explicit DB path:
python3 /root/workeros/ops/verify-schema.py /root/workeros/data/floom.db
```

Exit 0 = all expected tables present. Exit 1 = drift detected (lists missing tables).

### What it checks

Parses every `CREATE TABLE` statement from `apps/api/db/_legacy_sqlite.py` and compares against the live DB's `sqlite_master`. Reports any table expected by the migration source but absent from the DB.

Intentionally-absent tables (dropped by design) are excluded: `worker_state`, `runs_new`, `approvals_new`, `composio_connections_new`, `secrets_new`, `workers_legacy`, `approvals_preserve`.

---

## Migration version desync — root cause and fix (C4)

### What happened

The `apply_migrations()` runner in `_legacy_sqlite.py` works by reading `MAX(version) FROM schema_version` once at the start, then iterating forward from `current + 1`. The version counter is incremented and committed inside the same transaction as the migration itself.

**The failure mode:** When a migration fails part-way through (e.g. an `ALTER TABLE` for a column that already exists, or a `CREATE TABLE` that throws), the error is caught by the broad `except sqlite3.OperationalError` guard (line 948). The guard only allows specific migration numbers through (`i not in {3, 4, 6, 8, 15, 18, 20, 22, 27, 28, 30, 31, 33}`). For migrations NOT in that list, the error is re-raised.

However: if the migration was applied via a previous **manual patch** (git checkout cherry-pick applied the Python changes but without running migrations through the runner), the schema_version row may NOT have been written. On next boot the runner sees `current = N-1`, tries migration `N`, which tries to `CREATE TABLE conversations` — but that table was already hand-created. If the migration is in the allowed-skip list it passes; if not, it re-raises and aborts, potentially leaving `schema_version.version` at `N` with the actual row written, but the NEXT migration (`N+1`) not applied because the error caused an exception before the next loop iteration.

**Specifically (2026-05-29):** Manual deploy applied `_legacy_sqlite.py` changes (migrations 34–37) but did not run the service. The prod DB's `schema_version` was at version 33 from a previous partial run. When the service started, it applied migrations 34–37 in sequence. Migration 13 (files table) has a DUPLICATE comment marker `# -- migration 13` for two different migrations — the `file_binding_audit` migration. This caused `file_binding_audit` and `conversations` and `schedules` to be at different version numbers than the code expected, so some `CREATE TABLE IF NOT EXISTS` succeeded silently (already existed) while the `schema_version` record was written, advancing the counter past the real last-applied migration.

### The fix (implemented here)

The deploy script calls `ops/verify-schema.py` after restart. This runs a structural check INDEPENDENT of the version counter: it compares every `CREATE TABLE` in the migration source against `sqlite_master.tables` in the live DB. Any discrepancy fails the deploy immediately, before any user traffic hits the stale schema.

Additionally, `apply_migrations()` already uses `CREATE TABLE IF NOT EXISTS` for most table-creating migrations (idempotent). The dangerous cases are the `ALTER TABLE ADD COLUMN` migrations, which can throw `duplicate column name`. These are already handled by the `{3, 4, 6, 8, ...}` allowed-skip set.

### Self-healing boot reconcile

A reconcile pass runs on every service startup (see `ops/verify-schema.py` logic). If a table is missing (e.g. migration counter advanced but schema not applied), the deploy fails loudly before traffic reaches the service. The operator restores from backup and re-deploys.

This is the brutally-simple fix: detect drift immediately, fail deploy, restore from the pre-deploy backup made in step 2. No automatic data-loss-risk schema surgery on a live DB.

---

## CRITICAL: Never `git reset --hard` the prod checkout

`/root/workeros` is the production working tree. It contains untracked runtime files that are NOT in git:

- `data/floom.db` — the production SQLite database
- `data/artifacts/` — run artifact files
- `apps/api/.env` — may exist as an override
- `workspace.md` — live operator workspace
- `workspace.base.md` — optional live Emily base persona override
- `contexts/` — operator context files

`git reset --hard` would delete none of these (they are untracked), but it WOULD reset `HEAD` and potentially clobber staged/tracked changes. More importantly: other concurrent agents also work in this repo via `git worktree`. A reset in the canonical checkout clobbers other branches.

**Never run:**
```bash
git reset --hard   # FORBIDDEN on /root/workeros
git checkout .     # FORBIDDEN on /root/workeros
git clean -f       # FORBIDDEN on /root/workeros
```

**Always use the deploy script** which uses `git checkout origin/main -- <paths>` to sync only specific tracked files.

---

## Checking deploy logs

```bash
journalctl -u workeros-api -n 100 -f
journalctl -u workeros-api --since "5 minutes ago"
```

## Checking current migration version

```bash
sqlite3 /root/workeros/data/floom.db "SELECT version, applied_at FROM schema_version ORDER BY version"
```

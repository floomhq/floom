# ax-11 — Data lifecycle (SQLite / self-host)

Extended audit: where Floom persists state on disk, how schema evolves, and what operators should assume for backup, restore, corruption, and scaling. Product framing: see [`docs/PRODUCT.md`](../PRODUCT.md); deployment defaults: [`docs/SELF_HOST.md`](../SELF_HOST.md).

---

## 1. Canonical paths

| Concept | Resolution | Notes |
|--------|------------|--------|
| Data root | `process.env.DATA_DIR \|\| './data'` | Local dev defaults to `./data` under the server cwd. Docker images set `DATA_DIR=/data` (see `docker/Dockerfile`, `docker/docker-compose.yml`). |
| SQLite main file | `<DATA_DIR>/floom-chat.db` | Opened at module load via `better-sqlite3`. |
| WAL / shared memory | `<DATA_DIR>/floom-chat.db-wal`, `floom-chat.db-shm` | Created when WAL mode is enabled (always in current code). |
| Hosted app working dirs | `<DATA_DIR>/apps/` | Ensured at boot (`APPS_DIR`). |
| Compiled custom renderers | `<DATA_DIR>/renderers/<slug>.js` | Written at ingest time (`renderer-bundler.ts`). |
| Master KEK file (optional) | `<DATA_DIR>/.floom-master-key` | Generated on first boot if `FLOOM_MASTER_KEY` env is unset; mode `600`. Same volume as the DB per design. |

**Gitignore:** the repo ignores runtime data so local databases are never committed:

- `.gitignore`: `data/` and `apps/server/data/`

There is no checked-in `apps/server/data/` tree; persistence is entirely operator-owned.

---

## 2. Engine configuration (from `apps/server/src/db.ts`)

- **Library:** `better-sqlite3` (synchronous API; one Node process holds the DB connection).
- **Journal:** `PRAGMA journal_mode = WAL` — good for concurrent readers + one writer pattern; produces `-wal`/`-shm` siblings.
- **Contention:** `PRAGMA busy_timeout = 5000` — same-process / cooperative locking retries up to 5s before surfacing `SQLITE_BUSY`. This does **not** make multi-process multi-writer access safe.
- **Referential integrity:** `foreign_keys = ON`.

---

## 3. Migrations (no migration directory)

There are **no** Flyway-style SQL files or a `migrations/` folder. Schema and upgrades live **inline in** `apps/server/src/db.ts`, executed sequentially when the module loads:

1. **`CREATE TABLE IF NOT EXISTS`** for core tables (`apps`, `runs`, `jobs`, `secrets`, threads/turns, embeddings, workspaces, users, Stripe, triggers, reviews, feedback, policies, etc.).
2. **Column adds:** `PRAGMA table_info(<table>)` then conditional `ALTER TABLE ... ADD COLUMN` (idempotent).
3. **Legacy renames:** detect `chat_threads` / `chat_turns` and `ALTER TABLE ... RENAME TO` `run_threads` / `run_turns` when needed.
4. **Bootstrap rows:** ensure synthetic `workspace_id='local'` and `user_id='local'` (and membership) exist; backfill display-name fix for legacy `'Local User'`.
5. **Small data patches:** e.g. `PRIMARY_ACTION_SEEDS` manifest updates wrapped in `try/catch` so a failure does not block boot.
6. **`PRAGMA user_version`:** bumped to **11** as a human-readable schema marker; actual drift control is the idempotent DDL above, not version-gated branches alone.

**Better Auth (cloud only):** when `FLOOM_CLOUD_MODE=true`, the same `better-sqlite3` instance is passed to Better Auth (`apps/server/src/lib/better-auth.ts`). `runAuthMigrations()` runs on boot **before** seeding (`apps/server/src/index.ts`); it can **fail fast** (`process.exit(1)`) if auth migrations cannot apply. In OSS mode, auth migrations are a no-op.

**Implication for operators:** upgrading Floom means **replacing the server binary/image and restarting**. The first boot after upgrade runs all idempotent migrations automatically. There is no separate “migrate” CLI in-repo for SQLite.

---

## 4. What is (and is not) in the database

**In SQLite:** app registry and manifests, runs, jobs, threads/turns, global/per-app secrets rows, embeddings, multi-tenant tables, Composio connections, Stripe bookkeeping, triggers, reviews, feedback, encrypted user/creator secret ciphertext, Better Auth tables (cloud).

**On disk beside SQLite:** `apps/` tree for hosted workloads, `renderers/` bundles, optional `.floom-master-key`. A **full** restore story must include the whole `DATA_DIR`, not only `floom-chat.db`.

---

## 5. Backup / restore story

### 5.1 Recommended: online logical copy (repo script)

[`docker/scripts/floom-backup.sh`](../../docker/scripts/floom-backup.sh) documents a host-side cron flow:

- Uses **`sqlite3 <path> ".backup '<staging-file>'"`** — SQLite’s online backup API: a **consistent snapshot** even while the server is writing (preferred over naive `cp` of the main file while WAL is active).
- Compresses with `gzip`, optional retention pruning.
- Default path targets a Docker volume layout; override with `FLOOM_BACKUP_DB`, `FLOOM_BACKUP_DIR`, `FLOOM_BACKUP_RETENTION_DAYS`.

### 5.2 Documented alternatives (`docs/SELF_HOST.md`)

- **`.dump` to SQL:** useful for inspection or ETL (e.g. future Postgres); not the same as a page-level hot backup for large DBs.
- **Example restore path:** gunzip into the volume’s `floom-chat.db` location (see Persistence / backup sections in SELF_HOST).

### 5.3 WAL-aware file copy (if not using `.backup`)

If copying files cold: **stop the container** or ensure a quiesced checkpoint so `-wal` is merged or copied consistently; copying only `floom-chat.db` while the server is running risks an inconsistent backup unless the operator uses `.backup` or SQLite backup API.

### 5.4 Master key and encrypted secrets

`user_secrets` / workspace DEKs depend on **`FLOOM_MASTER_KEY` or `<DATA_DIR>/.floom-master-key`**. Back up the key **with** the database; losing the key makes ciphertext **unrecoverable** (called out in SELF_HOST). Rotating the master key is described as an operational rewrap job, not automatic in application code.

---

## 6. Corruption handling

**Application layer:** there is **no** built-in `PRAGMA integrity_check` runner, automatic repair, or corruption-specific recovery path in the server code audited here. Failures surface as SQLite / driver errors at query time.

**“Corrupted” in HTTP responses** (e.g. manifest routes) refers to **invalid JSON in stored manifests**, not physical DB corruption.

**Operator playbook (outline):**

1. On suspected corruption: stop the server; copy the whole `DATA_DIR` aside for forensics.
2. Run `sqlite3 floom-chat.db "PRAGMA integrity_check;"` on a copy.
3. If `integrity_check` fails: attempt `.recover` / export what is readable, or restore from last good `.backup` artifact.
4. After restore: start server; migrations are idempotent; synthetic `local` workspace/user are re-ensured if missing.

---

## 7. Multi-instance and SQLite (warning)

**SQLite is not a multi-writer cluster store.** A single Floom server process maps naturally to one open database file.

**Do not** run **two Floom server processes** (e.g. two containers, or horizontal replicas) against the **same** `floom-chat.db` on a shared filesystem (NFS, SMB, multi-attach block volume) expecting HA. Risks include database corruption, `SQLITE_BUSY` storms, and undefined behavior under concurrent write from different machines.

**`busy_timeout` + WAL** improve **cooperative** contention within workloads that share one DB handle pattern; they do **not** authorize multiple independent servers on one file.

**Scaling guidance (outline):** one active writer per `DATA_DIR`; scale vertically or move to a client/server database (Postgres, etc.) if multi-instance is required — product docs already sketch a `.dump` / migration direction for cloud-scale (`docs/SELF_HOST.md` multi-tenant section).

---

## 8. Risk summary

| Risk | Severity | Mitigation |
|------|----------|------------|
| Unbounded disk growth (runs, logs, WAL) | Medium | Monitor `DATA_DIR` size; optional periodic `VACUUM` offline; tune retention if product adds it. |
| Backup = raw `cp` of `.db` only while live | High | Use `sqlite3 .backup` or stop server before file copy; include `-wal`/`-shm` or checkpoint first. |
| Loss of `.floom-master-key` / `FLOOM_MASTER_KEY` | Critical | Backup key with DB; document rotation procedure. |
| Multi-replica on one SQLite file | Critical | Single writer; no shared DB across instances. |
| Auth migration failure in cloud mode | High (availability) | Boot aborts — fix DB permissions / disk / version skew before restart. |
| No automated integrity monitoring | Low–Medium | Add periodic `integrity_check` in ops (external cron), alert on failure. |

---

## 9. Operator guidance outline (checklist)

1. **Mount `DATA_DIR`** to durable storage (named volume or bind mount); never rely on container ephemeral FS for production.
2. **Schedule backups** using online `.backup` (see `floom-backup.sh`); retain multiple generations; test a restore quarterly.
3. **Backup scope:** entire `DATA_DIR` (DB + WAL/SHM if doing file-level + quiesce, or rely on `.backup` output) + `apps/` + `renderers/` + `.floom-master-key` (or secure env-based key management).
4. **Restore:** stop Floom; restore files or gunzip DB into place; ensure key material matches the backup; start Floom; verify `/api/health` and a read path (`/api/hub`).
5. **Upgrade:** pull new image; restart one instance; watch logs for migration/auth messages.
6. **Never** scale to N>1 server processes on the same SQLite path.

---

## 10. Source references

- `apps/server/src/db.ts` — paths, pragmas, DDL, inline migrations, `user_version`.
- `apps/server/src/lib/better-auth.ts` — shared DB handle, `runAuthMigrations()`.
- `apps/server/src/index.ts` — boot order (auth migrations → seed → …).
- `apps/server/src/services/user_secrets.ts` — master key file path and semantics.
- `docker/scripts/floom-backup.sh` — online backup pattern.
- `docs/SELF_HOST.md` — env table, persistence list, `.dump`/restore examples, master key warning.
- `.gitignore` — `data/`, `apps/server/data/`.

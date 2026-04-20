# Backend audit: database layer (`apps/server/src/db.ts`)

**Scope:** Single-file SQLite bootstrap for Floom’s Node server: schema definition, inline migrations, pragmas, and synthetic OSS defaults. Consumed across routes and services via a shared `better-sqlite3` `Database` instance.

**Product alignment:** Per `docs/PRODUCT.md`, the DB backs hosting, the three surfaces (web form, MCP, HTTP), async jobs, and tenant-scoped state. The schema’s evolution (apps → runs → jobs → workspaces/users → Composio, Stripe, triggers) matches the staged product narrative rather than a clean greenfield design.

---

## Schema design

**Strengths**

- **Clear domain tables** with TEXT primary keys and JSON columns where appropriate (`manifest`, `inputs`/`outputs`, job payloads). Foreign keys are declared with `ON DELETE CASCADE` where parent removal should cascade (e.g. `runs.app_id → apps.id`).
- **Multi-tenant foundation (W2.1)** is explicit: `workspaces`, `users`, `workspace_members`, `app_memory`, `user_secrets`, plus `DEFAULT_WORKSPACE_ID` / `DEFAULT_USER_ID` so OSS “solo mode” uses the same query shape as cloud (`workspace_id = ?`).
- **Separation of concerns:** Floom-owned tenant tables coexist with Better Auth (cloud) using a documented naming split; Stripe and Composio tables are scoped and commented.
- **Operational metadata:** `PRAGMA user_version` is bumped (to 11) as a coarse schema revision marker for operators, separate from the many idempotent `ALTER`s.

**Risks / inconsistencies**

- **Legacy rename path** (`chat_threads`/`chat_turns` → `run_threads`/`run_turns`) is handled in-process; ordering vs. `CREATE TABLE IF NOT EXISTS` is intentional but easy to break if someone reorders blocks.
- **`app_reviews`** declares `workspace_id` without a `REFERENCES workspaces` FK (minimal W4 table); integrity relies on application code.
- **`deploy_waitlist`** is created in `routes/deploy-waitlist.ts`, not in `db.ts`, so schema ownership is split across modules.
- **Mixed time representations:** some tables use ISO `TEXT` datetimes, `triggers` / webhook idempotency use epoch `INTEGER` ms—consistent within each subsystem but not uniform globally.

---

## Prepared statements

- The codebase uses **`db.prepare(...)` for almost all reads/writes** from services and routes (e.g. hub listing, job CRUD, runs, triggers). That matches `better-sqlite3`’s model: statements are compiled once and reused; parameters are bound positionally (`?`), which avoids string concatenation for user input on those paths.
- **Dynamic SQL** appears where columns are built at runtime (`UPDATE apps SET ${updates.join(...)}`, similar for runs/workspaces). Those are acceptable only if column names are strictly controlled by code (not user input); any expansion of that pattern needs the same discipline.
- **Schema boot** uses `db.exec` for multi-statement DDL batches—appropriate for startup-only DDL.

---

## Migrations

- **There is no separate migrations folder or versioned SQL files.** All changes run from `db.ts` on import: `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, then **column detection via `PRAGMA table_info(...)`** followed by conditional `ALTER TABLE ... ADD COLUMN`.
- **Idempotent data fixes** (e.g. `PRIMARY_ACTION_SEEDS`, local user name backfill) run at boot; one block is wrapped in try/catch so a bad seed cannot block startup.
- **`user_version`** is set only upward to 11; it is **not** used to gate individual steps—actual safety is per-table `IF NOT EXISTS` / column lists. Operators get a rough revision number; automated tooling cannot rely on it alone for step ordering.

**Trade-off:** This keeps deploys simple (no migration runner) but makes **large refactors harder**, and **ordering bugs** in `db.ts` can affect fresh installs vs. upgraded DBs differently until caught by tests.

---

## SQLite footguns

| Area | Observation |
|------|-------------|
| **Single writer** | SQLite allows concurrent readers with WAL but **one writer at a time**. Heavy write contention still serializes; `busy_timeout` only waits, it does not add parallel write throughput. |
| **WAL + FK** | `journal_mode = WAL` and `foreign_keys = ON` are set—good defaults for this stack. |
| **CHECK constraints** | Used on `connections`, `triggers`, `stripe_accounts`, etc.; SQLite enforces them. |
| **Unique indexes** | `secrets(name, COALESCE(app_id, '__global__'))`, partial unique on `triggers(webhook_url_path)`, Stripe `event_id` dedupe—appropriate patterns. |
| **Embeddings** | Vectors stored as **raw BLOB**; similarity is computed in application code (`embeddings.ts`), not in SQL—no native vector index; acceptable at current scale, not a “semantic search DB” story. |
| **Full table scans** | Hub default sort (`featured`, `avg_run_ms`, `created_at`) over `WHERE status = 'active' AND visibility` may scan heavily **without a composite index** matching that filter+order; mitigated in practice by an **in-memory hub cache** (see `hub.ts`). |
| **Job dequeue** | `nextQueuedJob` uses `WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1`. Existing indexes include `idx_jobs_status` and `idx_jobs_created_at`; a **single composite index on `(status, created_at)`** would align more tightly with that query under load. |

---

## Concurrency

- **`busy_timeout = 5000`** (ms) is set with an explicit comment: reduces `SQLITE_BUSY` surfacing to callers when multiple connections/transactions contend—aligned with WAL for typical multi-connection use within one process.
- **Job claiming** uses an atomic `UPDATE ... WHERE id = ? AND status = 'queued'` pattern (`jobs.ts`) so double-claim is avoided.
- **Trigger scheduling** uses compare-and-swap style `UPDATE ... WHERE id = ? AND next_run_at = ?` to avoid double fire; `readyScheduleTriggers` selects candidates ordered by `next_run_at`; index `idx_triggers_schedule` on `(trigger_type, enabled, next_run_at)` supports the filter + order.
- **Cross-replica:** Multiple Node processes against **one** SQLite file are **not** a supported scaling model for SQLite; WAL + busy timeout help **same-host** contention, not distributed writers.

---

## Secrets and sensitive data in the DB

| Store | What’s stored | Notes |
|-------|----------------|-------|
| **`secrets`** | `name`, **`value` plaintext**, optional `app_id` | Global or per-app **legacy/plain** secrets table; highest sensitivity if used for API keys. |
| **`user_secrets`** | AES-GCM **ciphertext + nonce + auth_tag** | Per-user vault; encryption uses workspace DEK wrapped with `FLOOM_MASTER_KEY` (see `services/user_secrets.ts`). |
| **`workspaces.wrapped_dek`** | Wrapped data-encryption key (hex) | Enables per-workspace encryption; `NULL` until first secret use (documented in `db.ts`). |
| **`app_creator_secrets`** | Encrypted blobs | Creator overrides for shared credentials; same envelope story as user secrets. |
| **`jobs.per_call_secrets_json`** | JSON blob at job creation | Can hold **per-invocation** secret material for the run; treat as sensitive at rest as the rest of the row. |
| **Stripe / Composio** | Account IDs, metadata JSON | Not raw card data; still tenant-scoped PII/configuration. |

**Assessment:** The product has a **deliberate split**: newer paths use **envelope encryption**; the older **`secrets` table stores values in cleartext**—any audit or compliance story must call that out explicitly and scope which features still write there.

---

## Indexes and hot paths

- **Apps:** `slug` (unique + index), `category`, `workspace_id`, `featured + avg_run_ms` for store ordering. Slug lookups (`SELECT * FROM apps WHERE slug = ?`) are well covered.
- **Runs:** `thread_id`, `app_id`, `(workspace_id, user_id)`, partial `device_id` where present—aligned with listing and tenant-scoped queries.
- **Jobs:** `(slug, status)`, `status`, `created_at`—good for filtering; dequeue path could benefit from a **composite** tailored to `status='queued' ORDER BY created_at`.
- **Connections / triggers / Stripe:** Indexes match lookup patterns (owner, provider, Composio id, schedule poll, webhook path).
- **`users`:** Partial unique on `(auth_provider, auth_subject)` where subject present; email index for invite flows.

---

## Summary

The database layer is **opinionated, self-contained, and optimized for solo/single-process deployment** with WAL, foreign keys, and busy handling. **Schema drift is managed entirely in `db.ts`** without external migration files—simple to ship, harder to reason about at scale. **Sensitive data handling is mixed**: encrypted vaults and wrapped DEKs coexist with **plaintext `secrets.value` and job-stored JSON secrets**, which any security review should treat as first-class. **Index coverage is generally good**; the highest-traffic read path (public hub list) relies partly on **application-level caching**, and the job queue’s “next queued” query could be tightened with a composite index if queue depth grows.

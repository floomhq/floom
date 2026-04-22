-- Migration: apps.publish_status — manual publish-review gate (#362).
--
-- Floom's schema is authored via idempotent inline migrations in
-- apps/server/src/db.ts. This .sql file is the canonical record of what
-- that migration executes, matched line-for-line by the block in db.ts
-- guarded by `if (!appCols.includes('publish_status'))`. Operators who
-- want to apply the migration manually against an external DB can run
-- this file verbatim against a pre-v12 DB; the inline migration in
-- db.ts is a no-op on subsequent boots.
--
-- Semantics
-- ---------
-- `publish_status` is an axis independent of `visibility`:
--   - 'draft'           — reserved for future creator flows. Unused today.
--   - 'pending_review'  — default for newly-created apps. Hidden from the
--                         public Store until an admin approves.
--   - 'published'       — admin-approved. Visible on the public Store for
--                         apps whose `visibility='public'`.
--   - 'rejected'        — admin declined. Hidden like pending_review.
--
-- On FIRST boot with this column (`ADD COLUMN ... DEFAULT 'pending_review'`),
-- every existing row would otherwise flip to 'pending_review' and vanish
-- from the Store. To preserve currently-live apps (lead-scorer, the 4
-- utilities, the competitor-analyzer + resume-screener showcases), we
-- immediately UPDATE every row to 'published' in the same migration
-- block. Visibility='private' apps (e.g. ig-nano-scout) are backfilled
-- too — the Store filter is already layered on visibility, so marking a
-- private app 'published' is a no-op for the public list.
--
-- After this migration, every NEW insert from Studio /build or MCP
-- ingest_app writes `publish_status='pending_review'` explicitly in the
-- INSERT statement (see services/openapi-ingest.ts + services/docker-image-ingest.ts).
-- First-party boot-time inserts (services/seed.ts, services/launch-demos.ts,
-- and services/openapi-ingest.ts's FLOOM_APPS_CONFIG path) write
-- `publish_status='published'` explicitly.

ALTER TABLE apps
  ADD COLUMN publish_status TEXT NOT NULL DEFAULT 'pending_review';

-- One-shot backfill. Pre-migration rows are already live on this
-- instance, so keep them visible. New rows after this point get the
-- 'pending_review' default via the column definition, and ingest
-- paths override to 'published' only for first-party content.
UPDATE apps SET publish_status = 'published';

CREATE INDEX IF NOT EXISTS idx_apps_publish_status ON apps(publish_status);

-- Bump user_version so operators can see at a glance which schema
-- revision their DB is on. Matches `db.pragma('user_version = 12')` in
-- apps/server/src/db.ts.
PRAGMA user_version = 12;

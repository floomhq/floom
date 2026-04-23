-- Migration: apps.thumbnail_url + apps.stars + apps.hero — store-catalog
-- wireframe parity (v17 store.html, 2026-04-23).
--
-- Floom's schema is authored via idempotent inline migrations in
-- apps/server/src/db.ts. This .sql file is the canonical record of what
-- that migration executes, matched line-for-line by the block in db.ts
-- guarded by `if (!appCols.includes('thumbnail_url'))` + siblings.
-- Operators who want to apply the migration manually against an external
-- DB can run this file verbatim; the inline migration in db.ts is a
-- no-op on subsequent boots.
--
-- Semantics
-- ---------
-- `thumbnail_url` — relative or absolute URL to a 640x360 PNG shown at
-- 120px in the /apps grid card. NULL means "render the gradient
-- fallback" (AppIcon glyph on a category tint) so launch does not block
-- on hand-authored screenshots.
--
-- `stars` — non-negative integer. Seeded 0 and left to an admin /
-- future reviews aggregation to backfill. The "hot" threshold on the
-- wireframe (accent-filled star at >=100) is a render-time decision;
-- no separate column.
--
-- `hero` — 0/1. Distinct from `featured` (which controls the default
-- Store sort order). `hero=1` flips the "HERO" accent tag on the card
-- chrome. Seeded manually on the three AI demo apps (lead-scorer,
-- competitor-analyzer, resume-screener) in services/launch-demos.ts.
--
-- NO runs_7d column: the 7-day run count is derived at read time from
-- the runs table via a correlated subquery in the /api/hub handler, so
-- it always reflects live activity without a staleness window.
--
-- These ALTER TABLE statements are idempotent at the db.ts level (they
-- sit behind a PRAGMA table_info check). Running this file against a
-- fresh DB or a DB that already has these columns will fail at the
-- sqlite layer; the authoritative place is db.ts.

ALTER TABLE apps ADD COLUMN thumbnail_url TEXT;
ALTER TABLE apps ADD COLUMN stars INTEGER NOT NULL DEFAULT 0;
ALTER TABLE apps ADD COLUMN hero INTEGER NOT NULL DEFAULT 0;

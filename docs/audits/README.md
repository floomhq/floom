# Workeros Audits

Each round of audits writes a set of reports under `docs/audits/<agent>-YYYY-MM-DD.md` plus a `MASTER-YYYY-MM-DD.md` aggregating them.

## How to run a re-audit

1. Read `MASTER-2026-05-26.md` to see what was open last time.
2. Fire 4 parallel sub-agents (see the "How to re-run" section in `MASTER-2026-05-26.md`):
   - UI/UX roast (broker browser, every route at desktop+mobile)
   - Functional E2E (22 sub-tests)
   - B2C user-perspective roast (30-min Granola->HubSpot journey)
   - Security + edge cases (read ARCHITECTURE.md first, hit prod URL not localhost)
3. Each writes to `docs/audits/<name>-<today>.md`.
4. Write a new `MASTER-<today>.md` reconciling findings against the previous master to show:
   - What's resolved
   - What's new
   - What recurred (regressions)

## Future: virgin VPS audit environment

the operator requested that external auditors hit a virgin VPS, not prod. Setup script TBD at `scripts/setup-audit-vps.sh`. Until that exists, rotate FLOOM_SECRET after every external audit.

## Index

| Date | Reports |
|------|---------|
| 2026-05-26 | `MASTER-2026-05-26.md` (4 internal + 1 external) |

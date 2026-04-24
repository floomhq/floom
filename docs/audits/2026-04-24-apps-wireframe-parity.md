# /apps vs v17 store.html wireframe — parity audit (2026-04-24)

**Status:** 0 code changes. Doc-only. All divergences are intentional Federico decisions preserved.

**Wireframe:** https://wireframes.floom.dev/v17/store.html
**Impl:** `apps/web/src/pages/AppsDirectoryPage.tsx` + `apps/web/src/components/public/AppGrid.tsx`
**Rule applied:** informed gap-closing, not blind match. "Some are better than wireframes now." (Federico)

## KEEP / MATCH / SKIP log

| # | Section | Wireframe | Current | Decision source | Verdict |
|---|---------|-----------|---------|-----------------|---------|
| 1 | H1 text | "22 AI apps, free to run." | "{N} AI apps, free to run." | #701 launch scope = 3 | KEEP |
| 2 | H1 font | DM Serif Display 400 | Inter 800, -0.025em | #515 display font | KEEP |
| 3 | Sub copy | "Real AI doing real work…" | identical | — | KEEP |
| 4 | Header layout 40/28/16 maxW 1180 | same | same | #523 | KEEP |
| 5 | Chip styling (padding/radius/active ink) | 6/12, 12.5px, 600 active | identical | — | KEEP |
| 6 | Search ⌘K kbd badge | present | absent | aspirational; no cmd-K handler | SKIP |
| 7 | Sort "Trending [soon]" button + dropdown | present | **removed** | #701 explicit | KEEP |
| 8 | Toolbar border-bottom | 1px var(--line) | same | — | KEEP |
| 9 | Grid top gutter | 24px | 32px | #696 explicit | KEEP |
| 10 | Grid: 4→3→2→1 breakpoints | repeat(4,1fr) | auto-fill minmax(260,380) | #682 (regression #679) | KEEP |
| 11 | Thumbnail 3-bar mock | on every card | per-slug MiniViz for 3 launch apps | #645/#651 "intentional" | KEEP |
| 12 | Thumbnail inner 1px border | implicit | removed | #682 explicit | KEEP |
| 13 | HERO badge | per card | auto-suppress when all visible are heroes | #519/#651 | KEEP |
| 14 | Category tag + Run → in footer | bottom row | category chip in thumb top-right, footer = Run → only | #651 | KEEP |
| 15 | FRESH badge | absent in WF, was in old impl | **removed** | #701 explicit: "read as noise when on everything" | KEEP |
| 16 | Star + count on every card | yes | only when stars > 0; hot at ≥100 | #651 | KEEP |
| 17 | Icon tints | unspecified | single warm-dark neutral across all | #701 explicit: "single neutral icon tint" | KEEP |
| 18 | Output-preview pill | absent in WF | rendered for 3 launch slugs | #651 | KEEP |
| 19 | Footer border-top + Run → | yes | yes | #624 | KEEP |
| 20 | Skeleton shimmer on load | absent | 8 shimmer cards | polish | KEEP |
| 21 | Softened error + retry states | absent | present | #522 | KEEP |

## Summary

- **MATCH items closed: 0**
- **KEEP items: 21** (all tied to explicit Federico PR decisions or additive polish)
- **SKIP: 1** (⌘K kbd badge — no handler wired, dead affordance)

## Why no code changes

Every wireframe divergence on `/apps` was deliberately chosen by Federico across PRs #519, #522, #523, #624, #645, #651, #679, #682, #696, #701. The page is at its polished state. Blindly matching the wireframe would regress all of these decisions.

## Preservation rules locked in today

Future agents auditing `/apps`: **do not reintroduce**

- FRESH badge on card-stats (#701 removed it)
- Sort "Trending [soon]" button (#701 removed it)
- Per-category colored icon tints (#701 unified to neutral)
- Inner thumbnail border (#682 removed it)
- Fixed `repeat(N, 1fr)` grid (#682 switched to auto-fill capped at 380px)
- "22 apps" hard-coded H1 (#701: launch scope is 3)
- Bottom-row category tag (#651 moved to thumbnail top-right)

If the wireframe changes and these decisions should be reconsidered, flag it to Federico explicitly. Don't reverse silently.

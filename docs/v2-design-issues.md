# /v2 design preview — issue tracker

Audited 2026-06-10 (adversarial walk, day+night, desktop+mobile). Status legend:
OPEN / FIXING / FIXED / VERIFIED / WONTFIX.

## P0

| # | Issue | Root cause | Status |
|---|-------|-----------|--------|
| 1 | Light theme never applied — page rendered the OLD warm system (#FAFAF7 bg, #E7E0D6 borders) in day mode | `.theme-v2 {}` ties with `:root` on specificity (0,1,0) and loses the cascade; only `.theme-v2.dark` (0,2,0) won. | FIXED — `.theme-v2.theme-v2` double-class hammer |
| 2 | "Hire this worker" button white-on-white in day mode (primary CTA invisible) | Same as #1 — `--primary` never overridden, resolved through broken chain | FIXED by #1 |
| 3 | Dark mode: every `border-border` element ringed warm-cream `#FAFAF7` | Same as #1 — `--border` chain fell through to old tokens | FIXED by #1 |

## P1

| # | Issue | Root cause | Status |
|---|-------|-----------|--------|
| 4 | Composer carries box-shadow (spec is flat) | Inline JS shadows in HeroPromptComposer, unreachable by token override | FIXED — scoped `!important` flat rule + focus ring in spec blue |
| 5 | Warm-cream `#F1EEE8` leaks in night mode (status pill, CLI badge, inner Hire button) | `--active-nav-bg`/`--bg-2` literals not overridden before fix #1; StatusPill `default` tone uses `bg-accent` (near-black on near-black) | FIXED — token fix + pill tone switched to `pending` |
| 6 | Notion/GitHub monochrome marks risk invisibility on dark | Hardcoded `#000`/`#181717` fills | FIXED — dark-scoped fill override |
| 7 | Composer focus border still old blue `#3a6ea5` (spec: `#3E6FE0`) | Hardcoded ACCENT in HeroPromptComposer.tsx | OPEN — needs component param or v2 fork; low visual delta |
| 8 | Footer arrives in old styling (spacing/borders tuned for warm system) | Component reuse without v2 pass | OPEN — restyle after direction sign-off |

## P2

| # | Issue | Notes | Status |
|---|-------|-------|--------|
| 9 | Footer top hairline near-invisible in day mode | oklab-computed near-white border | OPEN |
| 10 | Built-in cards lack definition against day bg on slow render | flat system tradeoff; consider `bg-card` + hairline (already present — verify post-#1) | OPEN — re-verify |
| 11 | Duplicate full composer at final CTA reads heavy | Consider slim variant for the closer | OPEN — design call |
| 12 | ⌘+Enter hint on touch devices | Already `hidden sm:inline`; verify on real device | OPEN |
| 13 | Scrollytelling vertical rhythm sparse on static scroll | Tune `min-h` of steps after direction sign-off | OPEN |

## Verified good (do not regress)

- Dark palette structure (#191A1D bg, toggle reliability)
- Zero old-blue leakage in measured styles (focus state aside, #7)
- Template list section — called "production-ready" by audit
- Shadow discipline elsewhere; mobile stacking; footer content structure

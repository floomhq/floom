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
| 7 | Composer focus border still old blue `#3a6ea5` (spec: `#3E6FE0`) | Hardcoded ACCENT in HeroPromptComposer.tsx | FIXED — V2Composer fork, spec blue throughout |
| 8 | Footer arrives in old styling (spacing/borders tuned for warm system) | Component reuse without v2 pass | FIXED — V2Footer on spec tokens, Docs link added |

## P2

| # | Issue | Notes | Status |
|---|-------|-------|--------|
| 9 | Footer top hairline near-invisible in day mode | oklab-computed near-white border | FIXED — V2Footer uses border-border (alpha hairline) |
| 10 | Built-in cards lack definition against day bg on slow render | flat system tradeoff | FIXED — upgraded BuiltIn: wide approval card w/ Slack moment + 2 vignette cards, hairline ring |
| 11 | Duplicate full composer at final CTA reads heavy | Consider slim variant for the closer | FIXED — V2Composer slim variant at final CTA |
| 12 | ⌘+Enter hint on touch devices | `hidden sm:inline` in V2Composer | FIXED |
| 13 | Scrollytelling vertical rhythm sparse on static scroll | min-h 290→200/160, Lovable-clean layout (no step labels, single soft panel) | FIXED |

## Verified good (do not regress)

- Dark palette structure (#191A1D bg, toggle reliability)
- Zero old-blue leakage in measured styles (focus state aside, #7)
- Template list section — called "production-ready" by audit
- Shadow discipline elsewhere; mobile stacking; footer content structure

## Pass 2 additions (2026-06-10)

- Hero: channel-entry row under composer (Slack / WhatsApp / MCP) — "no dashboard needed"
- Spec blue #3E6FE0 used properly: primary CTA, links, category pills, hover accents
- How-it-works rebuilt to the Lovable reference: one soft rounded panel, big bold step headings, AnimatePresence crossfade, hover-to-activate
- NEW AppFrame section: real app cockpit (sidebar + workers grid + status pills + real tool logos) — "what you see when you sign in"
- BuiltIn upgraded: wide approval card with a real Slack moment, brain card with per-file run counts, run-record card with timestamped tool calls
- /v2/templates: designed browser (category pills, search, animated grid, slim composer CTA)
- framer-motion: load stagger, whileInView reveals, hover springs, AnimatePresence
- Docs link in nav + footer

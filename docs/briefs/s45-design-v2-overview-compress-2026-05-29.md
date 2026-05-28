# S45 — Design system V2: single-blue dark mode + radius audit + /overview compression

**Date:** 2026-05-29
**Author:** Claude
**For:** Claude sub-agent (Sonnet)
**Priority:** P0 — Federico explicit, 3 connected fixes. Image #85 shows two distinct blues in dark mode; design system inconsistencies persist after S43; /overview still doesn't fit on one screen.

## Federico's verbatim direction

> "some boxes are soft edge others not, we should have global design system. right?"
> "dark mode: lets stick to one shade of blue?"
> "these overview cards: add sparklines? overall, the overview page should fit on one screen, ideally no scroll needed. actions required could come from some button at top right like notifications?"
> "'Last 7 days' becomes redundant with the sparklines?"

## Bug 1 — Dark mode has two distinct blues

Inspecting `apps/web/app/globals.css`:
- Line 215: `--accent: oklch(0.72 0.14 250)` — light blue, used on "+ New worker" button
- Line 216: `--accent-soft: oklch(0.32 0.06 250)` — dark desaturated blue, used on active nav pill background

Result: sidebar shows two visually distinct blues simultaneously.

**Fix:** ONE blue hue throughout dark mode. Strategy:
- Keep `--accent: oklch(0.72 0.14 250)` as the canonical Floom blue.
- Replace `--accent-soft` USAGE for active nav with an alpha-blended version of `--accent` (e.g., `color-mix(in srgb, var(--accent) 18%, transparent)`).
- The active nav text uses `var(--accent)` solid.
- "+ New worker" button stays solid `var(--accent)` background.

Result: same blue hue everywhere; the only differentiator between primary-CTA and active-nav is fill opacity. Sidebar reads as a single tonal family.

Apply the same color-mix pattern in LIGHT mode for consistency (active nav uses `color-mix(var(--accent) 18%, transparent)`, primary button uses solid `var(--accent)`).

Audit any other dark-mode hex hits that introduce a second blue: grep `apps/web` for `bg-blue-`, `text-blue-`, `border-blue-`, `#[0-9a-f]+ff`-style raw hex in JSX. Each hit either uses `var(--accent)` or is replaced.

## Bug 2 — Radius inconsistency across boxes

Image #85 shows: search input is rounded ~12px, "+ New worker" button is fully rounded (pill), active nav is rounded ~12px, but the right-side "API access" button has square corners. After S43 every card SHOULD be 18px and every button 12px — but the audit clearly missed surfaces.

**Fix:** Add ONE global radius scale and apply religiously:
- `--radius-card: 18px` (cards, alert panels, popovers)
- `--radius-button: 12px` (buttons, inputs, dropdowns, pills, nav items)
- `--radius-pill: 9999px` (status pills, badges, "1" count chips)

Sweep:
```bash
rg -n 'rounded-[a-z0-9]+|rounded-\[' apps/web/app apps/web/components | grep -v rounded-full
```
Replace literal Tailwind radius classes with the CSS variables. Every Button defaults to `rounded-[var(--radius-button)]`. Every Card defaults to `rounded-[var(--radius-card)]`. Every input/dropdown/search uses `--radius-button`.

The "API access" / Settings-page-segment-controls Federico called out get `--radius-button` like everything else.

Don't introduce a 4th scale. If something looks like it needs a different radius, it's the wrong primitive (use a smaller component, not a different radius).

## Bug 3 — /overview compression to single viewport

Current /overview from /S43 (PR #180) renders top-to-bottom as: hero + 4 metric tiles + "Needs your attention" (large panel) + Worker activity + Coming up today. Total height ~1400-1800px; needs scroll on 1080p.

**Target:** Above-the-fold fits in ~800px (single 1280×800 viewport minus chrome).

### Compression plan

**1. Metric tiles get sparklines (replaces "Last 7 days" subtitle).**

The Sparkline component already exists from S29c (`apps/web/components/workers/Sparkline.tsx`). Render a small (h-8) sparkline inside each tile, fed from `recent_stats.timeseries` (already in /overview response).

New tile layout (~90px tall instead of current ~120px):
```
┌─────────────────────────────┐
│ Work shipped                │
│ 52         ▁▂▃▅▆█▇▅▃▂▁     │
│ +18% vs last week           │
└─────────────────────────────┘
```

Drop the "Last 7 days" subtitle line — the sparkline IS the 7-day visualization.

**2. "Needs your attention" → notifications button in top-right header.**

Move out of the body entirely. New element: a bell icon (lucide `Bell`) in the top-right of the page header, with a count badge when count > 0:

```
[ Floom Workers ]                            [ 🔔 3 ]  [theme] [user]
```

Click → opens a shadcn `<Popover>` or `<Sheet>` (use Popover for desktop, Sheet for mobile) anchored to the bell.

Inside the popover: the same row format S43 shipped (worker name + cause + action buttons), just in a 360-400px-wide column. No warm tint, no left border — same neutral style as the rest.

If the count is 0, the bell still renders (subtle) but without a badge. Click shows "All workers running normally" empty state.

**3. Recent activity + Coming up today stay.**

Already in the body in a 2-col grid. Verify they don't expand vertically — cap each at 8 rows visible, "See all →" link if longer.

### New /overview vertical budget

```
80px   header chrome (logo + bell + theme + user)
30px   spacing
60px   hero ("Work done" + tagline)
30px   spacing
100px  metric tiles row (4 across, sparklines)
30px   spacing
240px  worker activity + coming up today (2-col, 8 rows)
30px   spacing remaining
─────
~600px total
```

Leaves headroom under 800px.

## Files

- `apps/web/app/globals.css` (dark/light --accent consolidation; new --radius-button, --radius-pill scale)
- `apps/web/components/ui/button.tsx` (default radius from variable)
- `apps/web/components/ui/card.tsx` (default radius from variable)
- `apps/web/components/ui/input.tsx` (default radius from variable)
- `apps/web/app/page.tsx` (overview compression: tiles+sparklines, move alerts to bell)
- `apps/web/components/overview/MetricTile.tsx` (add sparkline prop)
- `apps/web/components/overview/NeedsAttention*.tsx` (becomes the popover content; remove from body render)
- `apps/web/components/overview/AlertsBell.tsx` (NEW)
- `apps/web/components/layout/Header.tsx` or equivalent (add the bell into the right cluster)
- Audit ALL Tailwind `rounded-*` usages with the grep above

## Verification gate

- [ ] Visit /overview at 1280×800 dark mode: above-the-fold fits without scroll
- [ ] Sidebar in dark mode: bell button + "+ New worker" + active-nav pill are all the SAME blue hue (just different fill opacity)
- [ ] Active nav: `color-mix(in srgb, var(--accent) 18%, transparent)` background, `var(--accent)` text
- [ ] Every metric tile renders a sparkline (h-8) sourced from `timeseries`
- [ ] No "Last 7 days" subtitle anywhere on /overview
- [ ] Notifications bell shows count badge when failing-workers > 0
- [ ] Bell popover content has zero colored left borders, zero warm-tinted backgrounds (just neutral rows + the warning icon in --warning color)
- [ ] Radius grep returns ZERO `rounded-md` or `rounded-sm` in non-test files (everything is via the CSS variables)
- [ ] Light mode: same single-blue pattern applies
- [ ] Lighthouse a11y >= 95 on /overview (bell button has aria-label, popover dismissible by Esc)

## Anti-patterns (binding)

- Don't introduce a 4th radius scale.
- Don't introduce ANY new color (no green-success-soft, no warning-yellow, no per-state accent). One blue, one warning coral, one success green, neutrals. Period.
- Don't put failing-worker count anywhere else in the body — the bell is the single source of truth.
- Don't make the bell popover modal (no overlay). It dismisses on outside click.
- Don't ship a separate dropdown for "+ New worker" while you're in there. Federico said keep current behavior.
- Don't roll your own sparkline component — reuse the existing one (Sparkline.tsx).

## Status file

Append to `/root/workeros/.codex-logs/s45-design-v2-overview-compress-status.md`.

## When done

PR URL + 4 screenshots: /overview light + /overview dark + bell popover open + sidebar dark mode showing one blue.

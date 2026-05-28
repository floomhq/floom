# S43 — Roll the warm OS palette + rounded corners app-wide; strip AI-slop patterns

**Date:** 2026-05-29
**Author:** Claude
**For:** Claude sub-agent (Sonnet)
**Priority:** P0 — Federico explicit. Today's /overview redesign (PR #176) added warm tokens + 18px radius but ONLY on /overview, leaving /workers /runs /connections /settings on the old square-grey shell. Federico: "leaving the design system should NEVER happen! ... i am okay with rounded corners but then everywhere pls". Also strip AI-slop patterns from /overview that should not have shipped (colored left borders + warm-tint card backgrounds on "Needs your attention" rows).

## Federico's verbatim direction (preserve)

> "this overview tab now completely left the design system and followed the ai feedback to literal. leaving the design system should NEVER happen! you even adjusted the global design system. i think parts of it are even better now. but https://workers.floom.dev/overview is not nice and too far away from other pages designs, especially these red cards look like ai slop"
>
> "i am okay with rounded corners but then everywhere pls"

## Two parallel mandates

### Mandate A — Strip the AI-slop patterns from /overview

Reference: Federico's CLAUDE.md `/root/.claude/CLAUDE.md` "Design Anti-Patterns" section. The S39 PR violated:
- **"No colored left borders on cards - AI slop"** — `border-left: 2px solid --warning` on failing-worker rows in "Needs your attention". REMOVE.
- **Warm-tint card backgrounds** (`bg-[rgba(249,115,91,0.04)]` on failing-worker rows) are functionally the same AI-slop pattern. REMOVE.

Replace the failing-worker row treatment with the same neutral card shell every OTHER row uses:
- bg: `--bg-card` (white)
- border: `1px solid --border-default` (neutral warm grey)
- NO colored left border
- NO warm tint background
- The warning ⚠ icon stays in `--warning` color
- The "X failures in 24h" text uses `--text-muted`
- Action buttons (`View logs` / `Retry` / `Disable`) keep their existing shadcn outline-button styling

What stays from S39: the row TITLE format ("Kugelaudio Bug Intake is failing"), the per-worker naming, the action button row. Federico explicitly liked these.

### Mandate B — Roll the warm OS palette + 18px radius app-wide

The S39 PR added these CSS variables in `apps/web/app/globals.css`:

```css
--bg-app: #FAFAF7;
--bg-card: #FFFFFF;
--text-primary: #141414;
--text-muted: #6B6861;
--border-default: #E7E0D6;
--border-soft: #E8E3DA;
--primary: #181818;
--warning: #F9735B;
--success: #2F8F5B;
--radius-card: 18px;
--shadow-card: 0 12px 30px rgba(0,0,0,0.04);
--active-nav-bg: #F1EEE8;
```

These are CORRECT. The bug is they're only applied to /overview components. Roll them out everywhere.

**Surfaces to touch (audit each):**

1. **Sidebar** (`apps/web/components/layout/Sidebar.tsx` or equivalent)
   - Background = `--bg-app` (warm off-white, not grey)
   - Active nav pill: bg `--active-nav-bg`, radius `12px`
   - "+ New worker" button: bg `--primary` (#181818), white text, radius `12px`
   - Logo + search field padding tightened per S39 brief

2. **Global card pattern** — every `<Card>` usage across the app
   - bg `--bg-card`, border `1px solid --border-default`, radius `--radius-card` (18px), shadow `--shadow-card`
   - Currently most cards use `border-line` (the old grey) + `rounded-md` (6px). Switch to the warm tokens + 18px.
   - The `<Card>` component in `apps/web/components/ui/card.tsx` should change its DEFAULT to the warm tokens; pages don't need per-card overrides.

3. **`/workers` list page**
   - Cards already use shadcn `<Card>`. After the global swap, they pick up 18px + warm border for free.
   - Verify the per-card hover state still works.

4. **`/workers/<id>` detail page**
   - Tab strip — tab indicators stay flat but the surrounding chrome uses the warm bg
   - About / Run / Triggers / History / Apps / Source sections — same warm card style on any sub-cards

5. **`/runs` list page**
   - The grouped-by-day table — outer wrapper gets warm bg + 18px corners
   - Per-row hover bg: `--active-nav-bg`

6. **`/runs/<id>` detail page**
   - Status stats strip + split-pane = warm card + 18px corners
   - The `min-h-[280px]` floor (from polish/micro-fixes PR #171) preserved

7. **`/connections` page**
   - Connected / Browse / Secrets tabs — same warm wrapper
   - MCP servers panel — when it becomes its own tab (S41), gets the same warm treatment

8. **`/settings` page**
   - All cards swap to warm

9. **`/workers/new` page**
   - Prompt card + template tiles + generating loader card all warm

10. **`/cli-auth` page**
    - Single card swap

11. **Empty states + skeletons**
    - All skeleton placeholders use `--border-soft` + 18px corners so they don't snap visually when content loads

**Buttons:**
- Primary button: bg `--primary` (#181818), white text, radius `12px`. The old blue (`#2563eb`) shipping in some places goes away.
- Outline button: 1px `--border-default`, text `--text-primary`, radius `12px`.
- Ghost button: hover bg `--active-nav-bg`.

**Status pills (Connected, Expired, Completed, Failed, Queued, Running):**
- Keep the existing pill shapes; they're already neutral.
- Just verify the warm bg doesn't make any of them low-contrast (especially the Expired peach pill).

## Verification gate

- [ ] Walk every primary route at 1280×800 light theme. Take screenshots. Each page reads as part of the same product.
- [ ] No blue anywhere on any page (grep `bg-blue-`, `text-blue-`, `border-blue-` → zero non-trivial hits; if any remain they're for external brand links only)
- [ ] No colored left border on any card (grep `border-l-2`, `border-l-4`, `border-l-warning`, `border-l-destructive`, `border-l-[var(--warning)]` → zero hits)
- [ ] No warm-tint background on any alert/warning row (grep `bg-[rgba(249,115,91` and `bg-warning/` → zero hits)
- [ ] Default card radius is 18px (`--radius-card`) across the app
- [ ] /overview "Needs your attention" rows use the same neutral card style as every other row (just the ⚠ icon colored, nothing else)
- [ ] Sidebar active nav pill style on EVERY page (no full-width blue rectangles)
- [ ] Theme tri-toggle (Light / Dark / System) still works on every page

## Anti-patterns (binding)

- Don't introduce ANY new color token in this PR. Use only the warm tokens already added by S39.
- Don't ship a follow-up PR that only touches one or two pages. If the rollout doesn't cover all 10 surfaces listed above, the PR isn't done.
- Don't add another `--warning-soft` or `--success-soft` variable. The warning/success colors are for icons + text only, never for backgrounds or borders.
- Don't break dark theme. The dark tokens already exist; just verify they map sanely.
- Don't touch backend code in this PR. This is pure CSS + Tailwind + component swap.

## Files

- `apps/web/app/globals.css` — verify warm tokens are at root scope (not :root within @layer)
- `apps/web/components/ui/card.tsx` — update default radius + border + bg
- `apps/web/components/ui/button.tsx` — update primary/outline/ghost variants
- `apps/web/components/layout/Sidebar.tsx` (or equivalent path)
- `apps/web/components/overview/NeedsAttention*.tsx` — strip the slop
- Every page file under `apps/web/app/` — verify they pick up the new tokens (mostly automatic via the Card component swap, but audit for hard-coded `border-line` / `rounded-md`)

Skill check: BEFORE coding, run a sweep for hard-coded design tokens:
```bash
rg -n 'border-line|rounded-md\b|rounded-sm\b|bg-card\b|border-l-[24]' apps/web/app apps/web/components | wc -l
```
This baseline number tells you how many call sites you're changing. Expect 100-300.

## Status file

Append to `/root/workeros/.codex-logs/s43-design-system-rollout-status.md`.

## When done

PR URL + a contact sheet of screenshots: /, /workers, /workers/weekly_update, /runs, /runs/<id>, /connections, /settings, /workers/new at 1280×800 light theme. They should all read as the same product.

Plus: zero slop greps pass cleanly per the verification gate.

# Hover Contrast Fix — Light Mode (2026-06-05)

## Problem

In light mode, hovering over or focusing interactive elements in dropdown menus, select dropdowns, and similar components produced invisible text: dark text (#141414) on a dark background (#181818). the operator described it as "on day mode I hover on a button it turns black but text also black."

## Root Cause

Single CSS variable mismatch in `apps/web/app/globals.css` (`:root` block, light mode):

```
--accent-foreground: var(--ink);   /* was #141414 — dark text */
```

In light mode, `--accent = var(--primary) = #181818` (near-black). Any element using `focus:bg-accent focus:text-accent-foreground` therefore renders dark background + dark text.

In dark mode, `--accent` is the Floom blue hue (`oklch(0.72 0.14 250)`) so `--ink` (near-white) works correctly there. The bug only affects light mode.

## Offenders Found

All share `focus:bg-accent focus:text-accent-foreground`:

| File | Line | Element | Pattern |
|------|------|---------|---------|
| `components/ui/dropdown-menu.tsx` | 91 | `DropdownMenuItem` | `focus:bg-accent focus:text-accent-foreground` |
| `components/ui/dropdown-menu.tsx` | 116 | `DropdownMenuSubTrigger` | `focus:bg-accent focus:text-accent-foreground` + `data-popup-open:bg-accent data-open:bg-accent` |
| `components/ui/dropdown-menu.tsx` | 162 | `DropdownMenuCheckboxItem` | `focus:bg-accent focus:text-accent-foreground` |
| `components/ui/dropdown-menu.tsx` | 204 | `DropdownMenuRadioItem` | `focus:bg-accent focus:text-accent-foreground` |
| `components/ui/select.tsx` | 122 | `SelectItem` | `focus:bg-accent focus:text-accent-foreground` |

All five were broken via the same shared CSS variable. They are all fixed by the single one-line CSS change.

## Elements Confirmed Safe (No Bug)

- Nav items: `hover:bg-[var(--active-nav-bg)] hover:text-ink` — `--active-nav-bg = #F1EEE8` (warm light beige), safe.
- Sidebar "New worker" button: `hover:bg-[var(--solid-2)]` + `text-[var(--primary-text)]` — `--primary-text = #FFFFFF`, correctly paired.
- Row hovers (`hover:bg-[var(--active-nav-bg)]`): safe, light bg.
- `badge.tsx` primary: `bg-[var(--accent)] text-[var(--solid-fg)]` — explicitly pairs with `--solid-fg` (white), not `accent-foreground`. Safe.
- `button.tsx` default: `bg-[var(--accent)] text-[var(--solid-fg)]` — same, safe.

## Fix Applied

**File:** `apps/web/app/globals.css`, line 198 (`:root` block only, not `.dark`)

```diff
-  --accent-foreground: var(--ink);
+  /* fix(light-mode-hover): --accent is #181818 (near-black) in light mode, so
+     accent-foreground MUST be white (--solid-fg) for legible hover text on
+     focus:bg-accent in dropdown-menu, select, and similar interactive items.
+     Dark mode keeps --ink because --accent is the blue hue there. */
+  --accent-foreground: var(--solid-fg);
```

`--solid-fg = var(--primary-text) = #FFFFFF` in light mode — white text on near-black accent.
`--solid-fg = oklch(0.13 0.02 285)` in dark mode — but dark mode has its own `--accent-foreground: var(--ink)` (near-white) in the `.dark` block, unchanged.

## Before / After Screenshots

### Dropdown item hover — BEFORE (bug)

"Workspace actions" item: black text (#141414) on black background (#181818). Completely invisible.

Screenshot: `BEFORE-test.png` (captured 2026-06-05 at item focus via keyboard navigation in simulated pre-fix state)

### Dropdown item hover — AFTER (fixed)

"Workspace actions" item: white text on black background. Legible.

Screenshot: `AFTER-dropdown-focused-fix.png`

### Dark mode verification

Dark mode dropdown focus: blue accent background with dark text (correct, unchanged).

Screenshot: `DARKMODE-dropdown-workspace-actions.png`

Screenshots are in `/tmp/hover-screenshots/` (not committed — they are headless capture artifacts).

## Verification

```bash
# Light mode computed value (confirmed #fff in browser console):
getComputedStyle(document.documentElement).getPropertyValue('--accent-foreground').trim()
# → "#fff"  (after fix)

# Dark mode computed value (unchanged):
# → "lab(98.26% 0 0)"  (near-white, correct for blue accent background)
```

## Scope

One CSS variable. Zero component-level changes. Affects all five interactive list-item components simultaneously. Does not touch `apps/api`.

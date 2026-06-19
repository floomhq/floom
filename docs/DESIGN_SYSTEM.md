# Workeros Design System

> Source of truth for the visual system deployed at `localhost:3000`.
> Canonical tokens live in `apps/web/app/globals.css`.

---

## 1. Philosophy

**Warm OS — not glass, not visionOS, not AI-slop.**

Calm, deliberate, premium without being theatrical. Think Linear × Apple System Settings × a warm kitchen table. Matte surfaces, one accent hue per mode, generous radius, zero gratuitous blur or parallax.

**What this replaces:**
- The legacy pre-release design system (emerald green, glass refraction, aurora backgrounds, Bricolage Grotesque) is **archived**. Do not use it for any new Workeros surfaces.

---

## 2. Fonts

| Token | Stack | Use |
|---|---|---|
| `--font-sans` | `Geist Sans`, `-apple-system`, `BlinkMacSystemFont`, `system-ui`, sans-serif | All UI, headings, body |
| `--font-mono` | `Geist Mono`, `SF Mono`, `ui-monospace`, monospace | Code, run IDs, timestamps, CLI hints |

Loaded via `next/font` in `layout.tsx`. No network hop on render.

**Font features (applied globally):**
```css
--font-feat: "cv11" 1, "ss01" 1, "calt" 1;
```

**Do not use:** Bricolage Grotesque, Instrument Serif, JetBrains Mono for display, Inter as a webfont (Geist replaces all of these).

---

## 3. Color Tokens (Light Mode)

| Token | Value | Use |
|---|---|---|
| `--bg-app` | `#FAFAF7` | Page background (warm off-white) |
| `--bg-card` | `#FFFFFF` | Card / panel background |
| `--text-primary` | `#141414` | Primary text, headings |
| `--text-muted` | `#6B6861` | Secondary text, metadata, placeholders |
| `--border-default` | `#E7E0D6` | Default borders, dividers |
| `--border-soft` | `#E8E3DA` | Subtle borders, hover states |
| `--primary` | `#181818` | Primary CTA background (near-black) |
| `--primary-text` | `#FFFFFF` | Text on primary buttons |
| `--warning` | `#F9735B` | Errors, failing workers, disconnect |
| `--success` | `#2F8F5B` | Healthy status, positive indicators |
| `--pending` | `#E0B349` | Queued / waiting states |
| `--active-nav-bg` | `#F1EEE8` | Active sidebar item background |

### Derived aliases

| Token | Derivation | Use |
|---|---|---|
| `--bg` | `var(--bg-app)` | Shorthand |
| `--bg-2` | `#F1EEE8` | Sunken surfaces, secondary panels |
| `--bg-3` | `#EDE8DF` | Tertiary depth |
| `--paper` | `var(--bg-app)` | Shorthand |
| `--paper-2` | `#F4F1EA` | Secondary paper |
| `--ink` | `var(--text-primary)` | Shorthand |
| `--ink-soft` | `var(--text-muted)` | Shorthand |
| `--ink-mute` | `color-mix(in srgb, var(--text-muted) 80%, transparent)` | Hints |
| `--ink-faint` | `color-mix(in srgb, var(--text-muted) 58%, transparent)` | Very subtle text |
| `--line` | `var(--border-default)` | Shorthand |
| `--line-strong` | `#D8CFC2` | Stronger dividers |
| `--line-soft` | `var(--border-soft)` | Shorthand |
| `--hairline` | `0 0 0 1px var(--border-default)` | Box-shadow hairline |
| `--edge` | `none` | No edge treatment |
| `--focus` | `0 0 0 2px var(--paper), 0 0 0 4px var(--ink)` | Focus ring |
| `--glass-bg` | `var(--bg-card)` | Glass surface ground (opaque in light) |
| `--glass-bg-strong` | `var(--bg-card)` | Strong glass ground |
| `--glass-edge` | `var(--border-soft)` | Glass edge |

### Shadows (light)

| Token | Value |
|---|---|
| `--shadow-card` | `0 12px 30px rgba(0,0,0,0.04)` |
| `--shadow-sm` | `0 1px 2px hsl(0 0% 0% / 0.04), 0 0 0 1px var(--border-soft)` |
| `--shadow-md` | `var(--shadow-card)` |
| `--shadow-pop` | `0 16px 36px hsl(0 0% 0% / 0.10), 0 0 0 1px var(--border-default)` |
| `--shadow-btn` | `0 1px 0 hsl(0 0% 0% / 0.06)` |

### Radius aliases

| Token | Value | Use |
|---|---|---|
| `--r-xs` | `4px` | Tiny corners (rare) |
| `--r-sm` | `6px` | Small (deprecated, avoid) |
| `--r-md` | `8px` | Medium (deprecated, avoid) |
| `--r-lg` | `12px` | Large (deprecated, avoid) |
| `--r-xl` | `18px` | Extra large (deprecated, avoid) |
| `--r-2xl` | `18px` | Alias for cards |
| `--r-pill` | `999px` | Pill alias |

---

## 4. Color Tokens (Dark Mode)

**Matte dark — openchat-v2 palette.** Sidebar is the darkest surface. Pure white borders at low alpha.

| Token | Value | Use |
|---|---|---|
| `--bg` | `oklch(0.213 0 0)` | Page background (very dark grey, not pure black) |
| `--bg-2` | `oklch(0.27 0 0)` | Sunken surfaces |
| `--paper` | `oklch(0.213 0 0)` | Card ground |
| `--ink` | `oklch(0.985 0 0)` | Primary text (near-white) |
| `--ink-soft` | `oklch(0.75 0.015 286.067)` | Muted text |
| `--ink-mute` | `oklch(0.62 0.012 286.067)` | Hints, placeholders |
| `--accent` | `oklch(0.72 0.14 250)` | **Canonical Floom blue** — ONE blue only |
| `--accent-soft` | `color-mix(in srgb, var(--accent) 18%, transparent)` | Active nav bg, selection |
| `--accent-line` | `oklch(0.45 0.1 250)` | Focus rings, borders |
| `--solid` | `var(--accent)` | Primary CTA bg in dark |
| `--solid-fg` | `oklch(0.13 0.02 285)` | Text on solid buttons |
| `--success` | `oklch(0.7 0.16 152)` | Green (adjusted for dark) |
| `--warning` | `oklch(0.704 0.191 22.216)` | Error red |
| `--destructive` | `oklch(0.704 0.191 22.216)` | Destructive action color |
| `--line` | `hsl(0 0% 100% / 0.1)` | Borders |
| `--line-strong` | `hsl(0 0% 100% / 0.18)` | Stronger borders |
| `--line-soft` | `hsl(0 0% 100% / 0.06)` | Subtle borders |
| `--glass-bg` | `oklch(0.213 0 0)` | Glass surface (opaque in dark) |
| `--glass-bg-strong` | `oklch(0.213 0 0)` | Strong glass ground |
| `--glass-edge` | `hsl(0 0% 100% / 0.1)` | Glass edge |
| `--edge` | `none` | No edge treatment |
| `--hairline` | `0 0 0 1px var(--line)` | Box-shadow hairline |
| `--focus` | `0 0 0 2px var(--paper), 0 0 0 4px var(--ink)` | Focus ring |

### Shadows (dark)

| Token | Value |
|---|---|
| `--shadow-sm` | `0 1px 2px hsl(0 0% 0% / 0.3), 0 0 0 1px var(--line)` |
| `--shadow-md` | `0 4px 12px hsl(0 0% 0% / 0.4), 0 0 0 1px var(--line)` |
| `--shadow-pop` | `0 16px 36px hsl(0 0% 0% / 0.5), 0 0 0 1px var(--line)` |
| `--shadow-btn` | `0 1px 0 hsl(0 0% 0% / 0.4)` |
| `--shadow-card` | `var(--shadow-sm)` |

---

## 5. Radius Scale

**Three values only. No exceptions.**

| Token | Value | Use |
|---|---|---|
| `--radius-card` | `18px` | Cards, panels, popovers, modals |
| `--radius-button` | `12px` | Buttons, inputs, dropdowns, nav items |
| `--radius-pill` | `9999px` | Status pills, badges, count chips |
| `--radius-squircle` | `9px` | Small icon pills (WorkerIconPills), tool chips |
| `--radius-input` | `12px` | Text inputs (same as button) |

**Banned:** `rounded-md` (6px), `rounded-sm` (2px), `rounded-lg` (10px). Every rounded surface uses one of the tokens above.

---

## 6. Components

### Card

```css
[data-slot="card"] {
  background: var(--card-glass);
  border: 1px solid var(--card-border);
  border-radius: var(--radius-card);
  box-shadow: var(--card-shadow);
  /* Note: backdrop-filter is present in component CSS for compatibility,
     but tokens (--card-glass = opaque white/off-black) make the card matte.
     Do not add transparency to card backgrounds. */
}
```

- Light: `--card-glass` = `var(--bg-card)` = `#FFFFFF`
- Dark: `--card-glass` = `var(--paper)` = `oklch(0.213 0 0)`
- `--card-border` = `var(--border-default)` (light) / `var(--line)` (dark)
- `--card-shadow` = `var(--shadow-card)` (light) / `var(--shadow-sm)` (dark)
- White on warm cream in light mode.
- Slightly lighter than page bg in dark mode (matte, not glass).
- **No colored left borders.** Never. This is AI slop.
- **No warm-tint backgrounds on alert rows.** A warning row uses the same white card as every other row; only the warning icon is colored.

### Button

| Variant | Bg | Text | Border | Radius | Use |
|---|---|---|---|---|---|
| Primary (light) | `#181818` | `#FFFFFF` | none | `12px` | Top CTA (New worker, Run) |
| Primary (dark) | `var(--accent)` | `var(--solid-fg)` | none | `12px` | Top CTA |
| Secondary / Outline | transparent | `var(--text-primary)` | `1px solid var(--border-default)` | `12px` | Copy, Share, Cancel |
| Ghost | transparent | `var(--text-muted)` | none | `12px` | Tertiary actions |
| Destructive | `var(--warning)` at 10–20% alpha | `var(--warning)` | none | `12px` | Delete, Disconnect |

- All buttons: `min-height: 44px`.
- No blue primary in light mode. Light mode primary is near-black.
- Active state: `translateY(1px) scale(0.985)`.

### Sidebar / Navigation

- Background: `var(--bg-app)` (light), `var(--sidebar-glass)` which is `oklch(0.19 0 0)` (dark).
  - **Important:** Sidebar is the darkest surface in dark mode. the operator's explicit preference.
  - Dark sidebar shadow: `--sidebar-glass-shadow: 0 1px 0 hsl(0 0% 0% / 0.3)`
- Active item: bg `var(--active-nav-bg)`, radius `12px`.
  - Light: `--active-nav-bg` = `#F1EEE8`, `--active-nav-text` = `#111111`
  - Dark: `--active-nav-bg` = `color-mix(in srgb, var(--accent) 18%, transparent)`, `--active-nav-text` = `var(--accent)` — **same blue hue as the primary button, just at 18% opacity.**
- "+ New worker" button: bg `--primary` (light) / `--accent` (dark), white text, radius `12px`.

### Status Pills

| State | Light bg | Light text | Dark bg | Dark text |
|---|---|---|---|---|
| Connected / Active | `rgba(47,143,91,0.12)` | `#2F8F5B` | `oklch(0.3 0.04 152)` | `oklch(0.65 0.06 152)` |
| Expired / Failed | `rgba(249,115,91,0.12)` | `#F9735B` | derived from `--warning` | derived |
| Completed | same as Active | same | same | same |
| Queued | `rgba(224,179,73,0.12)` | `#B38B2A` | derived from `--pending` | derived |
| Running | same as Active | same | same | same |

- All pills: `radius: 9999px` (full pill).
- No dot-only indicators on worker cards. Use labelled pills everywhere.

### Inputs / Search

- bg: `var(--bg-card)`
- border: `1px solid var(--border-default)`
- radius: `var(--radius-button)` (12px)
- Placeholder text: `var(--text-muted)` at full token opacity.

### Terminal / Code blocks

- No special terminal palette. Code renders in `Geist Mono` with syntax highlighting.
- Light: standard GitHub-style highlighting.
- Dark: adjusted token colors (see `globals.css` lines 16–29).

---

## 7. Typography Scale

| Element | Size | Weight | Line-height | Notes |
|---|---|---|---|---|
| H1 (page title) | `20–24px` | `600` | `1.12` | Geist Sans, no letter-spacing |
| H2 (section) | `16–18px` | `600` | `1.12` | Geist Sans |
| H3 (card title) | `14–15px` | `500–600` | `1.3` | Geist Sans |
| Body | `14px` | `450` | `1.55` | Geist Sans base weight |
| Mono (code/ID) | `13px` | `400` | `1.7` | Geist Mono |
| Eyebrow / label | `11–12px` | `500` | `1.4` | Uppercase or small-caps, muted |

**No italic emphasis on headlines.** No serif display font. Geist Sans is used for everything.

---

## 8. Motion

| Token | Value |
|---|---|
| `--spring` | `cubic-bezier(0.32, 1.06, 0.5, 1)` |
| `--ease` | `cubic-bezier(0.22, 1, 0.36, 1)` |
| `--t-fast` | `110ms` |
| `--t-base` | `190ms` |
| `--t-slow` | `320ms` |

- Card hover: `translateY(-0.5px)` + slightly deeper shadow.
- Button hover: bg darkens / lightens, no scale transform.
- Button active: `translateY(1px) scale(0.985)`.
- No ambient animation (no floating chips, no bobbing mascots).
- Skeleton: `floom-shimmer` left-to-right sheen, 1.4s infinite.
- Focus ring: `0 0 0 2px var(--paper), 0 0 0 4px var(--ink)` (light) / equivalent in dark.

---

## 9. Backgrounds

### Light mode
Page bg is `#FAFAF7` warm off-white. Cards are pure white. No aurora, no blobs, no gradients.

### Dark mode
Page bg is `oklch(0.213 0 0)` — very dark grey. The sidebar is even darker: `oklch(0.19 0 0)`. Cards sit flat on the page with subtle borders. No blue glows, no ambient blobs (the `.spacebg` blobs are `display: none` in dark mode per S20).

A subtle grain overlay exists at 11% opacity (light) / 7% (dark), `mix-blend-mode: overlay` (light) / `soft-light` (dark).

---

## 10. Layout

- **Container max-width:** Fluid within a reasonable margin; cards define their own bounds.
- **Section padding:** Generous vertical spacing; no hard 8px grid enforcement.
- **Mobile:**
  - Sidebar collapses to hamburger.
  - Detail-page sub-nav must collapse to horizontal scroll-pills or segmented control. **Never** a fixed vertical column on mobile.
  - Touch targets: minimum 44×44px.

---

## 11. Anti-Patterns (NEVER ship)

1. ❌ **Colored left borders on cards** — this is AI slop. the operator's words: "red cards look like ai slop."
2. ❌ **Warm-tint backgrounds on warning rows** — no `bg-[rgba(249,115,91,0.04)]` on alert rows.
3. ❌ **Multiple blues in dark mode** — only ONE blue hue: `oklch(0.72 0.14 250)`.
4. ❌ **Blue primary buttons in light mode** — primary in light is `#181818` near-black.
5. ❌ `rounded-md` / `rounded-sm` — use the radius token scale.
6. ❌ **Purple/blue gradients, glass refraction, aurora blobs** — these belong to the old archived Floom system.
7. ❌ **Emerald green accent** — replaced by blue (dark) / black (light).
8. ❌ **Bricolage Grotesque, Instrument Serif, JetBrains Mono as display fonts** — archived. Use Geist Sans everywhere.
9. ❌ **Fake dashboards, fake charts, fake testimonials, fabricated counts**
10. ❌ **"Powered by AI" badges, sparkles, emojis**

---

## 12. Templates Page Requirement

Every worker surface needs a **Templates page** where users can:
- Browse a white/light collection grid
- Search templates
- Filter by category, tool, agent type
- See **real tool logos** (not text-in-circles) for each template
- See which tools each worker integrates with (Gmail, Notion, Linear, Slack, GitHub, etc.)

Template cards use the same card component as the rest of the app: white bg, 18px radius, `--shadow-card`, neutral borders.

---

## 13. File References

- **Canonical tokens:** `apps/web/app/globals.css`
- **Card component:** `apps/web/components/ui/card.tsx`
- **Button component:** `apps/web/components/ui/button.tsx`

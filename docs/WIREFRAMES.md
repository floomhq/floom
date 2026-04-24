# Wireframes → Routes — Canonical Mapping

**Source of truth.** When aligning any page to a v17 wireframe, use THIS table to find the right reference. Do not guess from filenames — the semantic route is what matters.

Federico's split:
- **`/me` = RUN** — where consumers go to use apps, see their runs, manage their keys. Lean consumer UX.
- **`/studio` = BUILD** — where creators go to publish, manage, monetize their apps. Creator UX.

---

## Mapping

| Wireframe | Canonical route | Purpose | Notes |
|---|---|---|---|
| `landing.html` | `/` | Public landing | — |
| `login.html` | `/login` | Sign-in | Redirects to `/waitlist` while `DEPLOY_ENABLED=false` |
| `pricing.html` | `/pricing` | Pricing | Current is BETTER than wireframe per 2026-04-24 audit (PR #721) |
| `store.html` | `/apps` | Public app directory | Current is BETTER than wireframe per audit (PR #720) |
| `docs.html` | `/docs` | Docs landing | Current is BETTER than wireframe per audit (no PR needed) |
| `app-page.html` | `/p/:slug` | Split-view run surface — idle state | Main variant |
| `app-page-input-mode.html` | `/p/:slug` | Split-view run surface — input-expanded mode | Variant |
| `use-app.html` | `/p/:slug` | Running + complete state | Variant — run-banner + stream-feed live here |
| `install-in-claude.html` | `/install/:slug` | Per-app install in Claude / Cursor | Deep-link from Share modal |
| `deploy-from-github.html` | `/studio/build` | Publish flow — paste GH URL, detect, preview, run, publish | |
| `me.html` | `/me` | User home dashboard | **Aspirational, current wireframe is "too techie and not consumer ready" per Federico 2026-04-24 — diverge toward consumer UX** |
| `me-apps.html` | `/me/apps` | Installed apps the user uses | Consumer view |
| `me-secrets.html` | `/me/secrets` | Secrets vault (user's BYOK keys) | Consumer view |
| `studio-home.html` | `/studio` | **Studio workspace home — creator landing** | **THIS is the right wireframe for `/studio`, NOT studio.html or studio-app.html** |
| `studio-my-apps.html` | `/studio/apps` | List of apps this creator has published | Sub-page |
| `studio-app.html` | `/studio/apps/:slug` | Per-app creator view (stats, edit, delete) | Sub-page, creator-scoped |
| `404.html` | `/404` | Not-found page | — |

## Wireframes that are NOT content pages

These exist at wireframes.floom.dev/v17/ but are either index/redirect files or design-system demos, not real routes:

| Wireframe | Why to ignore |
|---|---|
| `studio.html` | Generic "Floom wireframes" title, no H1 — index/redirect, NOT the `/studio` wireframe. **Use `studio-home.html` instead.** |
| `dashboard.html` | Same — index file, no content |

---

## Known drift from wireframes — deliberate (do NOT regress)

Before any parity agent runs, read these PRs for the explicit decisions:

### `/` landing
- `#662` worked example + anti-ICP + Discord CTA + photo slot
- `#669` Launch Week pill removed
- `#676` display font restored + margin
- `#689` hero state `use` → `run`
- `#696` batch cleanup (logo sizing, WebP, etc.)
- `#709` UX sweep (auto-https, PDF accept, mobile hero, etc.)

### `/pricing`
- `#701` CTA gated on `deployEnabled`, MIT-licensed copy removed
- `#709` H1 shortened to "Free. Your own key → unlimited."

### `/apps`
- `#651`/`#682` grid layout, auto-fill, 380px max track, no double border
- `#701` FRESH badge removed, SORT button hidden, icon tints unified

### `/docs`
- `#631` hub-and-spoke architecture, iconified hero cards
- `#695` canonical curl install URL: `/install.sh` (not `/install`)
- `#717` active sidebar item: background tint only, NO green left border (AI slop rule)

### `/p/:slug`
- `#703` 50/50 idle, 1:3 running/complete grid split
- `#719` browser chrome (traffic lights + dynamic URL pill)

### `/studio`
- `#718` matched `studio-my-apps.html` by mistake — needs rework to match `studio-home.html`

### `/me`
- `#648` Studio-tabbed dashboard (Overview/Apps/Runs/Secrets/Settings)
- Current me.html wireframe is too techie — target consumer-friendly UX

---

## Canonical rule for all future agents

1. Before aligning any page to a wireframe, check this doc for the right URL and the known-drift list.
2. Default to KEEP current code. Only change where the wireframe captures a genuine gap.
3. Produce a KEEP/MATCH/SKIP table in PR body — every section listed with a verdict.
4. For `/me` specifically: wireframe is aspirational reference, not spec. Diverge toward consumer UX.

See also:
- `/root/.claude/projects/-root/memory/feedback_parity_not_blind.md` — "informed gap-closing, not blind match"
- `/root/.claude/projects/-root/memory/feedback_agents_preserve_dont_wipe.md` — preserve Federico decisions

---

## `/me` Consumer Spec (2026-04-24)

Since `me.html` at wireframes.floom.dev was flagged by Federico as "too techie, not consumer ready", the canonical reference for `/me` is this text spec + the implementation in PR #732 when merged.

### Target user
Someone who RUNS apps, not someone who builds them. They don't care about avg run duration, 7-day statistics, workspace roles, or audit logs. They care about: "what apps have I used recently", "what were the results", "how do I manage my API keys if I add my own".

### Structure

1. **Hero.** H1 `Hey, {firstName}.` (or `Welcome back.` if no name). No sub-positioning line, no metrics strip, no Launch Week pill (this is post-auth).

2. **Your apps.** 3-col grid (stacks 1-col mobile) of up to 6 apps the user has actually RUN. Each card: app icon + name + "last run X ago" + one-click Re-run. "See all →" link to `/me/apps`. If user has never run anything: clean empty state `You haven't run anything yet. [Browse the store →]` button.

3. **Recent runs.** Compact table, 5 rows max. Columns: `App · Output preview · When`. Click row → opens the run permalink (`/r/<id>`). "See all →" to `/me/runs`.

4. **Settings row.** Small, de-emphasized, bottom of page. 3 text links: `API keys` (to `/me/secrets`), `Profile`, `Sign out`.

### Explicitly NOT on `/me`
- Workspace switcher (single-workspace launch scope; add when multi-workspace ships)
- Metrics dashboard (avg run duration, 7d counts, etc. — this is for /studio + power users)
- Pinned apps concept
- Discord CTA (belongs on landing, not post-auth)
- Tabs at top (single-page, flat scroll)

### Sub-routes
- `/me` → this consumer home
- `/me/apps` → full grid of apps user has run
- `/me/runs` → full run history table with filters
- `/me/secrets` → BYOK keys, minimal UI
- `/me/settings` → profile + logout

### Mobile
Stacks cleanly, no horizontal scroll. All text readable at 375w. Primary Re-run button tap-target ≥44px.

### When in doubt
Prefer clarity over density. Consumer users abandon dense UIs. Remove before you add.

---

End of WIREFRAMES.md

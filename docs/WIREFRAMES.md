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

# Per-route UX audit — `/studio/:slug` (Studio app overview)

**Route:** `/studio/:slug`  
**Component:** `StudioAppPage` (`apps/web/src/pages/StudioAppPage.tsx`)  
**Shell:** `StudioLayout` (`activeSubsection="overview"`)  
**ICP lens:** `docs/PRODUCT.md` — non-developer AI engineer needs hosted app, three surfaces (web form `/p/:slug`, MCP, HTTP), minimal infra vocabulary.  
**Checklist:** `~/.claude/skills/ui-audit/references/ux-review-checklist.md`  
**Audit mode:** Code-first (TSX + `StudioSidebar`); no live capture in this revision.

---

## Purpose & access

- **Intent:** Creator-owned view of a single app: identity, visibility control, optional primary-action pin, recent activity, destructive delete.
- **Gating:** `getApp(slug)` — **403** redirects to public permalink `/p/:slug` (not owner). **404** replaces history to `/studio?notice=app_not_found&slug=…`. Matches expectation that Studio is owner-only.

---

## Visibility (`manifest` + hub)

| Element | Behavior |
|--------|----------|
| Section title | “Visibility” (`sectionHeader` style). |
| Status pill | Shows **Public**, **Private**, or **Auth required** (`VisibilityPill`) — all three server states are readable. |
| Chooser | **Binary:** Public vs Private radios (`StudioVisibilityChooser`). If current mode is `auth-required`, copy explains that choosing Public or Private **replaces** bearer-token mode — honest for advanced users without exposing `auth-required` in the main UI. |
| Errors | `visibilityError` inline under the card (`studio-app-visibility-error`). |
| Loading | Optimistic toggle with `visibilityBusy` (opacity/wait cursor). |

**ICP fit:** Copy matches Store mental model (“Appears in the Store” / “Hidden from the Store”). Aligns with product’s public/private story; `auth-required` is acknowledged without forcing a three-way control in the 95% path (see file comment).

**Gap (minor):** Users landing with `auth-required` must read the footnote to understand replacement — acceptable; optional tooltip on the pill could reduce anxiety.

---

## CTAs & links (overview body)

| Control | Target | Role |
|---------|--------|------|
| **Open in Store →** | `/p/:slug` | Primary visual (`primaryCta`: ink fill). Drives users to the **web form** surface and live permalink. `data-testid="studio-app-open-store"`. |
| **Manage secrets** | `/studio/:slug/secrets` | Secondary outline. Direct path to credentials for hosted/proxied apps. |
| **View runs** | `/studio/:slug/runs` | Secondary outline. List/drilldown for run history in Studio. |

**Primary action:** No competing “Run here” button on this page — running happens on `/p/:slug`, which matches **hosting + web form** as the default surface in `docs/PRODUCT.md`.

**Sidebar:** For the active app, `StudioSidebar` `SubNav` repeats **Overview · Runs · Triggers · Secrets · Access · Renderer · Analytics** with `activeSubsection` highlighting Overview — redundant but reinforces wayfinding (`studio-subnav-*` test ids).

---

## Primary action (multi-action apps only)

- Rendered only when `Object.keys(app.manifest.actions).length > 1`.
- `<select>` maps to `manifest.primary_action` with “First action (default)” empty option; helper text ties outcome to **`/p/:slug`** (tab + “Primary” pill).
- Errors: `studio-app-primary-action-error`; busy state disables select.

**ICP fit:** Progressive disclosure — single-action apps see no noise.

---

## Recent runs

- Fetches up to **10** runs; table shows **first 5** columns: Started, Action, Status, Time.
- **Empty state:** “No runs yet” + suggestion to share `/p/:slug` — actionable, matches discovery path.
- **Overflow:** If more than 5 runs, **“View all runs →”** links to `/studio/:slug/runs`.
- **Row click:** Each row is a `Link` to **`/me/runs/:runId`**, not the Studio runs route.

**Friction (major for consistency):** Overview promotes Studio’s “View runs” (`/studio/.../runs`) but the **table rows** deep-link into **Me** run detail (`/me/runs/...`). Same run, two chrome families — aligns with launch doc **M3** (legacy vs Studio mental model). Consider unifying destination or labeling (“Open in Me” vs “Studio list”) if user testing shows confusion.

**Loading:** Recent runs can still say “Loading…” while app header is visible if `getAppRuns` is slower — minor layout stagger.

---

## Danger zone

- Typed slug confirmation modal (`studio-app-delete-*`), destructive styling, **Cancel** / **Delete forever**.
- Modal: `role="dialog"`, `aria-modal="true"`, confirm input `aria-label="Type app slug to confirm"`.
- Backdrop click closes when not deleting.

**ICP fit:** Strong guardrails; copy references `/p/:slug` and irreversibility.

---

## Errors & edge states

| State | UX |
|-------|-----|
| `getApp` failure (non-404/403) | Red banner `studio-app-error`. |
| Delete failure | Inline in modal `studio-app-delete-error`. |
| Runs fetch failure | Silently becomes empty list (`setRuns([])`). **Gap:** Owner may think there are no runs when the API failed — consider a muted error or retry. |

---

## Checklist snapshot (abbrev.)

| Area | Notes |
|------|--------|
| First 5s | Title `{name} · Studio` + `AppHeader` (icon, name, private badge, description) — clear “this is my app in Studio.” |
| Hierarchy | Primary CTA is Store; visibility and runs secondary; danger last. |
| Navigation | TopBar + sidebar subnav; no breadcrumbs in page body (relies on Studio chrome). |
| Interaction | Radios, select, links styled as buttons; delete confirm. |
| Copy | Plain language; `auth-required` explainer present. |
| Mobile | CTA row `flexWrap`; sidebar uses mobile drawer — overview content is single column. |
| A11y | Delete modal partially wired; run table header row is non-interactive grid — row links are keyboard reachable. |
| Performance | Skeleton `studio-app-loading` for app; runs section has text “Loading…” only. |

---

## Three surfaces (`docs/PRODUCT.md`)

- **Web form:** Strong — “Open in Store” is obvious.
- **MCP / HTTP:** Not surfaced on this overview. Creators discover those elsewhere (e.g. protocol, app detail elsewhere). **S3** if the goal is “each surface discoverable from Studio without reading `/protocol`” (see launch doc cross-screen table).

---

## Severity summary

| ID | Severity | Topic |
|----|----------|--------|
| R16-1 | S2 | Run table rows → `/me/runs/:id` while page pushes Studio “View runs” — split chrome / mental model. |
| R16-2 | S3 | `getAppRuns` failure silently shows empty runs — possible false “No runs yet.” |
| R16-3 | S3 | MCP/HTTP not linked from overview — discoverability of non-web surfaces. |
| — | — | Visibility + top CTAs + secrets/runs links are otherwise clear and ICP-aligned. |

---

## Weighted score (checklist dimensions)

Assumptions: flaws above; no automated visual verification.

| Dimension | Weight | Score (1–10) | Notes |
|-----------|--------|--------------|--------|
| Clarity | 25% | 8 | Strong header, visibility, CTAs; run row destination ambiguous. |
| Efficiency | 20% | 8 | Few clicks to Store, secrets, runs list; primary action hidden until needed. |
| Consistency | 15% | 6 | Studio vs `/me` on run rows. |
| Error handling | 15% | 7 | App errors good; runs fetch silent failure weak. |
| Mobile | 15% | 7 | Wrapping CTAs; relies on Studio mobile menu. |
| Delight | 10% | 7 | Optimistic visibility/primary updates feel responsive. |

**Approximate overall:** **7.4 / 10** (weighted).

---

## Code references

- Page: `apps/web/src/pages/StudioAppPage.tsx`
- Header: `AppHeader` from `apps/web/src/pages/MeAppPage.tsx`
- Shell / nav: `apps/web/src/components/studio/StudioLayout.tsx`, `StudioSidebar.tsx` (`SubNav`)

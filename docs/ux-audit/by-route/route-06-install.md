# Per-route UX audit — `/install` (`InstallPage`)

**Date:** 2026-04-20  
**Route:** `/install`  
**Component:** `apps/web/src/pages/InstallPage.tsx`  
**Shell:** `PageShell` (TopBar + footer + feedback; no `requireAuth`)  
**Checklist:** `~/.claude/skills/ui-audit/references/ux-review-checklist.md`  
**Product source:** `docs/PRODUCT.md`

---

## Audience: operator vs end user (per PRODUCT)

`docs/PRODUCT.md` draws a hard line: **host requirements** (`git`, `docker`, processes that clone and run repos) apply to the **machine that runs the Floom server** (operator / self-hoster / Floom cloud infra), **not** to people who only **use** hosted apps.

| Persona | What they “install” | Relation to `/install` |
|--------|----------------------|-------------------------|
| **End user** of a hosted app | Nothing. They use the **three surfaces** (web form `/p/:slug`, MCP, HTTP) exposed by Floom. | This page is **not** for them. If they land here from marketing, they may wrongly think they must clone GitHub to use someone else’s app. |
| **ICP** (paste repo → hosted on **cloud Floom**) | Ideally **no** local toolchain for the primary story: paste URL, Floom hosts. | `/install` describes **local** clone + `pnpm` + dev server — that is a **self-host / dev** path, not the default ICP journey. The page does not say that up front. |
| **Operator / self-hoster** | Runs Floom on their own metal: clone monorepo, install deps, run `@floom/server`. May need `git` + `docker` on that host per PRODUCT **host requirements**. | This is the **actual** audience for the steps on the page. Copy speaks to “run locally,” “publish from the terminal,” and “CI,” which fits operators more than passive app consumers. |

**Clarification for UX work:** Treat `/install` as **operator-oriented documentation** packaged as a marketing URL. It should explicitly **disambiguate** from (a) end-user “no install” surfaces and (b) **`/me/install`**, which is the authenticated **“Install to Claude Desktop”** MCP flow (`MeInstallPage`) — a different product moment entirely.

---

## First impressions (5-second test)

- **What is this page for?** Installing / running Floom from source locally, plus a minimal `curl` publish example.
- **Primary action:** There is no single CTA button; the implied action is **copy-paste terminal commands** (clone, `pnpm`, `curl`).
- **Attention:** H1 **“Install the Floom CLI”** dominates. The body immediately contradicts the word **CLI**: it states Floom ships as a **git-installable workspace** and that a **published npm CLI is on the roadmap**. Risk: users feel the page title is **ahead of the product** or misleading (stub honesty is in the body, not the headline).
- **Finished vs WIP:** Inline comment in source describes the route as a **public landing stub** to avoid 404s when linked from sitemap/wireframes; the experience reads as **honest but interim**.

---

## Information hierarchy

- Structure is clear: numbered steps, code blocks, then “Full docs” links.
- **Tension with PRODUCT:** Step **3** centers **OpenAPI → `POST /api/publish`**. In PRODUCT, that is deployment path **3** (“advanced”); path **1** is **repo → hosted**. A reader whose mental model is “ICP = paste GitHub URL” does not see that primary path on this page — only the OpenAPI publish flow.
- Secondary content (protocol, self-hosting anchor, GitHub) is appropriately grouped under “Full docs.”

---

## Navigation and wayfinding

- **Document title:** `Install the Floom CLI · Floom` (also set server-side for `/install` in `apps/server/src/index.ts` for SSR/meta consistency).
- **Where am I?** No breadcrumb; reliance on TopBar + H1. There is **no** `aria-current` or nav item for `/install` in `TopBar` in the current tree (desktop nav is Apps / Docs / conditional Me / Studio). **Discoverability** depends on deep links, sitemap, or future nav — not on primary chrome.
- **Escape hatches:** Links to `/protocol`, `/protocol#self-hosting`, and external GitHub are present; logo/home remains available via `PageShell`.
- **Name collision:** Two routes contain “install” in user-facing mental model: **`/install`** (this page) vs **`/me/install`** (Claude Desktop). The public page does not mention the dashboard route, so search and support may conflate them.

---

## Interaction design

- **No forms, no async loading** on this page — N/A for validation and loading states.
- **Code blocks:** `overflowX: 'auto'` on `<pre>` — horizontal scroll on small viewports is acceptable for commands; users can copy full lines.
- **Links:** Internal `Link` + external `a` with `rel="noreferrer"` — appropriate.

---

## Content and copy

- **Strengths:** Short paragraphs; acknowledges npm CLI is not shipped yet; gives concrete commands.
- **Gaps vs PRODUCT:**
  - Does not state that **end users never install** tooling to use hosted apps.
  - Does not label the page as **“Self-host”** or **“Run Floom locally”** so ICP cloud users can self-select out.
  - H1 **“CLI”** vs body **“no published npm CLI yet”** is the main copy tension.
- **Jargon:** `pnpm`, `POST /api/publish`, OpenAPI URL — appropriate for operator/dev audience; **too heavy** for the ICP who expected a one-click cloud path.

---

## Visual design

- Inline styles align with a minimal doc-like page: constrained width (720px), monospace blocks, token variables (`--surface-2`, `--muted`, `--accent`).
- Typography: H1 34px, H2 18px — hierarchy is readable.
- No decorative imagery; appropriate for a utilitarian install doc.

---

## Mobile experience

- Single column and padding `0 24px` support small screens.
- Code blocks may require horizontal scroll — mitigated by `overflow-x: auto`.
- Touch targets on inline links depend on line height; footer/TopBar handle primary navigation targets elsewhere.

---

## Edge cases and error states

- **No** empty, loading, or API error states — static page.
- **Long content:** Short enough that truncation is not an issue.

---

## Accessibility basics

- **Heading order:** H1 then H2s — logical.
- **Nested landmark:** `InstallPage` wraps content in `<main data-testid="install-page">` while `PageShell` already renders a `<main id="main">` wrapper. **Two `<main>` elements in one document** is invalid HTML and can confuse assistive tech (“which main is primary?”). Prefer a single landmark (e.g. `<section aria-labelledby=...>` inside the shell `main`).
- **Contrast:** Code block uses light text on dark background; verify against design tokens in production theme (not visually verified in this audit).

---

## Performance perception

- Static content; no client data fetching on this route — fast perceived load.

---

## Cross-route consistency

- Same `PageShell` + `Footer` pattern as other public doc-style pages.
- **Inconsistency with product story:** Marketing elsewhere emphasizes **paste repo / get off localhost**; this page doubles down on **local dev + OpenAPI publish** without framing it as secondary.

---

## Findings summary (severity)

| ID | Severity | Finding |
|----|----------|---------|
| F1 | **S2** | **Audience ambiguity:** Operator/self-host steps are presented without framing; ICP and end users are not told this is **not** the default “use Floom in production” path from PRODUCT. |
| F2 | **S2** | **Primary path mismatch:** Step 3 highlights **OpenAPI publish**; PRODUCT’s primary path is **repo → hosted**. Missing or de-emphasized relative to positioning. |
| F3 | **S3** | **H1 vs reality:** “Install the **CLI**” vs “no published npm CLI yet” — headline should match product state (e.g. “Run Floom locally” / “From source”) or the page risks credibility. |
| F4 | **S3** | **Wayfinding:** No TopBar entry for `/install`; reliance on indirect entry. |
| F5 | **S3** | **`/install` vs `/me/install`:** No cross-link or naming distinction for users conflating “install Floom” with “install to Claude Desktop.” |
| F6 | **S3** | **Landmark:** Nested `<main>` inside `PageShell`’s `<main>` — fix structure for valid semantics. |

*(Severity labels align with `docs/ux-audit/LAUNCH-UX-AUDIT-2026-04-20.md`: S1 critical, S2 major, S3 minor.)*

---

## Weighted UX score (checklist)

Assumptions: scored for the **intended** audience (operators/self-hosters); penalized for **ICP/end-user** confusion if they land here unintentionally.

| Dimension | Weight | Score (1–10) | Notes |
|-----------|--------|----------------|-------|
| Clarity | 25% | 6 | Steps are clear for devs; audience and “CLI” naming are muddy. |
| Efficiency | 20% | 7 | Few steps; copy-paste friendly. |
| Consistency | 15% | 6 | Matches stub doc pattern; drifts from PRODUCT’s primary onboarding story. |
| Error handling | 15% | 8 | N/A mostly; no failure modes on-page. |
| Mobile | 15% | 7 | Readable; code blocks scroll horizontally. |
| Delight | 10% | 5 | Functional, not memorable. |

**Approximate weighted overall:** **6.5 / 10** (drops if judged strictly as ICP onboarding — would be lower on Clarity and Consistency).

---

## Recommended backlog (this route only)

1. **Lead with audience** (one sentence): who this is for (self-host / local dev) vs who can ignore it (cloud-only creators; end users of apps).
2. **Rename or reframe H1** to match “from source” reality until a real CLI ships.
3. **Align step 3** with PRODUCT: add a pointer to **repo → hosted** as the primary Floom story, with OpenAPI publish as an explicit “alternative” path.
4. **Cross-link** `/me/install` with disambiguating labels (“Connect Claude Desktop”) vs this page (“Run the server locally”).
5. **Fix nested `<main>`** for accessibility.
6. **Optional:** Add `/install` to global nav or Docs hub if this route should be first-class.

---

## Code references

```24:97:apps/web/src/pages/InstallPage.tsx
export function InstallPage() {
  return (
    <PageShell title="Install the Floom CLI · Floom">
      <main
        data-testid="install-page"
        style={{ maxWidth: 720, margin: '40px auto', padding: '0 24px' }}
      >
        <h1 style={{ fontSize: 34, margin: '0 0 12px', lineHeight: 1.2 }}>
          Install the Floom CLI
        </h1>
        ...
```

```29:42:docs/PRODUCT.md
## Host requirements (operator-side, never user-side)

End users never install tooling. The `git` and `docker` binaries that the
repo→hosted path shells out to are required on the **machine that runs the
Floom server process**, not on any user's laptop.
```

```23:26:apps/web/src/main.tsx
// 2026-04-20 (PRR tail cleanup): public /install stub — separate from
// /me/install which is the authenticated "Install to Claude Desktop" flow.
```

---

## Appendix — related routes

| Route | Purpose |
|-------|---------|
| `/install` | Public: clone + run server + publish example (`InstallPage`). |
| `/me/install` | Authenticated: Claude Desktop / MCP install flow (`MeInstallPage`). |
| `/protocol`, `/protocol#self-hosting` | Linked from this page for protocol + Docker/env detail. |

# Per-route UX audit — `/studio/:slug/analytics`

| Field | Value |
|--------|--------|
| **Route** | `/studio/:slug/analytics` |
| **Component** | `StudioAppAnalyticsPage` (`apps/web/src/pages/StudioAppAnalyticsPage.tsx`) |
| **Shell** | `StudioLayout` (`activeSubsection="analytics"`) |
| **Auth** | Creator-gated via `StudioLayout` + `useSession` (cloud: redirect to `/login?next=…`) |
| **ICP reference** | `docs/PRODUCT.md` — non-developer AI engineer; hosting + three surfaces are core; Studio is creator tooling. |
| **Checklist** | `~/.claude/skills/ui-audit/references/ux-review-checklist.md` |
| **Capture** | Not run here (authenticated Studio route; code-first audit). |

## Executive summary

This route is an **intentional v1.1 stub**: it loads the app, shows `AppHeader`, a **“Coming v1.1”** badge, explanatory copy, and a **deterministic mock bar chart** (`aria-hidden`) so the layout does not read as a broken page. That matches the in-file product intent and supports trust more than a blank tab would.

Residual UX gaps are mostly **S3–S4**: no **inline navigation** to the Runs tab despite copy mentioning it, **no dedicated loading UI** for the `getApp` fetch (blank body until `app` resolves), **hardcoded error styling** vs design tokens, and **latency jargon** (p50 / p95) for an ICP that skews less infra-native.

| Level | Count | Notes |
|------|------:|------|
| **S1** Critical | 0 | Stub is explicit; no false “live metrics.” |
| **S2** Major | 0 | No creator dead-end on secrets/auth specific to this page. |
| **S3** Minor | 4 | Loading gap, CTA gap, copy/jargon, error styling consistency. |
| **S4** Cosmetic | 2 | Inline-only layout polish; chart purely decorative. |

---

## ICP and product fit (`docs/PRODUCT.md`)

- **Hosting-first ICP** is not blocked here: analytics is **future** tooling, not part of paste-repo → hosted.
- **Three surfaces** (web form, MCP, HTTP) are not surfaced on this page; that is acceptable for a **pre-release analytics** placeholder if Studio elsewhere covers surfaces (out of scope for this route-only audit).
- The stub **does not pretend** to ship real metrics — aligned with “do not mistake this for a bug” comment in source.

---

## Checklist walkthrough (`ux-review-checklist.md`)

### 1. First impressions

- **Purpose:** Clear within seconds: “Usage analytics” + “Coming v1.1” + dashed card reads as **planned feature**, not production dashboard.
- **Primary action:** None defined; copy defers to **Runs** for raw list but offers **no link or button** — weak completion of the mental model.
- **Attention:** Badge and heading compete appropriately; mock chart is subdued (`opacity: 0.6`).
- **WIP vs finished:** Reads as **credibly in progress**, not abandoned.

### 2. Information hierarchy

- **Prominence:** Badge → title → body → chart matches importance.
- **Labels:** “Usage analytics” matches sidebar **Analytics** (`StudioSidebar`).
- **Empty state:** N/A for metrics (stub). **Pre-data loading:** main column can appear **empty** until `app` loads (no skeleton).

### 3. Navigation and wayfinding

- **Where am I:** `StudioLayout` title (`… · Analytics · Studio`), sidebar `activeSubsection="analytics"`, `data-testid="studio-analytics-stub"`.
- **Back / escape:** Standard Studio chrome (sidebar, mobile drawer pattern in `StudioLayout`).
- **Discoverability:** Text says Runs has the list — **should be a direct link** to `/studio/:slug/runs` for efficiency.

### 4. Interaction design

- **No forms** on this page.
- **Async:** `getApp(slug)` — **no loading indicator** in `StudioAppAnalyticsPage` while `app === null` and no error.
- **Errors:** Non-404/403 failures show a red alert with **raw `err.message`** — may be engineer-facing (see §8).

### 5. Content and copy

- **Strengths:** Explains **what will ship** (runs/day, latency, errors, callers, actions) and **where to go today** (Runs) in prose.
- **Jargon risk:** “p50 / p95 latency” may land as infra-speak for part of the ICP; consider “typical vs slow requests” if copy is revised later.

### 6. Visual design

- **Card:** Uses `var(--card)`, `var(--line)`, `var(--accent)` — mostly on-token.
- **Error banner:** Hardcoded `#fdecea`, `#f4b7b1`, `#c2321f` — **off-pattern** vs CSS variables used elsewhere in the same file.

### 7. Mobile

- **Layout:** `maxWidth: 720` card is reasonable; relies on `StudioLayout` responsive sidebar behavior.
- **Touch:** No new small targets beyond shared shell; stub has no interactive controls.

### 8. Edge cases and error states

- **404:** `nav('/studio', { replace: true })`.
- **403:** `nav(\`/p/${slug}\`, { replace: true })`.
- **Other errors:** Message strip only; **no retry** CTA.
- **Missing slug:** `useEffect` no-ops; page may render shell with **no body content** for analytics block (edge).

### 9. Accessibility basics

- **Headings:** `AppHeader` supplies **`h1`** (app name); stub uses **`h2`** for “Usage analytics” — sensible order once app is loaded.
- **Mock chart:** `aria-hidden="true"` — correct so assistive tech does not announce fake time series.
- **Contrast:** Stub text uses theme variables; verify error banner contrast if that path is common.

### 10. Performance perception

- **Lightweight:** Static bars, no chart library — good for perceived speed.
- **Layout shift:** Possible when `app` arrives and `AppHeader` + card mount — minor.

---

## Findings (severity-ordered)

### S3 — M1: No loading state for app fetch

- **What:** While `getApp` is in flight, `error` is null and `app` is null, so **no stub, no header, no spinner** inside this page’s children.
- **Why it matters:** Creators on slower networks see an **empty content column** under Studio chrome — feels stalled rather than “light stub.”
- **Evidence:** Conditional render `{app && ( … )}` only.  
- **File:** `apps/web/src/pages/StudioAppAnalyticsPage.tsx` (return block).

### S3 — M2: Copy references Runs without a control

- **What:** Body says “Until then, the Runs tab has the raw list” but provides **no `Link` / button** to `/studio/:slug/runs`.
- **Why it matters:** Checklist “no dead ends” / efficiency — one click should complete the redirect the copy implies.
- **File:** Same, paragraph under “Usage analytics”.

### S3 — M3: Latency terminology vs ICP

- **What:** “p50 / p95 latency” in marketing-style stub copy.
- **Why it matters:** `docs/PRODUCT.md` ICP is not assumed to be infra-comfortable; some will know percentiles, some will not.
- **File:** Same, description `<p>`.

### S3 — M4: Generic error surface

- **What:** `(err as Error).message` surfaced directly; no “try again” or support path.
- **Why it matters:** Aligns with launch audit theme (**error taxonomy vs user language**) though lower severity on a stub page.
- **File:** Same, `catch` + error `<div>`.

### S4 — C1: Error colors vs design tokens

- **What:** Error container uses fixed hex colors instead of `var(--danger-…)` or shared alert pattern (if one exists elsewhere).
- **Why it matters:** Visual consistency across Studio pages.
- **File:** Same, `error &&` block styles.

### S4 — C2: Decorative chart opacity

- **What:** Whole chart row at `opacity: 0.6` — fine for “preview”; optional polish would be a subtle “Sample” caption for sighted users (chart is `aria-hidden`).

---

## Cross-screen consistency

- **Studio shell:** Same `StudioLayout` + sidebar active state as other `/studio/:slug/*` subpages — good.
- **Header reuse:** `AppHeader` from `MeAppPage` matches other studio app drilldowns — consistent creator context.
- **Stub pattern:** Similar “coming later” honesty is preferable to fake numbers; **keep** when real analytics ships behind feature flag.

---

## Weighted score (checklist rubric)

Flaws above counted before scoring. Stub pages are judged on **clarity and honesty**, not feature completeness.

| Dimension | Weight | Score (1–10) | Note |
|-----------|--------|--------------|------|
| Clarity | 25% | **9** | “Coming v1.1” + title + copy are very clear. |
| Efficiency | 20% | **6** | Missing Runs link and loading state. |
| Consistency | 15% | **7** | Mostly tokens; error box is an outlier. |
| Error handling | 15% | **6** | Redirects good; generic error strip. |
| Mobile | 15% | **8** | Inherits Studio; stub is simple. |
| Delight | 10% | **7** | Mock chart previews future value without lying. |

**Overall (weighted): ~7.5 / 10** — strong for a placeholder; small wayfinding and loading polish would round it out.

---

## Code references

```36:109:apps/web/src/pages/StudioAppAnalyticsPage.tsx
  return (
    <StudioLayout
      title={app ? `${app.name} · Analytics · Studio` : 'Analytics · Studio'}
      activeAppSlug={slug}
      activeSubsection="analytics"
    >
      {error && (
        <div
          style={{
            background: '#fdecea',
            // ...
          }}
        >
          {error}
        </div>
      )}
      {app && (
        <>
          <AppHeader app={app} />
          <div data-testid="studio-analytics-stub" /* ... */>
            {/* Coming v1.1 + copy + MockChart */}
          </div>
        </>
      )}
    </StudioLayout>
  );
```

```113:143:apps/web/src/pages/StudioAppAnalyticsPage.tsx
function MockChart() {
  const bars = [42, 58, 34, 71, 88, 63, 52, 79, 94, 68, 81, 90, 75, 86];
  const max = Math.max(...bars);
  return (
    <div aria-hidden="true" /* ... */>
      {bars.map((v, i) => (
        <div key={i} /* ... */ />
      ))}
    </div>
  );
}
```

---

## Suggested backlog (this route only)

1. Add **skeleton or inline spinner** for `app === null && !error` after slug present.  
2. Add **Link** “Open Runs” → `/studio/:slug/runs`.  
3. Soften or explain **p50 / p95** in copy for ICP.  
4. Align error banner with **shared alert / CSS variables** + optional **Retry** for transient failures.

No application code was changed in producing this document.

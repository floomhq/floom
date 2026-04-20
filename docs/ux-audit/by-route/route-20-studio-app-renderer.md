# Per-route UX audit — `/studio/:slug/renderer`

**Date:** 2026-04-20  
**Route:** `/studio/:slug/renderer`  
**Primary component:** `StudioAppRendererPage` (`apps/web/src/pages/StudioAppRendererPage.tsx`)  
**Central dependency:** `CustomRendererPanel` (`apps/web/src/components/CustomRendererPanel.tsx`)  
**Runtime host (out of scope for UI edits here, context only):** `CustomRendererHost` — load-bearing pipeline per `docs/PRODUCT.md` (renderer-bundler + panel + host).

**Checklist source:** `~/.claude/skills/ui-audit/references/ux-review-checklist.md`  
**ICP lens:** `docs/PRODUCT.md` — non-developer AI engineer; custom renderer is called out as a **P0 differentiator** vs “just an API gateway.” Copy and trust on this screen must match what the product actually does (sandboxed React bundle, not generic file upload).

**Capture note:** No screenshots attached; validate visually after `playwright install` if embedding captures into this series.

---

## Summary

| Level | Count | Notes |
|------|------:|------|
| **S1** Critical | 0 | No show-stopper security copy on this route alone; trust issues land in S2. |
| **S2** Major | 2 | Misleading page copy; Studio panel not wired to `app.renderer` like other surfaces. |
| **S3** Minor | 6 | Loading/empty main, duplicate headings, jargon, wayfinding to “try it,” a11y gaps. |
| **S4** Cosmetic | 2 | Stacked cards, mobile toggle glyph in parent shell. |

---

## Product alignment (`docs/PRODUCT.md`)

- Custom renderer path is **explicitly load-bearing**. This route is the **Studio** home for that capability (sidebar `Renderer` → `/studio/:slug/renderer`).
- Success for the ICP here means: **understand** what a renderer is, **see** whether one is live, **upload or change** TSX safely, **recover** from errors, and **connect** mentally to the web run surface where output appears.

---

## S2 — Major

### M1 — Intro copy says “HTML file”; implementation is React / TSX

- **Severity:** S2  
- **Category:** Content & copy / first impressions  
- **What:** `StudioAppRendererPage` helper text tells the user to “Upload **an HTML file**” that receives JSON in a sandboxed iframe. `CustomRendererPanel` and the compile API (`uploadRenderer`) are built around a **TSX/React default export** compiled with esbuild, not raw HTML upload.  
- **Why it matters:** For the ICP, this is a credibility hit on a **P0 differentiator** (`docs/PRODUCT.md`). They may prepare the wrong artifact, hit compile errors, and conclude Floom is “broken” or “for developers only.”  
- **Fix:** Align page-level copy with the panel and backend: **TSX (React component)**, limited imports, default export, fallback to default output panel on crash. Optionally one line on iframe sandbox without calling it “HTML file.”  
- **Files:** `apps/web/src/pages/StudioAppRendererPage.tsx` (intro `<p>`), cross-check `CustomRendererPanel.tsx` header copy.

### M2 — `CustomRendererPanel` is mounted **without** `initial={app.renderer}`

- **Severity:** S2  
- **Category:** Consistency / error states / information hierarchy  
- **What:** `StudioAppRendererPage` renders `<CustomRendererPanel slug={app.slug} />` only. `AppDetail` includes optional `renderer?: RendererMeta | null` from `GET /api/hub/:slug`. Elsewhere, `CreatorAppPage` loads `detail.renderer` and passes `initial={renderer}` so the pill, output shape, and remove affordance match server state.  
- **Why it matters:** A creator with an **already compiled** renderer sees “**Using default output panel**” and no “Remove renderer” until they recompile. `output_shape` may not match the server. Risk of **false “no custom renderer”** and unnecessary duplicate uploads / confusion during edits.  
- **Fix:** Pass `initial={app.renderer ?? null}` (and optionally `onChange` if parent needs to stay in sync after upload/delete). Matches the checklist items on **empty states**, **coming back after a week**, and **consistency** across screens.  
- **Files:** `StudioAppRendererPage.tsx`, compare `CreatorAppPage.tsx` (`CustomRendererPanel` usage).

---

## S3 — Minor

### m1 — Loading state: blank main until `getApp` resolves

- **What:** While `app` is `null` and there is no `error`, the layout renders but **no skeleton** and no “Loading…” in the main column—only title from `StudioLayout` updates when `app` arrives.  
- **Checklist:** Performance perception / edge cases.  
- **Files:** `StudioAppRendererPage.tsx`, patterns from other `StudioApp*` pages if any use skeletons.

### m2 — Duplicate “Custom renderer” title

- **What:** Page-level `<h2>Custom renderer</h2>` then `CustomRendererPanel` opens again with the same title in its own header.  
- **Checklist:** Information hierarchy.  
- **Fix:** Drop redundant heading or demote one to visually subordinate helper only.

### m3 — Internal jargon in the intro (“renderer cascade”, component names)

- **What:** “Overrides the automatic renderer cascade (Markdown / TextBig / CodeBlock / FileDownload)” uses **internal** renderer ids.  
- **Why it matters:** ICP may not map those strings to “how my answer looks today.”  
- **Fix:** User-facing phrasing, e.g. “Replaces Floom’s automatic formatting for your run result.”

### m4 — No obvious next step to **see** the renderer in context

- **What:** After compile, there is no CTA to “Open run” / “Preview on `/p/:slug`” from this page. The checklist’s **user flow** and **no dead ends** favor a single next action.  
- **Fix:** Link to `/studio/:slug` overview or `/p/:slug` (and/or documented primary run path) with microcopy “Try a run to preview output.”

### m5 — `CustomRendererPanel`: accessibility gaps vs checklist §9

- **What:** File control is a styled `<label>` without tying `<label htmlFor>` to `id` on hidden `<input>`. “Output shape” uses a nearby text node, not `<label htmlFor=…>` for the `<select>`. Textarea has no `aria-label` / associated label element.  
- **Checklist:** Form inputs have labels; keyboard/focus.  
- **Files:** `CustomRendererPanel.tsx` (shared with `/build`, `/creator/:slug`).

### m6 — `confirm()` for remove is acceptable but bare

- **What:** Native confirm is consistent and meets “destructive actions require confirmation,” but offers no short explanation of impact (bundle removed, runs fall back to default panel). Low severity polish.

---

## S4 — Cosmetic

- **Nested card:** Outer `StudioAppRendererPage` card wraps `CustomRendererPanel`, which is already a dense block—slight visual heaviness; optional flattening.  
- **Studio shell:** `StudioLayout` mobile menu button uses a literal menu character (see `StudioLayout.tsx`); unrelated to this route’s logic but visible here.

---

## Checklist pass (condensed)

| Section | Result |
|--------|--------|
| 1. First impressions | **Mixed:** purpose clear from sidebar + title; **HTML** copy wrong (M1). |
| 2. Information hierarchy | **Weakened** by duplicate heading (m2) and wrong status when renderer exists (M2). |
| 3. Navigation & wayfinding | **Strong** via `StudioSidebar` `activeSubsection="renderer"`; add run/preview link (m4). |
| 4. Interaction design | Busy/disable on compile/remove present; file size cap feedback good; **initial state** wrong (M2). |
| 5. Content & copy | **HTML vs TSX** (M1); jargon (m3). |
| 6. Visual design | Inline styles consistent with Studio; nested card (S4). |
| 7. Mobile | Sidebar drawer pattern applies; textarea tall enough; verify touch targets on primary buttons (< 44px possible—spot-check). |
| 8. Edge cases | 404 → `/studio`, 403 → `/p/:slug`; generic `setError` for other failures—acceptable; **loading** thin (m1). |
| 9. Accessibility | Panel label/for gaps (m5). |
| 10. Performance perception | No layout shift beyond content pop-in; compile spinner via button label. |

---

## Cross-screen consistency

- **`CreatorAppPage` / `BuildPage`:** Both use `CustomRendererPanel` with patterns that respect server renderer metadata where applicable (`CreatorAppPage` passes `initial`). **Studio should match** to avoid two truths.  
- **`AppHeader`:** Shared with `/me` overview; fine for identity, but this page has **no tab bar**—navigation is entirely **Studio sidebar** (consistent with other Studio drilldowns).

---

## Weighted scorecard (checklist weights)

Assumptions: flaws above included before scoring; **1 = poor, 10 = excellent**.

| Dimension | Weight | Score | Note |
|-----------|--------|------:|------|
| Clarity | 25% | **5** | HTML mismatch hurts; jargon secondary. |
| Efficiency | 20% | **6** | Few steps, but wrong initial state wastes time. |
| Consistency | 15% | **5** | Diverges from `CreatorAppPage` wiring. |
| Error handling | 15% | **7** | Panel errors + page-level fetch errors present. |
| Mobile | 15% | **6** | Inherits Studio shell; not re-audited with captures. |
| Delight | 10% | **5** | Compile pill is nice when accurate; starter template is helpful. |

**Approximate overall:** \(0.25×5 + 0.2×6 + 0.15×5 + 0.15×7 + 0.15×6 + 0.1×5\) ≈ **5.8 / 10**

---

## Suggested backlog (this route only)

1. Fix **M1** (copy: TSX/React, not HTML).  
2. Fix **M2** (`initial={app.renderer ?? null}`).  
3. Add **loading** affordance (m1) and **preview run** link (m4).  
4. Tighten **intro** jargon (m3) and **duplicate heading** (m2).  
5. Panel **a11y** labels (m5) as a shared fix across all `CustomRendererPanel` embeds.

---

## Code references

```37:98:apps/web/src/pages/StudioAppRendererPage.tsx
  return (
    <StudioLayout
      title={app ? `${app.name} · Renderer · Studio` : 'Renderer · Studio'}
      activeAppSlug={slug}
      activeSubsection="renderer"
    >
      {error && (
        <div
          style={{
            background: '#fdecea',
            ...
          }}
        >
          {error}
        </div>
      )}
      {app && (
        <>
          <AppHeader app={app} />
          <h2 ...>Custom renderer</h2>
          <p ...>
            Upload an HTML file that receives your action's JSON output via
            a sandboxed iframe. Overrides the automatic renderer cascade
            (Markdown / TextBig / CodeBlock / FileDownload).
          </p>
          <div style={{ ... }}>
            <CustomRendererPanel slug={app.slug} />
          </div>
        </>
      )}
    </StudioLayout>
  );
```

```65:75:apps/web/src/components/CustomRendererPanel.tsx
export function CustomRendererPanel({ slug, initial, onChange }: Props) {
  const [source, setSource] = useState<string>(STARTER_TEMPLATE);
  const [outputShape, setOutputShape] = useState<string>(initial?.output_shape || 'object');
  const [meta, setMeta] = useState<RendererMeta | null>(initial ?? null);
  ...
  useEffect(() => {
    setMeta(initial ?? null);
    if (initial?.output_shape) setOutputShape(initial.output_shape);
  }, [initial]);
```

```199:210:apps/web/src/pages/CreatorAppPage.tsx
        {!notOwner && slug && (
          <div style={{ ... }}>
            <CustomRendererPanel slug={slug} initial={renderer} onChange={setRenderer} />
          </div>
        )}
```

```175:181:apps/web/src/lib/types.ts
  /**
   * W2.2 custom renderer. Populated when the creator has uploaded a
   * TSX renderer (see POST /api/hub/:slug/renderer). When present, the
   * web client lazy-loads /renderer/:slug/bundle.js and mounts its
   * default export instead of the default OutputPanel.
   */
  renderer?: RendererMeta | null;
```

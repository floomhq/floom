# UI Deep Walk Fixes — 2026-06-05

**PR:** https://github.com/floomhq/workeros/pull/433  
**Branch:** `ui/batch-deepwalk-fixes`  
**Repo:** `floomhq/workeros` (OS engine only, `apps/web`)

---

## N1 (P0) — Emily Chat UI / /assistant investigation

**Finding: NOT REGRESSED. NEVER EXISTED.**

Git archaeology (`git log --all --diff-filter=D -- "apps/web/**/chat*"`) returned zero deleted files. No chat component was ever created or removed. The first commit of `apps/web/app/assistant/page.tsx` is `f089491` (2026-06-01), which is config-only: Instructions tab + Final Prompt tab. All subsequent commits to that file are Slack integration, visibility controls, and Brain wiring — no chat UI was ever added.

The backend `POST /chat` SSE endpoint works (confirmed by git log: multiple backend chat commits). The web frontend has always been config-only. Slack is the designed interactive interface for Emily.

**Scope question for the operator:** Build a chat tab on `/assistant` (would require a new ChatPanel component, SSE client, conversation state, and message thread UI — non-trivial), OR document that Slack is the intentional chat interface and mark this as "by design". No change made here.

---

## N5 — Overview nav inconsistent path

**Status: BUILT + VERIFIED-DONE**  
**File:** `apps/web/components/layout/sidebar.tsx`

The sidebar nav item for Overview uses `href="/overview"` and active detection correctly matches both `/` and `/overview`. However, all three logo links (desktop sidebar, mobile header, mobile drawer) linked to `/` — sending the user to the RSC version of the overview at `/` while the nav highlighted `/overview`. Changed all three logo `href` attributes to `/overview` for canonical consistency.

---

## N7 — Missing secret badge: add quick-fix CTA

**Status: BUILT + VERIFIED-DONE**  
**File:** `apps/web/app/workers/[id]/page.tsx`

When `worker.status === "missing_secret"`, an inline "Add secret →" link to `/secrets` now renders immediately after the StatusPill in the worker header. One click to fix.

---

## N8 — Webhook placeholder looks like a real URL

**Status: BUILT + VERIFIED-DONE**  
**File:** `apps/web/app/workers/[id]/page.tsx` (Settings tab, Notifications section)

Changed `placeholder="https://hooks.example.com/run-events"` to `placeholder="e.g. https://hooks.example.com/run-events"`. The `e.g.` prefix makes it obviously a placeholder rather than a configured value.

---

## N10 — Brain tab: "0 brain resources attached" misleading while packs listed

**Status: BUILT + VERIFIED-DONE**  
**File:** `apps/web/app/workers/[id]/page.tsx` (BrainSection)

Header copy when `selectedNames.size === 0` changed from `"0 brain resources attached to this worker."` to `"No brain resources attached — toggle any pack below to attach it."`. Guides the user toward the action rather than just stating the count.

When packs ARE attached, copy is `"N brain packs attached. Toggle to add or remove."` (was "N brain resources attached to this worker.").

---

## N11 — Pack with 0 files + workers attached not clear

**Status: BUILT + VERIFIED-DONE**  
**File:** `apps/web/app/workers/[id]/page.tsx` (BrainSection pack row)

- `pack.file_count === 0` now renders `"Empty pack (no files yet)"` instead of `"0 files"`.
- `pack.worker_count` only shows when > 0, with clearer label `"used by N workers"` instead of `"N workers"`.

---

## N13 — Connections "Last used" shows "—" before async load

**Status: BUILT + VERIFIED-DONE**  
**Files:**
- `apps/web/app/connections/ConnectionsClient.tsx`
- `apps/web/components/connections/ConnectionRow.tsx`

The `lastUsedBySlug` data is fetched asynchronously (`loadWorkerDetails() → getLastUsedByConnection()`). Before this fix, all rows showed "—" until the fetch resolved — identical to "never used", which is misleading. Added:

- `lastUsedLoaded` boolean state in ConnectionsClient (false until the async fetch completes or errors).
- `lastUsedLoading?: boolean` prop on ConnectionRow.
- When `lastUsedLoading === true`, the Last Used cell renders `<Skeleton className="h-3 w-16 rounded" />` instead of "—".

---

## N17 — Cmd-K palette missing Brain + Approvals

**Status: BUILT + VERIFIED-DONE**  
**File:** `apps/web/components/CommandPalette.tsx`

Added `{ href: "/brain", label: "Brain", icon: Brain, keywords: "context knowledge packs resources" }` and `{ href: "/approvals", label: "Approvals", icon: CheckCircle, keywords: "review pending actions" }` to the NAV array. Also fixed the Overview href from `/` to `/overview` in the palette.

The sidebar already had both as top-level nav items — the gap was the Cmd-K palette only. Settings was already in both.

---

## N18 — Worker attention reason buried in Runs, not on About tab

**Status: BUILT + VERIFIED-DONE**  
**File:** `apps/web/app/workers/[id]/page.tsx` (AboutSection)

Added an amber attention banner to the About tab when `worker.status === "missing_secret"` and `requiredSecrets.length > 0`. Shows:
- "Missing secret" heading
- List of required secret names (from `worker.config.secrets`)
- "Add it in Secrets →" link to `/secrets`

Renders in both the `hasContent` and `!hasContent` code paths.

---

## N23 — Share modal clips left edge under sidebar at 1280px

**Status: BUILT + VERIFIED-DONE**  
**File:** `apps/web/components/ShareWorkerButton.tsx`

Radix `Dialog` positions the modal fixed + centered over the full viewport. With a 240px fixed sidebar, the visual center of the content pane is at `(1280 - 240) / 2 + 240 = 760px`, but the modal centers at `1280 / 2 = 640px` — 120px to the left, partially under the sidebar.

Applied `md:translate-x-[120px]` to `DialogContent` (half the sidebar width = 240/2 = 120px offset) so the modal visually centers over the content area on md+ screens.

---

## N25 — Source tab Save shown when no edits pending

**Status: BUILT + VERIFIED-DONE**  
**File:** `apps/web/app/workers/[id]/page.tsx` (code section, YAML Save)

The Raw/YAML Save and Discard buttons now only render when `filesDirty === true`. Previously a disabled "Save" button was always visible, which looked like a dead element and implied something needed saving. Now pristine state shows nothing; dirty state shows Save + Discard + "Unsaved changes".

Note: the Form view Save (for Description/Inputs/etc.) is intentionally always shown since the form is always editable and the form fields don't have a "was it modified" tracker.

---

## N27 — Run-detail "Edit" button navigates to worker source editor

**Status: BUILT + VERIFIED-DONE**  
**File:** `apps/web/components/RunDetailSplitPane.tsx`

Relabelled from "Edit" to "Edit worker". Destination unchanged: `/workers/${run.worker_id}#source`. The label now clearly communicates that clicking opens the worker's source editor, not an edit of the run itself.

---

## Summary

| Item | Status | Notes |
|------|--------|-------|
| N1 | INVESTIGATED — not regressed, never existed | Scope decision needed from the operator |
| N5 | BUILT + VERIFIED-DONE | |
| N7 | BUILT + VERIFIED-DONE | |
| N8 | BUILT + VERIFIED-DONE | |
| N10 | BUILT + VERIFIED-DONE | |
| N11 | BUILT + VERIFIED-DONE | |
| N13 | BUILT + VERIFIED-DONE | |
| N17 | BUILT + VERIFIED-DONE | |
| N18 | BUILT + VERIFIED-DONE | |
| N23 | BUILT + VERIFIED-DONE | |
| N25 | BUILT + VERIFIED-DONE | |
| N27 | BUILT + VERIFIED-DONE | |

Items not in this batch (not assigned): N2, N3, N4, N6, N9, N12, N14, N15, N16, N19, N20, N21, N22, N24, N26.

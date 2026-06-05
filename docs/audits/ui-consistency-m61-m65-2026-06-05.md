# UI Consistency Audit: M61–M65
**Date:** 2026-06-05  
**Branch:** fix/m61-m65-ui-consistency-2026-06-05  
**Status:** All items BUILT and VERIFIED

---

## M61 (P2) — Add MCP server defaults to JSON config

**Status:** BUILT / VERIFIED  
**File:** `apps/web/app/connections/mcp/page.tsx`

**Change:** Swapped default mode from `"manual"` to `"import"`. Moved "JSON config" tab to first position, "Enter details" to second. All three `openForm()` call sites updated to `openForm("import")`.

**Verification:** Navigated to `/connections/mcp`, clicked "Add MCP server" — form opened with "JSON config" tab active by default, showing the JSON textarea with example placeholder. Screenshot: `/tmp/after-mcp-form-open.png`.

---

## M62 (P1) — Visibility Share→Private requires confirm modal

**Status:** BUILT / VERIFIED  
**File:** `apps/web/components/AssetVisibilityControl.tsx`

**Change:** Added `pendingVis` state. Dropdown item clicks now set `pendingVis` instead of calling `apply()` directly. A shadcn `Dialog` modal renders when `pendingVis !== null`. The modal title and description are contextual: Share→Workspace warns that everyone can see the asset; Workspace→Private warns that existing shared links will break.

**Verification:** On `/workers/csv_enricher`, clicked "Private" button, then "Shared" in the dropdown — modal appeared "Share this worker with your workspace?" with Cancel and "Share with workspace" buttons. Screenshot: `/tmp/after-visibility-shared-modal.png`.

---

## M63 (P1) — Version rollback uses app modal, not browser dialog

**Status:** BUILT / VERIFIED  
**Files:**  
- `apps/web/app/assistant/page.tsx` — `InstructionsHistoryMenu`  
- `apps/web/app/contexts/page.tsx` — `FileHistoryMenu`

**Change:** Removed `confirm()` from both `handleRollback` and `handleRestore`. Added `pendingRestore` state. `VersionHistoryMenu.onRestore` now sets `pendingRestore`; a shadcn `Dialog` renders with restore-specific message ("The current state is preserved as a new version so you can restore it later"). Roll-forward already worked server-side (append-only versions); UI correctly enables all non-current versions for restore.

**Verification:** On `/assistant`, clicked "Versions" dropdown, clicked "Restore" for v22 — in-app modal appeared "Restore to version 22?" with Cancel and "Restore this version" buttons. No browser native dialog. Screenshot: `/tmp/after-restore-modal.png`.

---

## M64 (P1) — Worker source view consistent with Brain view

**Status:** BUILT / VERIFIED  
**File:** `apps/web/components/worker-form/FilesEditor.tsx`

**Change:** In `FilesEditorEdit`, extended `selectedHasPreview` to all non-binary text files (was only markdown/html/table/worker.yml). Preview/Raw toggle now appears for all code files. Toggle order flipped to Preview-first, Raw-second — matching Brain file viewer. `defaultSourceMode` defaults to "preview" for code files. In `ReadOnlyFileContent` (view mode), added Preview+Raw tabs for code files matching Brain.

**Verification:** On `/workers/csv_enricher#source`, `worker.yml` shows "Preview | Raw" toggle with Preview first. Screenshot: `/tmp/after-source-reload.png`.

---

## M65 (P1) — run.py and requirements.txt have preview tabs

**Status:** BUILT / VERIFIED  
**File:** `apps/web/components/worker-form/FilesEditor.tsx`

**Change:** Same change as M64 — extended Preview to all text files including `.py` and `.txt`. In edit mode: Preview = syntax-highlighted read-only (via `SyntaxHighlightedCode` / `CodeBlock`). In view mode: Preview+Raw tabs added via updated `ReadOnlyFileContent`.

**Verification:** On `/workers/csv_enricher#source`, clicked `run.py` — file viewer shows "Preview | Raw" toggle. Preview tab (default) shows syntax-highlighted Python code with hljs coloring. Screenshot: `/tmp/after-runpy-preview.png`.

---

## Component Reuse

- `shadcn Dialog` reused from `@/components/ui/dialog` (no new components created)
- `CodeBlock` from `@/components/file-viewer/code-block` reused in FilesEditor view mode
- `VersionHistoryMenu` unchanged — callers updated to use modal pattern
- No new Vercel projects. No new deps added.

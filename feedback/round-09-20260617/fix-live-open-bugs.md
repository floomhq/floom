# Round-09 — Fix live-OPEN bugs (B10, B4, B11, B6)

**Branch:** `fix/live-open-bugs-r9`
**Base:** `origin/integration/final-r9-merged` @ `e02b5bb4`
**Last code SHA:** `e6f2f6d9511cbb1b5798ec61899aaf1b957996f1` (all four fixes land here; the branch head adds only this deliverable doc on top).
**Repo:** `floomhq/workeros` (engine change flows to `workeros-cloud` via submodule bump — see B10).
**Method:** TDD (failing test first) per fix. NOT merged to main/trunk/prod.

| Commit | Fix | Files |
|--------|-----|-------|
| `ffb614de` | B10 | `apps/api/main.py`, `apps/api/tests/test_request_body_size_middleware.py` |
| `1607c967` | B11 + B6 | `apps/web/app/contexts/page.tsx`, `apps/web/tests/contexts-dropzone-r9.dom.test.tsx` |
| `e6f2f6d9` | B4 | `apps/web/components/worker/WorkerToolsEditor.tsx`, `apps/web/app/workers/WorkersCollection.tsx`, `apps/web/tests/worker-tools-editor-b4.dom.test.tsx`, `apps/web/tests/worker-config-editors.dom.test.tsx` |

---

## B10 (P0) — 1 MB upload → 413

### Failing test → fix
- **RED first:** added two tests to `apps/api/tests/test_request_body_size_middleware.py`:
  - `test_body_limit_helpers_are_mount_prefix_agnostic` — asserts `_body_limit_for_request` / `_is_context_upload_request` return the SAME classification for the bare path and the `/api`-mounted form (scope `path='/api/...'` + `root_path='/api'`), across contexts upload, approval uploads, from-bundle, workspace import, PUT files, and a non-exempt JSON path; plus an over-strip guard (`/apiary` must NOT be normalized).
  - `test_api_mounted_context_upload_not_413_for_one_mb` — mounts `main.app` under `/api` (the cloud shape), posts a ~1 MB authed multipart to `/api/contexts/test/upload`, asserts `status != 413`.
  - Both RED on base: helpers matched only the un-prefixed path; the integration test 413'd (reproduced the exact live failure once the auth header was added — auth runs before body-size, so an unauthed request short-circuits at 401, which is why an authed request is required to exercise the body-size middleware).
- **Fix:** new `_normalized_request_path(request)` strips a single leading ASGI mount prefix (`scope["root_path"]`, `rstrip("/")`, boundary-checked) from `scope["path"]`, returning the route-local path. Both `_body_limit_for_request` and `_is_context_upload_request` now classify on the normalized path.
- **GREEN:** 5/5 in the file pass (2 new + 3 pre-existing).

### file:line
- `apps/api/main.py` — new `_normalized_request_path` (inserted before `_body_limit_for_request`); `_body_limit_for_request` and `_is_context_upload_request` now call it instead of reading `request.url.path` directly.
- Root cause confirmed against ISSUES.md: cloud mounts engine under `/api` (`workeros-cloud/apps/api/main.py:1179`); engine middleware read the prefixed path; exemptions matched route-local paths → contexts/approvals uploads fell to `DEFAULT_JSON_BODY_LIMIT_BYTES = 256 KB` (`core/config.py:53`).

### Codex's B10 verdict (consulted, `model_reasoning_effort=high`)
> **Use Option A** (strip `scope["root_path"]`, NOT hardcode `/api`), **with one refinement: normalize `request.scope["path"]`, not `request.url.path`.**
> - `root_path` is the canonical ASGI/Starlette mount prefix; hardcoding `/api` fixes only this deployment.
> - `Mount` accumulates mount prefixes into `scope["root_path"]`, so double-mount works (`/outer/api/...` with `root_path="/outer/api"` → `/contexts/...`).
> - Empty `root_path`: no-op. Not-a-prefix: no-op (conservative). Trailing slash: handled by `rstrip("/")`. Already-stripped: no prefix match → no double-strip.
> - Boundary check `path == root_path or path.startswith(root_path + "/")` avoids stripping `/api` from `/apiary/...`.
> - Verified by inspecting Starlette source: `Request.url.path` is derived from `scope["path"]`; `Mount` sets `scope["root_path"]` for the child app.

Implemented exactly as Codex specified (scope path + root_path strip + boundary guard). The over-strip guard is covered by the `/apiary` assertion.

### Submodule note
Engine-only code change. It reaches the cloud via the `engine` submodule bump in `workeros-cloud` (per the WORKEROS SYNC RULE — never patch `engine/` locally). After this branch merges to the engine line, bump the cloud submodule to the merged SHA and redeploy Railway to ship the cloud fix.

### Test/build delta
- `apps/api`: `test_request_body_size_middleware.py` 5/5 pass; `test_contexts_system_packs.py` also green (17 passed total in the combined run). No `next build` (Python engine).

---

## B11 + B6 — drag-drop drop-zone

### Failing test → fix
- **RED first:** `apps/web/tests/contexts-dropzone-r9.dom.test.tsx` (6 tests). On base: 4 RED (pane still carried `bg-muted/30`; no `data-dropzone` box; `ContextEmptyState` didn't exist), 2 incidentally passed.
- **Fix:**
  - New shared `DropZoneOverlay` (one bounded **dashed rounded box**, `border-2 border-dashed`, accent on drag) reused by the file-open pane and `PackDetailPane`.
  - New exported `ContextEmptyState` — the empty Library pane now renders a **persistent dashed drop-zone box** (the missing B6 affordance) wired together with "New folder", highlighting on drag.
  - Removed `bg-muted/30` whole-pane wash from all three drop targets.
- **GREEN:** 6/6 pass.

### file:line (`apps/web/app/contexts/page.tsx`)
- Removed `bg-muted/30` at the three sections (was lines 924, 1007, 1335).
- Replaced the empty-state block (was 920-946) with `<ContextEmptyState>`.
- Replaced the two inline solid-border overlays (was 1040-1044, 1534-1538) with `<DropZoneOverlay>`.
- New components `DropZoneOverlay` + `ContextEmptyState` added before `PackDetailPane`; `UploadCloud` added to the lucide import.

### Test/build delta
- `contexts-dropzone-r9.dom.test.tsx` 6/6; `library-detail-r9.dom.test.tsx` still 7/7 (no regression). Borders linter clean (`border-dashed` is token-safe).

---

## B4 — Tools editor

### Failing test → fix
- **RED first:** `apps/web/tests/worker-tools-editor-b4.dom.test.tsx` (7 tests) — all RED on base (free-text input present, no combobox, comma allowlist, spurious onChange).
- **Fix (`apps/web/components/worker/WorkerToolsEditor.tsx`, rewritten):**
  - **Add tool** = searchable combobox (`role="listbox"` + a `Search`-prefixed type-to-filter input) over `availableApps`; already-connected apps excluded; pick → "Add tool". No free-text slug input.
  - **Per-app allowlist** = a LABELED multiselect ("Restrict `<app>` tools") of the app's known tools (`role="option"` toggles), not a comma string. Empty set still drops the `allowed_tools` key (full access, never `[]`).
  - **No phantom toast** = deferred commit: a local `pending` set while the allowlist popover is open; `onChange` fires ONCE on Done, only when `pending` differs from the original set (`sameSet` guard). Open/close with no change, or toggle a tool on→off, emits nothing.
  - **Parent (`ToolsTab` in `WorkersCollection.tsx`)** supplies `availableApps` (from `connections.list()` + `integrations.catalog()`) and a cached `toolsForApp` resolver (from `integrations.catalogTools(slug)`).
- **GREEN:** 7/7 new + existing `worker-config-editors.dom.test.tsx` migrated to the new API (14/14 across both files).

### file:line
- `WorkerToolsEditor.tsx` — new props `availableApps?: ToolAppOption[]`, `toolsForApp?: (slug) => string[]`; combobox (Add tool) + allowlist multiselect + `sameSet`/deferred-commit (`closeAllowlist`).
- `WorkersCollection.tsx:741` `ToolsTab` — fetch/sort `availableApps`, lazy-cache per-app tools, pass both to the editor; `connectionSpecApp` import added.

### Test/build delta
- Both tools test files green (14/14). `next build` clean.

---

## Gate summary (per spec)

- **TDD red→green:** every fix has a failing test that the change turns green (evidence above).
- **`next build` clean:** `apps/web` build exited 0 (B4 + B11/B6 touch web). B10 is the Python engine (no next build); its pytest suite is green.
- **Zero NET-NEW failures vs baseline:** ran the full `apps/web` vitest suite on this branch AND on a clean `e02b5bb4` baseline worktree. **Identical 13 failures across the same 7 files on both** (pre-existing: `collection-pages`, `workers-extra-views`, `not-found`, `login-split-822`, `emily-tool-card-renderer`, `deep-links`, `next-config-redirects`). Branch total 522 vs baseline 509 = **+13 new passing tests** (the B4/B11/B6 suites). No new failures introduced.
- **Linters:** eslint 0 errors (3 pre-existing unused-var warnings, unrelated); emdash / tokens / borders all clean.
- **Preview deploy:** not used (token fragile, per spec). Proven via tests + clean build; the merged deploy carries them.

### Pre-existing failures (NOT introduced here — baseline-confirmed)
`tests/collection-pages.dom.test.tsx` (6), `tests/workers-extra-views.dom.test.tsx` (2), `tests/not-found.dom.test.tsx` (1), `tests/login-split-822.dom.test.tsx` (1), `tests/emily-tool-card-renderer.dom.test.tsx` (1), `tests/deep-links.test.ts` (1), `tests/next-config-redirects.test.ts` (1).

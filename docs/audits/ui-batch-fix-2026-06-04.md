# UI Batch Fix Audit — 2026-06-04

**PR:** https://github.com/floomhq/workeros/pull/426
**Branch:** `worktree-agent-aee1ba7e0e51d9e41`
**Agent:** Claude Sonnet 4.6

---

## C1 — Worker detail fetch error state

**Status:** FIXED

**Root cause:** The `fetchError` state was never stored when a non-404 fetch failure occurred. The `!worker` fallback always showed the generic "Something went wrong fetching this worker."

**Fix:** Added `fetchError: string | null` state. In the catch block (after the existing 3-retry logic), when the error is not a 404, the sanitised first line of the error message is stored. The error state renders `fetchError ?? "Something went wrong fetching this worker."`.

**Backend dependency:** If the API returns a vague 5xx message (`"Internal Server Error"`) the UI will show that. The backend Codex lane should return meaningful error bodies with a `detail` field.

**File changed:** `apps/web/app/workers/[id]/page.tsx`

**Screenshots:** Before — could not reproduce on the deployed site as it requires auth. Code verified.

---

## C2 — Share modal redesign

**Status:** FIXED (UI complete; backend short-link is a Codex dependency)

**Root cause:** `ShareWorkerButton` showed the full 64-hex HMAC token URL in a wide `<code>` block. No CTAs for what to do with the link.

**Fix:** Complete modal redesign:
- Card-style layout: header, compact link row (truncated mono text + copy icon), two action tiles ("Run on Floom" / "Install as skill"), footer copy button.
- `workerName` prop added and threaded to both call sites (worker detail header + workers list card).
- Short-link backend stubbed with `TODO` comment: `POST /workers/{id}/short-link → { short_url, short_id }` + `app/s/[id]/page.tsx` route needed from Codex lane.

**Files changed:**
- `apps/web/components/ShareWorkerButton.tsx` — rewritten
- `apps/web/app/workers/[id]/page.tsx` — adds `workerName={worker.name}`
- `apps/web/app/workers/WorkersClient.tsx` — adds `workerName={worker.name}`

---

## C3 — MCP install command normalisation

**Status:** FIXED

**Root cause:** `CliCommandPanel.buildMcpSnippet` generated `workeros mcp add --target <client>` while `connections/mcp/page.tsx` `MCP_INSTALL_TARGETS` used `workeros mcp install --target <client>`. The inconsistency also explains the "install--target" typo report (possibly from a different concat path).

**Fix:** Changed `mcp add` → `mcp install` in `buildMcpSnippet`. The `connections/mcp/page.tsx` array already had correct spacing.

**File changed:** `apps/web/components/CliCommandPanel.tsx`

---

## C4 — Visibility dropdown selected-row contrast

**Status:** FIXED

**Root cause:** The active dropdown item showed the `Check` icon but had no persistent background — only the `focus:bg-accent` state which applies only on hover/focus. In dark mode the focused state uses the blue `--accent` background which then makes the hint text (still `text-muted-foreground`) hard to read.

**Fix:** Active `DropdownMenuItem` gets `bg-[var(--active-nav-bg)]` + all text forced to `text-foreground`. The hint `text-xs text-muted-foreground` stays muted (intentional secondary text) but the label and icon are now explicitly `text-foreground`.

**File changed:** `apps/web/components/AssetVisibilityControl.tsx`

---

## C5 — MCP install section polish

**Status:** FIXED (restrained)

**Changes applied:**
- Removed the redundant "Pick your client" uppercase label above the pill buttons (the pills are self-describing).
- Tightened spacing `space-y-4 → space-y-3`.
- Shortened the help copy (removed redundant "your own AI client" repetition).

**Not changed (bigger scope):**
- The `CommandBlock` component's `pre` dark background is intentionally high-contrast for terminal commands.
- The "MCP servers your workers can use" table structure is fine as-is.
- The Gmail Connect card (`ConnectAppRow`) is already ChatGPT-simple (icon + name + button, no nested cards).

**File changed:** `apps/web/app/connections/mcp/page.tsx`

---

## C6 — Emily avatar → solid blue

**Status:** FIXED

**Root cause:** The Assistant sidebar nav item used the generic `Bot` lucide icon.

**Fix:** 
- `Bot` import removed from sidebar.
- `EmilyDot` component added: a `<span>` with `border-radius: 9999px` and `background: var(--emily-accent, #59AAF8)` (falls back to the Workeros accent blue `#59AAF8` if the CSS var isn't set).
- `NavItem` type added to properly type the `nav` array with optional `emilyDot: boolean`.
- Render path: `item.emilyDot ? <EmilyDot /> : item.icon ? <item.icon ... /> : null`.

**File changed:** `apps/web/components/layout/sidebar.tsx`

---

## Screenshots

| Before | After |
|--------|-------|
| `docs/audits/screenshots/before-home.png` | Vercel preview pending |
| `docs/audits/screenshots/before-connections-mcp.png` | Vercel preview pending |

After screenshots will be taken once PR #426 is deployed to the preview URL.

---

## TypeScript check

Ran `tsc --noEmit` against the canonical `apps/web` tsconfig. Pre-existing errors unrelated to these changes (missing `@/lib/run-format`, `@/lib/worker-icon`, `@/lib/strip-citations` modules) were present before. Zero new errors introduced by this batch.

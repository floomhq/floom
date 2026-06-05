# UI Audit: M34/M35/M36/M37 — Avatar, Logout, Workspace Actions
Date: 2026-06-05
Branch: ui/m34-m37-avatar-logout-workspace
Preview: https://workeros-qq03y8w9t-fedes-projects-5891bd50.vercel.app
PR: open against floomhq/workeros origin/main

---

## M36 — Profile shows real Google avatar

**Status: FRONTEND BUILT / BACKEND DEPENDENCY FLAGGED**

**What was done:**
- `WorkerAvatar.tsx`: added `avatarUrl?: string | null` prop. When provided, renders `<img referrerPolicy="no-referrer">` instead of the initials div. Fallback to initials when null/absent.
- `UserProfileFooter` in `sidebar.tsx`: added `avatarUrl?: string | null` prop. When provided, renders the `<img>` in place of the "LU" initials div inside the profile chip trigger.

**Backend dependency flagged (do NOT fake it):**
The auth model is secret-based (`web-session.ts` — HMAC of `FLOOM_API_SECRET`). There is no Google OAuth in the session layer, no `picture`/`avatar_url` field anywhere in `WorkspaceMemberOut`, `WorkspaceMembersResponse`, or any backend response (`GET /user/me` does not exist).

**Backend must add:** `GET /user/me` returning `{ picture: string | null, display_name: string | null, email: string | null }`, OR add `picture` to the workspace members response. The frontend wiring is ready — just pass `avatarUrl={picture}` to `UserProfileFooter`.

**Files changed:**
- `apps/web/components/WorkerAvatar.tsx`
- `apps/web/components/layout/sidebar.tsx`

---

## M37 — Logout on profile icon

**Status: BUILT + VERIFIED**

**What was done:**
- `UserProfileFooter` in `sidebar.tsx`: converted the profile chip (avatar + name area) into a `DropdownMenu` trigger.
- Clicking the chip opens a dropdown (pops up, `side="top"`) with: Settings (link) | separator | Sign out (calls `POST /api/auth/logout` then navigates to `/login`).
- Removed the separate standalone `LogOut` icon button (was redundant). The Settings gear icon link was also removed from the inline row (it moves into the dropdown).
- ThemeModeButton remains at right.

**Verified in browser:** Light mode + dark mode. Both show the dropdown correctly.

**Before:** "LU | Local user | gear icon | logout icon | theme button" — 4 separate items.
**After:** "LU | Local user | theme button" — profile chip clicks to show dropdown.

**Files changed:**
- `apps/web/components/layout/sidebar.tsx`

---

## M34 / M35 — Workspace actions menu clarity

**Status: BUILT + VERIFIED**

**What was done:**
- `WorkspaceSwitcher.tsx`: all 4 items in the "Workspace actions" submenu now have a 2-row layout: icon + label on the first row, a 10px muted description on the second row.
- New labels and descriptions:
  - "Export workspace" / "Download a zip of agents + instructions (no secrets)"
  - "Import workspace..." / "Restore from an exported zip"
  - "Duplicate workspace" / "Copies agents + instructions. Connections & secrets are not copied — reconnect after."
  - "Share as template link" / "Shareable link to the exported zip — no secrets included"
- Submenu width bumped from `w-56` to `w-64` to accommodate the descriptions.

**The key confusion fixed:** Duplicate now explicitly states "Connections & secrets are not copied — reconnect after." This matches the confirmed backend behavior (intentional, for security).

**Verified in browser:** Submenu renders correctly in both light and dark mode.

**Files changed:**
- `apps/web/components/layout/WorkspaceSwitcher.tsx`

---

## Screenshot summary

| Screenshot | Path |
|---|---|
| BEFORE — sidebar light mode | `/tmp/before-sidebar-light.png` |
| AFTER — sidebar light mode (M37 chip visible) | `/tmp/after-sidebar-light.png` |
| AFTER — profile dropdown open (M37) | `/tmp/after-profile-dropdown-light.png` |
| AFTER — workspace actions submenu (M34/M35) | `/tmp/after-workspace-actions-submenu.png` |
| AFTER — profile dropdown dark mode | `/tmp/after-profile-dark-modal.png` |

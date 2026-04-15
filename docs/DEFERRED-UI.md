# Deferred UI features

The MVP surface on `main` exposes 5 pages (`/login`, `/me`, `/build`,
`/creator`, `/p/:slug`) plus the creator hero, apps directory, and
protocol page. The six features below are fully shipped on the backend
(routes, services, schema, tests) but their UI has been stripped from
`main` so the MVP stays tight. Every feature has its own git branch
with the last known working UI; re-enabling is a branch merge plus the
checklist noted per feature.

## 1. Async job queue

- **Branch:** `feature/ui-async-jobs`
- **Backend kept:** `apps/server/src/services/jobs.ts`,
  `apps/server/src/routes/jobs.ts`, 77+ unit tests.
- **UI removed on `main`:** None. The MVP UI on `main` never exposed
  async jobs — no progress bars, no `/jobs` route, no async toggle in
  `/build`. The feature branch holds the original jobs UI for a later
  re-enable.
- **Re-enable checklist:**
  1. Merge `feature/ui-async-jobs`.
  2. Wire a progress-bar component into `FloomApp` when `run.status ===
     'pending'` and the app manifest declares `async: true`.
  3. Surface a Jobs tab on `/me` alongside Your apps.
  4. Confirm the async toggle on `/build` maps to
     `manifest.actions[x].async`.

## 2. Custom React renderer upload

- **Branch:** `feature/ui-custom-renderers`
- **Backend kept:** `packages/renderer/` default exports,
  `apps/server/src/services/renderer-bundler.ts`,
  `/renderer/:slug/bundle.js`.
- **UI removed on `main`:** None. The creator "upload your renderer
  bundle" UI never landed on the `main` build path. The feature branch
  holds the upload form.
- **Note:** The default `@floom/renderer` package (text / JSON / table /
  markdown / image / file / url / 13 input types — file uploads are
  Floom's differentiator) is KEPT on `main`. This deferral is only
  about the creator-uploaded custom React bundle surface.
- **Re-enable checklist:**
  1. Merge `feature/ui-custom-renderers`.
  2. Add a renderer-bundle upload step to `/build`.
  3. Gate FloomApp on the per-app bundle URL and fall back to the
     default renderer when missing.

## 3. Stripe Connect monetization

- **Branch:** `feature/ui-stripe-connect`
- **Backend kept:** `apps/server/src/routes/stripe.ts`,
  `apps/server/src/services/stripe-connect.ts`, 163 Stripe unit tests,
  `stripe_accounts` + `stripe_webhook_events` tables.
- **UI removed on `main`:** None. The `/creator` page on `main` never
  had a monetization tab, earnings tile, or "Connect your Stripe" CTA.
  The client has no `/api/stripe/*` fetches. The feature branch holds
  the creator monetization surface.
- **Note:** The `name: stripe` YAML sample and `/api/stripe/*` line in
  `SelfHostTerminal` / `ProtocolPage` / `protocol.md` / `TopBar`
  marketing copy refer to Stripe's own public OpenAPI as a DEMO of
  wrapping any third-party API through Floom. They are NOT Stripe
  Connect monetization UI and stay on `main`.
- **Re-enable checklist:**
  1. Merge `feature/ui-stripe-connect`.
  2. Add a Monetization tab on `/creator` with the earnings tile and
     Connect CTA.
  3. Wire `listStripeAccount` / `createStripeAccountLink` client helpers
     from the branch.

## 4. Composio OAuth (150+ tools)

- **Branch:** `feature/ui-composio-connections`
- **Backend kept:** `apps/server/src/services/composio.ts`,
  `apps/server/src/routes/connections.ts`, `connections` table,
  135 unit tests.
- **UI removed on `main`:**
  - `/me` Connected tools tab (provider picker, OAuth flow trigger,
    "150+ tools" framing).
  - `api/client.ts` wrappers: `listConnections`, `initiateConnection`,
    `revokeConnectionApi`.
  - `lib/types.ts` `ConnectionRecord` type.
  - `/me` sidebar "Connected tools" entry (8-item sidebar on main,
    down from 9).
- **Note:** Per MVP scope, Connected tools is NOT listed as a
  coming-soon stub alongside Folders, Saved results, Schedules,
  My tickets, and Shared with me. The 5 coming-soon stubs do not
  reference composio, workspaces, or app memory.
- **Re-enable checklist:**
  1. Merge `feature/ui-composio-connections`.
  2. Restore `ConnectionRecord` in `lib/types.ts`.
  3. Restore `listConnections` / `initiateConnection` /
     `revokeConnectionApi` in `api/client.ts`.
  4. Restore `ConnectionsTab` and the Connected tools sidebar item on
     `/me`.
  5. Restore the `IconCable` and `ConnectIcon` SVG helpers.

## 5. App memory

- **Branch:** `feature/ui-app-memory`
- **Backend kept:** `apps/server/src/routes/memory.ts`,
  `apps/server/src/services/app_memory.ts`, `app_memory` table.
- **UI removed on `main`:** None. No `/me` memory widget or
  `/p/:slug` memory reference ever landed on `main`. The feature
  branch holds the surface.
- **Note:** The `CreatorHeroPage` self-host section lists "memory" as
  one of the engine features Docker ships. The backend routes and
  table are live, so the marketing copy is accurate and stays.
- **Re-enable checklist:**
  1. Merge `feature/ui-app-memory`.
  2. Restore the /me memory widget and the /p/:slug memory drawer from
     the branch.

## 6. Workspace switcher / multi-org

- **Branch:** `feature/ui-workspace-switcher`
- **Backend kept:** `apps/server/src/routes/workspaces.ts`, workspace
  CRUD + members + invites, 253 unit tests,
  `/api/session/switch-workspace`.
- **UI removed on `main`:**
  - `TopBar` workspace dropdown (rendered when
    `data.workspaces.length > 1`).
  - `api/client.ts` `switchWorkspace` wrapper.
  - `SessionWorkspace` import in `TopBar`.
- **Note:** Every user still auto-lands in their personal workspace at
  signup; `SessionMePayload` still carries `active_workspace` +
  `workspaces` for future use. The single-workspace case is unchanged.
- **Re-enable checklist:**
  1. Merge `feature/ui-workspace-switcher`.
  2. Restore `switchWorkspace` in `api/client.ts`.
  3. Restore the `ref={wsRef}` / `wsOpen` dropdown block in `TopBar`.
  4. Restore the `refreshSession` import in `TopBar`.

## Summary

| # | Feature | Files touched on strip | LOC removed |
|---|---|---|---|
| 1 | Async jobs | None (no prior UI on main) | 0 |
| 2 | Custom renderer upload | None (no prior UI on main) | 0 |
| 3 | Stripe Connect | None (no prior UI on main) | 0 |
| 4 | Composio connections | `MePage.tsx`, `types.ts`, `api/client.ts`, `CreatorPage.tsx` | ~220 |
| 5 | App memory | None (no prior UI on main) | 0 |
| 6 | Workspace switcher | `TopBar.tsx`, `api/client.ts` | ~85 |

Five of six features had zero UI on `main` at the time of the strip.
The two features with actual UI (Composio, Workspaces) were the
previous agent's focus before rate-limit death and are now fully
stripped on `cleanup/mvp-ui-strip-v2`.

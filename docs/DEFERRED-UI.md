# Deferred UI features

The MVP surface on `main` exposes 5 pages (`/login`, `/me`, `/build`,
`/creator`, `/p/:slug`) plus the creator hero, apps directory, and
protocol page. Of the six features tracked here, §1 (async job queue)
and §2 (custom React renderer upload) now ship their UI on `main`. The
remaining four are fully shipped on the backend (routes, services,
schema, tests) but their UI has been stripped from `main` so the MVP
stays tight. Each still-deferred feature has its own git branch with
the last known working UI; re-enabling is a branch merge plus the
checklist noted per feature.

## 1. Async job queue — shipped

- **Status:** UI shipped on `main`.
- **Backend:** `apps/server/src/services/jobs.ts`,
  `apps/server/src/routes/jobs.ts`, 77+ unit tests.
- **UI on `main`:**
  - `apps/web/src/components/runner/RunSurface.tsx` branches on
    `app.is_async` and calls `api.startJob` / `pollJob`.
  - `apps/web/src/components/runner/JobProgress.tsx` renders the
    progress surface during polling.

## 2. Custom React renderer upload — shipped

- **Status:** UI shipped on `main`.
- **Backend:** `packages/renderer/` default exports,
  `apps/server/src/services/renderer-bundler.ts`,
  `/renderer/:slug/bundle.js`.
- **UI on `main`:** `apps/web/src/components/CustomRendererPanel.tsx`,
  imported and rendered from `apps/web/src/pages/BuildPage.tsx`,
  `apps/web/src/pages/StudioAppRendererPage.tsx`, and
  `apps/web/src/pages/CreatorAppPage.tsx`.
- **Note:** The default `@floom/renderer` package (text / JSON / table /
  markdown / image / file / url / 13 input types — file uploads are
  Floom's differentiator) stays on `main` as the fallback when an app
  has no custom bundle uploaded.

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
| 1 | Async jobs | Shipped on `main` (`RunSurface.tsx`, `JobProgress.tsx`) | n/a |
| 2 | Custom renderer upload | Shipped on `main` (`CustomRendererPanel.tsx`) | n/a |
| 3 | Stripe Connect | None (no prior UI on main) | 0 |
| 4 | Composio connections | `MePage.tsx`, `types.ts`, `api/client.ts`, `CreatorPage.tsx` | ~220 |
| 5 | App memory | None (no prior UI on main) | 0 |
| 6 | Workspace switcher | `TopBar.tsx`, `api/client.ts` | ~85 |

Five of six features had zero UI on `main` at the time of the strip.
The two features with actual UI (Composio, Workspaces) were the
previous agent's focus before rate-limit death and are now fully
stripped on `cleanup/mvp-ui-strip-v2`. §1 and §2 have since shipped
their UI on `main` and are tracked here only as a historical record.

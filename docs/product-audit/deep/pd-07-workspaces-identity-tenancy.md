# pd-07: Workspaces, identity, tenancy

**Audit type:** Deep product truth (multi-tenant session model vs shipped UI vs roadmap)  
**Sources of truth:** `docs/PRODUCT.md` (ICP), `docs/ROADMAP.md`, `docs/DEFERRED-UI.md`  
**Backend reviewed:** `apps/server/src/routes/workspaces.ts`, `apps/server/src/services/workspaces.ts`, `apps/server/src/services/session.ts`, `apps/server/src/routes/connections.ts` (skim), `apps/server/src/services/composio.ts` (connection scoping)  
**Web reviewed:** `apps/web/src/components/TopBar.tsx`, `apps/web/src/hooks/useSession.ts`, `apps/web/src/api/client.ts`, `apps/web/src/lib/types.ts` (`SessionMePayload`), grep across `apps/web` for workspace/session usage  
**Cross-reference:** `docs/DEFERRED-UI.md` §4 (Composio), §6 (workspace switcher); roadmap P2/P3 enterprise items  
**Snapshot note:** Repo state at audit time; ROADMAP snapshot date 2026-04-17.

---

## 1. Backend-shipped, UI-stub — implications for enterprise story vs ICP

### ICP lens (`PRODUCT.md`)

The stated user is a **non-developer AI engineer** who needs **repo → hosted** without infra vocabulary. For that persona:

- **Single “home” tenant is enough for v1 discovery:** Cloud signup bootstraps a **personal workspace** (`session.ts` `bootstrapPersonalWorkspace`) and sets **active workspace** so the UI is not empty. They never need to hear “workspace” if copy stays outcome-first.
- **Deferred workspace switcher and Composio UI do not block the core “paste repo / run app” story** as long as they do not appear as prerequisites in onboarding. Session still resolves; runs and ingest key off server-side context.
- **Risk when the ICP accidentally becomes multi-workspace:** If they accept an invite or create a second workspace via API/scripts, **the product UI gives no first-class way to change active workspace** (switcher removed). They may perceive “wrong account,” missing apps, or missing OAuth connections without knowing **active workspace** is a server pointer (`user_active_workspace`).

### Enterprise / teamwork lens (roadmap + backend reality)

Roadmap places **workspace switcher UI** and **Composio connections UI** in **P2 — month one**, and **Enterprise RBAC** in **P3 — v1.1+** (`docs/ROADMAP.md`). The **backend already ships** a credible **team tenancy skeleton**:

- Workspace **CRUD**, **members** (roles `admin` | `editor` | `viewer`), **invites** with token + `accept_url`, **`/api/session/me`** exposing `active_workspace` + full `workspaces[]`, **`POST /api/session/switch-workspace`** (`routes/workspaces.ts`, `services/workspaces.ts`).
- **Composio connections** are stored **per `(workspace_id, owner_kind, owner_id, provider)`** and listed only for the **current** `SessionContext.workspace_id` (`services/composio.ts` `listConnections`).

**Implication:** The **enterprise narrative is API-true but UI-false**. A buyer evaluating Floom on **team collaboration, OAuth tool governance, or “which org am I in?”** will find:

- **Strong:** Same route shapes as documented; session payload already lists memberships; RBAC enforcement exists for mutating routes (`requireAuthenticatedInCloud`, `assertRole`).
- **Weak:** No **switcher**, no **Connected tools** tab, no **invite management** surface — only **direct API or branch merge** (`feature/ui-workspace-switcher`, `feature/ui-composio-connections` per `DEFERRED-UI.md`). Invites assume a **working `/invite/:token` landing** path (`workspaces.ts` `accept_url`); product polish of that journey is outside this file’s proof.

**Positioning gap:** Shipping **backend-first multi-tenancy** without UI reads as **platform maturity for integrators**, not **ready teamwork for business users**. That is acceptable for pre-1.0 if **marketing and sales** do not imply org management; it is hazardous if **security questionnaires** assume UI-visible tenant boundaries.

---

## 2. Executive truth table

| Promise / expectation (PRODUCT / ROADMAP / comments) | Where it shows up | Observed reality (code + UI) | Status |
|-----------------------------------------------------|-------------------|------------------------------|--------|
| **“Workspace switcher — Backend shipped, UI stub”** | `ROADMAP.md` §Shipped backend | `/api/workspaces/*`, `/api/session/me`, `/api/session/switch-workspace` live; `TopBar` documents deferral; `client.ts` has **no** `switchWorkspace` wrapper (`DEFERRED-UI.md` §6). | **Partial** — **Met** for API; **Missing** for product UI |
| **“Composio connections — Backend shipped, UI stub”** | `ROADMAP.md` | `/api/connections/*` + DB + Composio service; `/me` Connected tools stripped (`DEFERRED-UI.md` §4); client helpers removed. | **Partial** — same split |
| **Multi-workspace membership surfaced to the client** | `SessionMePayload` (`types.ts`), `me()` (`workspaces.ts`) | `/api/session/me` returns `workspaces[]` + `active_workspace`; `useSession()` caches full payload. Data is present; **no** switch control in `TopBar`. | **Partial** |
| **Tenant isolation for connections** | `connections.ts` route comments; `listConnections` | Queries filter `workspace_id` + `owner_kind` + `owner_id` to **current** `ctx.workspace_id`. | **Met** (server-side) |
| **Identity continuity device → user** | `session.ts` `rekeyDevice` | On first authenticated request, migrates runs, memory, threads, **connections** from device scope to user + **active** workspace; Composio legacy id preserved via `users.composio_user_id`. | **Met** (with edge cases — see risks) |
| **OSS “solo” mode** | `session.ts`, `workspaces.ts` | Synthetic `local` user/workspace; `me()` always 200 with local shape. | **Met** |
| **Enterprise RBAC** | `ROADMAP.md` P3 | Workspace **roles** exist at **workspace** granularity; **no** org-wide SSO/RBAC/product UI in roadmap near term. | **Missing** vs “enterprise” word on roadmap — **Partial** vs **team MVP** |

**Legend:** **Met** = behavior matches stated intent for the layer reviewed. **Partial** = true for API or happy path only, or uneven UX. **Missing** = promised surface not present. **Contradicted** = two artifacts conflict (none asserted strongly for this theme).

---

## 3. ICP journey — workspaces & connections (with failure branches)

**Assumption:** Cloud user, signed up, single auto-created workspace (default path).

| Step | User intent | What happens | Failure branches |
|------|-------------|--------------|------------------|
| **1 — Load app** | Use Floom normally | `useSession` → `GET /api/session/me`; receives `active_workspace`, `workspaces`, `cloud_mode`, `auth_providers`. | **A — OSS build:** `user.is_local` → UI treats as signed-out for premium gates; still consistent. **B — `/api/session/me` fails:** Cached error; no workspace context for client (see `useSession.ts`). |
| **2 — Build / run** | Connect tools if needed | No **Connected tools** UI on `main`; user cannot discover Composio from `/me`. OAuth must be driven by **other clients** or future UI. | **C — Expectation from marketing “150+ tools”:** **Contradicted** by **Missing** UI unless copy avoids implying in-product connection management. |
| **3 — Invited to second workspace** | Join team | Invite email → `accept_url` (`/invite/:token`). Accept API exists (`POST .../accept-invite`). | **D — After accept:** Membership increases; **`active_workspace` may switch** to invited workspace (`acceptInvite` updates `user_active_workspace`). **E — No switcher:** User cannot move between orgs in **TopBar**; must use **API** or stay on whichever workspace `me()` shows as active — **confusion risk**. |
| **4 — OAuth before login** | Connect tool anonymously | Connections stored under **device** owner in **current** workspace (`local` pre-login per `rekeyDevice` comments). | **F — Post-login rekey:** Rows move to **user** + **active** workspace. **G — Duplicate provider:** If user-row already exists in target workspace, **device row may remain orphaned** (`session.ts` NOT EXISTS branch) — rare but **support/debug** surface. |

---

## 4. Risk register (P0 / P1 / P2)

| ID | Tier | Risk | Evidence | Downstream effect |
|----|------|------|----------|-------------------|
| W7-1 | **P1** | **Multi-workspace users cannot switch tenant in UI**, while backend and `/api/session/me` expose multiple memberships | `DEFERRED-UI.md` §6; `TopBar.tsx` comments; no `switchWorkspace` in `client.ts` | Wrong workspace feels like “data loss”; connections list “wrong”; support tickets; evaluators doubt readiness |
| W7-2 | **P1** | **Composio value is invisible** on `main` — no provider grid, no connection health | `DEFERRED-UI.md` §4; `ROADMAP.md` “UI stub” | Misaligned expectations if **any** external copy promises “connect Gmail/Slack in-app” |
| W7-3 | **P1** | **Invite / accept journey** depends on **`/invite/:token`** and email handoff without a reviewed **product** flow in this audit | `workspaces.ts` `accept_url`; accept route under workspaces | Drop-off, token expiry (`invite_expired`), or “I clicked but nothing changed” if front door is thin |
| W7-4 | **P2** | **Rekey edge case:** duplicate provider across device migration leaves **orphaned device row** | `session.ts` `rekeyDevice` NOT EXISTS subquery | Rare double-connection confusion; cleanup story unclear for ops |
| W7-5 | **P2** | **Enterprise proof:** roles are **workspace-scoped** only; roadmap **Enterprise RBAC** is **P3** | `ROADMAP.md` P3; `workspaces.ts` roles | Procurement may ask for SSO/org policy — **not** promised near-term |
| W7-6 | **P2** | **Studio “creator workspace”** language is **shell copy**, not tenant switcher | `StudioLayout.tsx`, `StudioHomePage.tsx` comments | Harmless for ICP if read as “studio”; confusing if read as **org switcher** |

---

## 5. Open PM questions (numbered)

1. **Switch priority:** Should **workspace switcher** ship **before** or **with** **Composio UI**, given both are P2 and connections are **scoped to active workspace**?
2. **Multi-workspace users:** Until the switcher returns, should the product **discourage** creating/joining second workspaces (copy, `/me` banner), or **expose a minimal switcher** earlier than P2?
3. **Invite UX:** Is **`/invite/:token`** the canonical accept page on `main`, and does it **call** `accept-invite` and **refresh** session — or is that still branch-only?
4. **ICP messaging:** Should **public** pages avoid “team workspace,” “org,” or “150+ integrations” until the respective UIs ship?
5. **Enterprise pipeline:** For **evaluations**, is **API-only tenancy** acceptable with a **written** security overview, or should **switcher + audit-friendly screens** be a **pre-revenue** gate?
6. **Composio scope:** Should connections be **user-global** or **workspace-bound** for the story we sell? (Today: **workspace + owner** — confirm product intent vs “my integrations everywhere.”)
7. **OSS vs Cloud parity:** Should **self-host** docs explicitly state **no multi-user workspace UI**, only API — to reduce **wrong audience** installs?
8. **Active workspace staleness:** If **`switch-workspace` fails** (network), should the client **optimistically** update UI or **always** trust **`/api/session/me`** — is there a desired **offline** behavior?

---

## Appendix — API surfaces referenced (audit shorthand)

| Surface | Role in tenancy story |
|---------|------------------------|
| `GET /api/session/me` | Canonical read of user + `active_workspace` + `workspaces[]` + `cloud_mode` + OAuth provider flags |
| `POST /api/session/switch-workspace` | Sets active tenant pointer (member-gated) |
| `GET/POST/PATCH/DELETE /api/workspaces...` | Org CRUD, members, invites |
| `GET/POST/DELETE /api/connections...` | Composio OAuth rows scoped to **current** workspace + owner |

---

*End of pd-07.*

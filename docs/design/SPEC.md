# Workeros UI — Unified System Spec

Status: SUPERSEDED for implementation, 2026-06-10 — build from `APP-UI-V4-SPEC.md` + `final.html` (v4). This doc stays as design-rationale background. Where they disagree, v4 wins.

Original status: PROPOSED, 2026-06-08. This is the canonical design spec. Where any other doc
(`unified-layout-spec.md`, old mockups) disagrees, THIS wins. Companion artifacts:
`final.html` (will be rebuilt to this spec), `CURRENT-REALITY.md` (what exists today),
`ROLES.md` (backend role truth), `before-after.html` (per-page diff).

The earlier wireframes scored 5/10 because they patched each page separately and missed the
single organizing idea. This spec leads with that idea, then derives every page from it.

---

## 0. The high-level model (the one idea)

**Almost every page in Workeros is the same thing: a Collection.**

Workers, Runs, Connections, Brain, Approvals are all Collections of items. A Collection has
ONE fixed anatomy, and that anatomy is the entire UI system:

```
┌ NAV ┬───────────────── CENTER (the Collection) ─────────────────┬ EMILY ┐
│     │  Title + subtitle                                          │       │
│     │  Control bar:  [Search]  [Unified Tag Bar]    [List|Grid] [+Add]   │
│     │  ───────────────────────────────────────────────────────  │ fixed │
│     │  Body:  List  or  Grid   (resting)                         │ rail  │
│     │         └ click an item → SPLIT: list 30% | detail 70%     │       │
└─────┴────────────────────────────────────────────────────────────┴───────┘
```

Only three pages are NOT collections: **Overview** (dashboard), **Assistant** (config editor),
**Settings** (config tabs). Everything else is the Collection pattern with different parameters.

**Consequence (the alignment principle):** there are no bespoke per-page controls. No status
"tabs" on Runs, no "Connected/MCP/Secrets" segmented control, no separate star/recent/archive
icon row. Every filter is a **Tag**. Every list looks the same. Every detail is a split with
tabs. A user who learns one Collection has learned all of them.

This is what was missing. The rest of the spec is parameters of this one model.

---

## 1. The Tag system (the ONLY filter primitive)

One bar, one interaction model, on every Collection. Chips on top, flat, left→right by family.
**This replaces all segmented controls and all the icon toggles.**

Tag families (rendered in this order, visually separated by a thin gap):

| Family | Examples | Selection | Logic |
|---|---|---|---|
| **Smart** (computed) | Starred · Recent · Archived | multi-select | Starred = favorited; Recent = touched in last 14d; Archived = archived flag. **These replace the old grid-header star/clock/archive icons** — now seamless chips in the same bar. |
| **Status** (per collection) | Runs: Running·Queued·Completed·Failed · Connections: Active·Reauth·Error · Workers: Running·Failing·Needs-attention·Paused | multi-select | derived from item state. **Replaces the Runs status tabs.** |
| **Type** (where a page holds >1 type) | Connections: Connection · MCP · Secret | multi-select | filters one unified list by type (see §1a). NOT a schema swap. |
| **Content** (user labels) | operations · recruiting · dach · prod · client-acme | multi-select | free-form tags on items. |

Rules:
- **All tags are multi-select. Default = all selected (nothing filtered / everything shows).** Click chips to narrow; a "Clear" / deselect-all returns to showing everything. No single-select, no switches, anywhere. (the operator 2026-06-08: "multi-select always, select-all default, deselect-all option, super intuitive.")
- Chips, on top, under the search row. Active chip = filled (dark) with an ✕ to clear.
- Search and tags AND each other (search within the active tag filter).
- A leading "Tags" label is optional; on dense pages drop it.
- "+ more" overflow when a family is long; opens a popover.
- In SPLIT mode the search + tag bar move into the **left list column** (compact), never above the detail tabs.

### 1a. Connections is ONE list; Type is just a tag (the operator, 2026-06-08)
Connected / MCP / Secrets are all "things that connect a worker to something external." They are
ONE Collection. **Type (Connection · MCP · Secret) is a multi-select tag**, not a separate list or a
switch. What matters per row is *what it connects you to*, so the list uses **common columns**:
`what it connects to (name + logo) · status · last used`. Type-specific extras (scopes count for a
connection, tools count for MCP, "used by" for a secret) render as a small secondary cell and in the
detail pane — they do NOT create separate table schemas. One list, type filtered like any other tag.

---

## 2. View modes — List & Grid on EVERY collection

- **List** (universal default) and **Grid** (toggle) exist on every Collection — **including
  Approvals and Brain** (today they lack one; that's the inconsistency). The toggle is the only
  non-tag control in the bar.
- **In SPLIT mode the toggle is hidden**; the left pane is always a compact List.
- **Brain is not forced into split.** Brain resting = a List/Grid of folders (full width). Click a
  folder → split (folder's files on the right). Same as every other collection. (Answers "why can't
  I go to full-page list/grid on Brain.")

### 2a. The canonical List row (match the real app — see the operator's Connections screenshot)
The real Connections list is the fidelity bar. Every list row everywhere uses it:
```
[ logo/avatar ]  Primary name (semibold)        col A      col B     [status pill]   ⋯
                 secondary sub (muted)
```
- ~64px row height, generous padding, 1px hairline dividers (`--line-soft`), white card bg, card radius on the table container.
- **Real brand logo** in a white rounded-square chip (28px) — GitHub, Gmail, Slack, Google, HubSpot, etc. (NOT generic monochrome glyphs). Workers/runs/approvals use the seeded avatar.
- Collection-specific columns sit between sub and status (Connections: Scopes, Last used; Runs: Trigger, Duration, Started; Workers in list: tools, last run).
- **Status pill** = outlined style: subtle tinted bg + colored text + leading dot (e.g. green "Active", red "Error", amber "Reauth"). Match the real pill, not a flat block.
- `⋯` row action menu at the right.

### 2b. The canonical Grid card (simplified — "too much going on")
Today's card crams 6 things. Trim to a clean 3-line hierarchy:
```
[avatar]  Name  (Example)                         ☆ (hover only)
          one-line description (muted, 2 lines max)
          ─────────────────────────────────────────
          ● status / last run                      ·  tools (≤3 tiny logos)
```
- **Star moves to hover** (top-right, appears on row/card hover) — not always-on chrome.
- **Tools shrink to ≤3 tiny logos in the footer** (secondary), full set in detail.
- **Tags do NOT render on the card** (they're the filter, not card decoration). Optional: 1 status chip only.
- Result: avatar+name, description, one status line. Calm.

---

## 3. The detail (split right pane)

- 30/70 (list/detail). List collapsible to a sliver (`«` / `»`). Detail closes with `✕`. Emily rail untouched throughout.
- Header: avatar/logo + name (+Example) + primary action + secondary + `✕`.
- **Canonical tabs per collection** (locked):
  - Workers: **About · Run · Runs · Source · Settings · Brain · Tools** (About = Flow diagram)
  - Runs: **Output · Steps · Tools · Cost** (+ Replay)
  - Connections: **Overview · Scopes · Activity**
  - Approvals: **Request · Items · Run** (+ Approve / Reject)
  - Brain folder: **Files · Used by**
- URL state: `?sel=<id>&tab=<name>` — back/refresh/share safe. Invalid `?sel` → resting; deleted selection → toast + resting.

---

## 4. Design system & fidelity (the 5/10 → real-app gap)

Pull from the real app, do not approximate:
- **Tokens (Warm-OS, real):** bg `#FAFAF7`, card `#FFFFFF`, ink `#141414`, muted `#6B6861`,
  line `#E7E0D6`, primary `#181818`, success `#2F8F5B`, warning `#F9735B`, pending `#E0B349`.
  radius card 18 / button 12 / pill 9999. Geist Sans + Geist Mono.
- **Real brand logos** — source order per house rule: SimpleIcons → svgl.app → gilbarbara/logos → favicon. White rounded-square chip. NEVER generic monochrome stand-ins, NEVER text-in-circle.
- **Pills** outlined/tinted (not solid blocks): `bg = color@8%`, `text = color`, leading dot.
- **Spacing/rows** per §2a. No shadow artifacts; full-height panels.
- **Icons** lucide (UI), SimpleIcons (brands). No emoji anywhere.
- Skeletons mirror the final layout (no partial flashes).

---

## 5. Per-page application (each = the Collection model)

For each: which Tag families, list columns, grid card fields, detail tabs, role behavior.

### Workers (Collection)
- Tags: Smart (Starred/Recent/Archived) · Status (Running/Failing/Needs-attention/Paused) · Content (operations/recruiting/…). **No more separate folder row** — workers are tagged, not nested.
- List cols: tools · last run. Grid: §2b card.
- Detail: About/Run/Runs/Source/Settings/Brain/Tools.
- Roles: Member sees own+workspace-shared; read-only/locked actions on others.

### Runs (Collection)
- Tags: Smart · **Status (Running/Queued/Completed/Failed) — as tags, not a segmented control** · Content (inherit parent worker's tags) + worker filter.
- Grouped by day (day headers) within the list. List cols: Trigger · Duration · Started.
- Detail: Output/Steps/Tools/Cost + Replay. Export CSV is a row-bar action, not a tab.

### Connections (Collection)
- Tags: **Kind (Connections/MCP/Secrets) — as tags (§1a)** · Status (Active/Reauth/Error) · Content (prod/personal/client-…).
- List cols (Connections kind): Scopes · Last used. (MCP kind: Tools · Transport. Secrets kind: Used by.)
- Detail: Overview/Scopes/Activity. `+ Add` opens the catalog in the detail pane (Browse is the Add flow, not a tab).

### Brain (Collection)
- Tags: Smart · Content (later). **Folders are the items** (real nesting containers — Brain only).
- Resting = List/Grid of folders (full width). Click folder → split (Files/Used-by).
- `+ New folder`. (Tags later if it grows; YAGNI now.)
- **Worker-owned structured data = SQLite in Brain (no CRM).** Brain storage is binary-safe, so a worker
  can keep a `.db` file in a folder (or a writeable context, which persists across runs) and use Python
  `sqlite3` (workers run in E2B Python). That IS the "records/tables" primitive — SQL on a file, no
  sales-CRM product. Caveat: a `.db` is binary so it won't preview in the UI; the worker reads it
  programmatically. For external CRMs, stay agnostic and use a Connection.

### Approvals (Collection)
- Tags: Smart · Status (Pending/…) · Content (inherit worker tags). **Grid view too** (parity).
- List cols: what it will do · count. Detail: Request/Items/Run + Approve/Reject.

### Overview (NOT a collection — dashboard)
- Outcome tiles + Worker activity + Coming up + Needs attention. Items click → open the relevant worker/run as a split on its page.

### Assistant (NOT a collection — config editor)
- One assistant (Emily). Base/Workspace/Final-prompt tabs + persona text. **Member = read-only** workspace prompt; Admin = write. Multi-assistant = later.

### Settings (NOT a collection — config tabs)
- Developer/System/Slack/Appearance/Danger (+ Members for admin). Role-aware (§6).

---

## 6. Roles (granular — from ROLES.md; today backend-only, this is the proposed UI)

| Surface | Member | Admin |
|---|---|---|
| Workers | own + workspace-shared; edit/run own; others read-only | all; edit/run/delete any |
| Worker visibility/share | own only | any |
| Workspace prompt (Assistant) | **read-only** | read + write |
| Brain folders | read+write (own/shared) | all |
| Connections / Secrets | create+manage own scope | all |
| Runs | view+run for visible workers | all |
| Members & users | no access | invite, change role, transfer owner, user admin |
| Settings · Danger zone | hidden | full |

Frontend work this implies (today missing): add `role` to `CurrentUser`; a permission helper
(`can(action, resource)`); gate UI on it; stop showing actions that 403.

---

## 7. States (DRY, every collection)
- **Empty:** centered glyph + headline + one helper + the page's `+ Add` (same button as the bar).
- **Loading:** full-page skeleton of the current layout state.
- **Error:** same slot as empty — glyph + message + Retry + support.
- **Split states:** resting (nothing open) and item-open are both first-class; the toggle/tags live in the left in split.

---

## 8. Implementation contracts (Phase 2 — for Vivek, against origin/main NOT the stale /root/workeros)

### 8a. One shared component
Build a single `<Collection>` that every page configures:
```
<Collection
  items, loading, error,
  search:   {placeholder, fields}
  tags:     {smart:[], status:[], kind:[], content:[]}      // §1
  view:     {default:'list'|'grid', grid:bool}              // §2
  list:     {row: Fn(item)->{logo, primary, secondary, cols:[], statusPill, menu}}  // §2a
  card:     Fn(item)->{...}                                  // §2b
  detail:   {tabs:[{key,label,render}], header, actions}     // §3
  onSelect, urlKey:'sel'
  empty/loading/error: {...}
/>
```
Pages become thin configs. This is what guarantees alignment in code, not by discipline.

### 8b. Query-state contract
`?sel=<id>` `?tab=<key>` `?view=list|grid` `?q=<search>` `?tag=<family>:<value>` (repeatable).
Back/forward, refresh, deep-link all reconstruct state. Invalid `sel` → resting + toast.

### 8c. Split layout rules (the make-or-break details)
- Ratio 30/70. Min usable detail width 520px; min list 240px.
- ≥1100px: persistent split. 768–1100px: detail is an overlay drawer over the list. <768px (mobile): list is full-screen; opening an item pushes a full-screen detail with a back button; Emily becomes a bottom sheet.
- Scroll ownership: list and detail scroll independently; page header sticky.
- Focus: opening detail moves focus to the detail header; `Esc` closes; focus returns to the row.
- Keyboard: `↑/↓` move selection in list, `Enter` opens, `Esc` closes, `[` collapses list.
- Grid→split conversion: opening from grid swaps the left to a compact list (grid never shown at 30%).

### 8d. Source map (fill against origin/main during build)
- Shell/nav: `components/layout/sidebar.tsx` (+ collapse, role-aware items).
- New: `components/collection/Collection.tsx` (+ List, Grid, TagBar, DetailSplit, Card).
- Per page: `app/workers/*`, `app/runs/*`, `app/connections/*`, `app/contexts(brain)/*`, `app/approvals/*` → refactor to `<Collection>` config; delete bespoke filter UIs.
- Detail panes: reuse existing `RunDetailSplitPane`, `FilesEditor`, worker tab components inside the new split.
- Roles: `lib/types.ts` (`CurrentUser.role`), `/auth/me` already returns it; add `lib/permissions.ts`; gate components.

### 8e. Acceptance tests (per collection)
- List & grid both render; toggle persists in URL.
- Each tag family filters correctly; multi-select content tags; clear-all.
- Click row → split; tabs switch; URL updates; refresh restores; invalid sel → resting.
- Collapse/expand list; close detail; Emily fixed throughout.
- Empty/loading/error render in the right slot.
- Member vs Admin: visibility + gated actions verified against API (no 403 on visible actions).
- Responsive: persistent ≥1100, drawer 768–1100, mobile stack.

### 8f. Rollout order (incremental, low-risk)
1. Build `<Collection>` + TagBar + DetailSplit in isolation (Storybook-style page).
2. Migrate **Connections** first (it's closest to the canonical list already) → validate.
3. Then Workers (grid + split), then Runs, then Approvals, then Brain (already split).
4. Roles UI last (needs `CurrentUser.role` + permission helper).
Each page ships behind the same component; no big-bang.

---

## 9. Decisions (resolved 2026-06-08)
1. **Connections = one list, Type is a multi-select tag** (§1a). RESOLVED — no schema swap, no switch.
2. **All tags multi-select; default = all selected; deselect-all available** (§1). RESOLVED.
3. **Card star → hover** (§2b). RESOLVED.
4. Remaining minor: Runs content tags inherit the parent worker's tags by default (can add run-level tags later). Low stakes; default stands unless the operator objects.

---

## 10. Definition of done (for the build)
- One `<Collection>` powers Workers/Runs/Connections/Brain/Approvals; pages are configs.
- Every collection: search + unified tag bar + list/grid + split detail, pixel-matching the real
  app (real logos, real pills, real row metrics).
- Role-aware UI live (no silent 403s).
- All acceptance tests (§8e) green on every collection, all breakpoints.
- Visual parity gate: side-by-side vs the real app screens; deviations are documented KEEP decisions.

---

## 11. Session decision log (2026-06-08, LOCKED — implementation-grade)

These supersede earlier text where they conflict. All verified in `final.html`.

**Tags / filtering**
- All tags **multi-select**, default = all selected (nothing filtered), deselect-all to clear.
- **Smart tags are per-collection, opt-in** (not global): Workers = Starred/Recent/Archived; Runs = Recent; Brain = Starred; **Connections & Approvals = none** (starring/archiving a connection is meaningless — removed).
- **Status** tags per collection; **Trigger** (Scheduled/Manual/Webhook) is its OWN family on Runs, never mixed with content.
- **Content tags share ONE vocabulary across Workers + Runs + Approvals** (operations/recruiting/content/research/data/dach) since runs/approvals belong to workers.
- Tag bar is **small chips, single row, horizontally scrollable**, families separated by a divider.

**Counts = global primitive**
- A uniform count strip (`<b>n</b> label`, `·`-separated) on every collection. **Rendered inline on the RIGHT of the title row** so the header is **max 2 rows** (title + subtitle), never 3. Per page: Workers (workers/active/running/needs-attention), Runs (runs/failed/running), Connections (total/active/reauth/error), Approvals (pending), Brain (folders/files). No bespoke per-page count (the old "5 runs · 2 failed" inline is gone).

**List / cards**
- **Connected list everywhere** (one container + hairline dividers, selected = bg highlight). NEVER floating/separated rounded cards. Identical in the split-left and in detail-body lists. (This was the #1 recurring bug.)
- **List + Grid on every collection** (Workers/Runs/Connections/Approvals/Brain).
- Card simplified: avatar/logo + name(+Example), 1-line desc, one status line; star on hover; ≤3 tiny tool logos; no tag chrome.
- **Real brand logos** (SimpleIcons CC0) for connections + worker tool strips; **worker rows show tool logos** (not "N tools" text).

**Detail pages (designed per tab, no filler)**
- Worker tabs: About (Flow) · **Run (input form + Run button + webhook — distinct from Tools)** · Runs (recent + **"Go to all runs →"** to the Runs page) · **Source (file SUB-TABS worker.yml/SKILL.md/run.py/requirements.txt, NOT a left sidebar)** · Settings (limits + lifecycle) · **Brain (connected list of attached folders + per-folder Read-only/Read-&-write + "Specific folders | Full brain" toggle + Attach)** · **Tools (connected list + Add tool + per-tool Edit)**.
- Connections detail is **type-aware**: Connection → Overview/Permissions/Activity; MCP → Overview/Tools/Config; Secret → Overview/Used-by. (Connections = ONE list, Type is a tag; common columns "connects-to · status · last-used".)
- Approvals: **3 distinct tabs** (Request / Items / Run) + persistent Approve/Reject.
- **Code blocks are light in day mode** (no black terminal); dark only in dark theme.

**Shell**
- Sidebar footer = workspace switcher + user row (region icon); collapsible nav + Emily; Emily is the fixed rail (does not scope/move).

**Worker structured data**: SQLite `.db` in Brain (binary-safe) + writeable contexts; no CRM. Connect to external CRMs via a Connection.

**Open (minor, for build):** +Add flows (catalog/upload) open in the detail pane; empty/loading/error states (spec §7); responsive breakpoints (spec §8c); URL/query-state (spec §8b).

---

## 12. Roles, sharing, feedback, sessions, channels (2026-06-08, LOCKED)

**Roles = owner · admin · member. Owner and admin have the SAME edit power; member is the restricted one. Keep it this simple — no per-asset custom wiring.**
- Three verbs on every asset (worker / brain folder / connection / secret):
  - **See:** Private = owner + admins; Shared = whole workspace.
  - **Use / Run:** anyone who can See.
  - **Edit / Delete / Change-visibility:** the asset **owner OR any admin** (same privileges).
- A **member is the owner** of anything they create (so members do create+edit their own).
- **Member can NOT edit a shared worker they don't own** — but they get two first-class paths instead:
  1. **Feedback** (NEW): anyone who can See a worker can leave **feedback** on it (lightweight comment/thread, surfaces to the owner). A member who can't edit can still say "this is wrong / change X". This is a first-class capability — a **Feedback** action on worker detail (and optionally on a run). **Verify backend support; if missing, file for Vivek.**
  2. **Duplicate / Fork** (allowed): member can copy a shared worker to their own Private one and edit that.
- **Visibility is lightweight + internal-first.** Workspace is internal — we don't hide things; Private = organizational ("my space"), not a hard security wall. Everyone can See shared; Private is owner+admin.
- **UI:** Private/Shared is a **tag family on top** (filter "Private / Shared") AND a pill in the detail header. If you can't edit: Edit/Delete/Share simply not shown + a "View only · owned by X" line. Feedback button always shown. Same pattern everywhere — zero per-page logic.

**Skills = just a Brain folder.** No special "skill" type. A worker's bundle (SKILL.md + run.py) can be **saved into a Brain folder**; a folder can be **instantiated as a worker** ("Make worker"). Explicit publish/instantiate, **no auto-sync** between worker and folder. Brain needs nothing special — it's a folder like any other. **Skills feature is LATER (not MVP)**; Brain already accepts it.

**Emily sessions (NEW — important):** **store ALL session/chat data** (backend requirement). The Emily rail must show **chat history** (list of past chats) — today you can only New chat / Export, not browse previous chats. Add a history list to the rail (+ keep New chat / Export). **Verify backend persists sessions; if not, file for Vivek.**

**Emily widths:** rail (default) → wide (~half) → full-screen overlay, via the expand control; plus collapse.

**Channels (Slack / WhatsApp / agent-install) — NEW, needs a home + a reality check.**
- Channels = how you reach Emily/workers (inbound): Slack, WhatsApp, and "install in your agent" (MCP/CLI). Distinct from Connections (what workers reach OUT to).
- **DECISION:** Channels = a **Settings tab** (Slack · WhatsApp · Agent-install), NOT its own nav page. Rationale (the operator): **nav placement follows frequency** — Connections is high-frequency (own page); Channels is set-once/low-frequency (Settings). General principle: high-frequency surfaces get nav; set-and-forget config lives in Settings.
- **Reality check needed:** the UI says "install in WhatsApp/Slack/your agent" — does it actually work, and is setup genuinely one-step? **This must be verified (extend the agent-interface audit or a follow-up) and any gaps filed for Vivek.** Don't ship "install" UI that doesn't work.

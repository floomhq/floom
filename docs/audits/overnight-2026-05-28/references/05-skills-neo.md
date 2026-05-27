# Skills-neo UI/UX Reference Audit for Workeros

## Winner: skills-neo-ui-launch-20260526

**Reason:** 20260526 is 6 days newer (May 26 vs May 20) with polished design tokens (Cursor-style cool neutrals + blue accent #3a6ea5), improved color mix CSS (card-glass / sidebar-glass), JetBrains Mono + Inter stack, and extra surfaces (context, connections, workspace approvals).

---

## Surface Inventory (skills-neo-ui-launch-20260526)

**Route structure for /library → Workeros /workers:**
- `/library` — list view with filters, pins, sync status
- `/library/[slug]` — skill detail with tabs (runs/config/env/SKILL.md)
- `/library/new` — create skill (textarea + generate + preview flow)
- `/library/manage/[slug]` — shared library settings

**Adjacent core surfaces:**
- `/settings` — API tokens, workspaces, agent controls (system_instructions, context, activity)
- `/context` — workspace brain (notes/files for agent discovery)
- `/activity` — sync timeline (CLI pulls/pushes/invites)
- `/workspace/[slug]` — workspace detail
- Global `WorkspaceShell` sidebar with workspace switcher + nav icons

---

## Wholesale-Port Targets per Workeros Surface

### 1. `/workers` (Workeros) ← `/library` (skills-neo)
- **Source:** `/root/skills-neo-ui-launch-20260526/apps/web/components/LibraryBody.tsx` (36KB)
- **Adapt:** 
  - Swap "skill" concept → "worker" (rename classnames `libp-skill-*` → `workeros-worker-*`)
  - Keep filter UI (visibility, tags, sync status badges)
  - Reuse sync-agent icon render logic (claude, codex, cursor, gemini icons)
  - Replace skill-edit links → worker-detail links
  - Keep folder/pin structure; adapt to worker runs instead of skill versions

### 2. `/workers/<id>` detail + tabs ← `/library/[slug]`
- **Source:** `/root/skills-neo-ui-launch-20260526/apps/web/components/LibrarySkillBody.tsx` (51KB)
- **Adapt:**
  - Tab structure: `runs` (closest to skills' version history), `triggers`, `config`, `env`, `SKILL.md`
  - Reuse file browser (SKILL.md virtual file + attached files)
  - Import toggle logic for visibility (private/unlisted/public) → adapt to worker permissions
  - Reuse copy-to-clipboard for install commands → copy trigger/webhook URLs

### 3. `/workers/new` ← `/library/new`
- **Source:** `/root/skills-neo-ui-launch-20260526/apps/web/components/NewSkillBody.tsx` (18KB)
- **Adapt:**
  - Textarea for worker YAML/code (keep MD_PLACEHOLDER pattern)
  - Reuse library selector + active folder state
  - Keep visibility radio (private/unlisted/public)
  - Keep tag input with Enter/comma handling
  - Generate flow (stay similar) → could wire to worker template generator

### 4. `/settings` (Workeros) ← `/settings` (skills-neo)
- **Source:** `/root/skills-neo-ui-launch-20260526/apps/web/components/SettingsBody.tsx` (24KB)
- **Adapt:**
  - Keep table-of-contents nav (profile, tokens, workspaces, agent-controls, privacy, danger)
  - Reuse token management UI (create, delete, copy prefix, expiry date)
  - Reuse workspace list with role badges (viewer/editor/admin)
  - Agent controls copy structure (but call them "system_instructions", "context", "activity")
  - Keep profile section (joined date, skill count → swap to worker/connection count)

### 5. Global Shell (Workeros chrome) ← `WorkspaceShell`
- **Source:** `/root/skills-neo-ui-launch-20260526/apps/web/components/WorkspaceShell.tsx` (9KB)
- **Adapt:**
  - Sidebar workspace switcher (personal / shared sections)
  - Nav icons for sections (system_instructions, context, activity, skills)
  - Mobile collapse/expand behavior
  - Active section highlight (aria-current="page" pattern)
  - Workspace role badge display (your account / editor / admin)

---

## Connections Page: /connections (Workeros) vs N/A (skills-neo)

**Finding:** skills-neo does NOT have a standalone /connections page in the 20260526 build. "Connections" likely lives inside `/context` or `/workspace/[slug]` as a sub-panel.

**Recommendation for Workeros /connections:**
- Inspect `/root/skills-neo/apps/web/app/context` folder (may have connection UI)
- If not, design Workeros /connections from scratch OR adapt settings panel pattern
- Reuse token copy/revoke UI patterns from SettingsBody for connection credentials

---

## New-Worker Flow Chrome

**Source:** NewSkillBody (`/library/new`)
- **Reusable pattern:**
  - Textarea with markdown placeholder + syntax highlight
  - Real-time slug generation from title (slugifySkillName utility)
  - Tag input with Enter/comma delimiters + backspace deletion
  - Library selector dropdown (activeLibrary state)
  - Visibility radio (private/unlisted/public)
  - Save button + "saved" confirmation badge
  - All wrapped in a card-glass container (library.css style)

**File:** Import from `/root/skills-neo-ui-launch-20260526/apps/web/lib/skill-slug.ts`

---

## Anti-Ports (Floom-specific, DON'T copy)

- ❌ **Install command UI** — "npx -y @floomhq/preview install @owner/slug" 
  - PublicSkillBody line 46 is Floom CLI-specific
  - Workeros should use webhook/trigger URLs instead

- ❌ **Public skill marketplace routing** — `/@${ownerHandle}/${slug}` 
  - skills-neo has public skill pages; Workeros likely keeps workers internal
  - Don't port PublicSkillBody.tsx; skip the og-metadata route (`/app/og/skill`)

- ❌ **Floom branding in launch surfaces**
  - Line 45 of LibraryBody: `@floomhq/preview` — excise or replace with `workeros`
  - Keep the pattern; swap brand

- ❌ **Library "manage" page** (`/library/manage/[slug]`)
  - This is shared library admin; Workeros may not need it (workers are per-connection, not shared)
  - Assess if Workeros has shared worker libraries; if not, skip

---

## Concrete File Paths

### Components to port:
```
/root/skills-neo-ui-launch-20260526/apps/web/components/
  ├── LibraryBody.tsx          → workers-list.tsx
  ├── LibrarySkillBody.tsx      → worker-detail.tsx
  ├── NewSkillBody.tsx          → new-worker.tsx
  ├── SettingsBody.tsx          → settings.tsx (mostly reuse)
  ├── WorkspaceShell.tsx        → shell/sidebar (mostly reuse)
  ├── SyncStatusStrip.tsx       → reuse for worker sync badges
  └── PublicSkillBody.tsx       → SKIP (Floom-specific)
```

### Styles to port:
```
/root/skills-neo-ui-launch-20260526/apps/web/app/
  ├── globals.css               → use as design-token reference
  ├── library/library.css       → base for workers CSS
  ├── library/new/new-skill.css → base for new-worker CSS
  └── settings/settings.css     → base for settings CSS
```

### Design tokens (Tailwind + CSS vars):
```
Font stack: Inter (400–680wt) + JetBrains Mono
Color accent: #3a6ea5 (blue, not emerald)
Glass surfaces: color-mix(…, var(--paper) 38%–54%, transparent)
Radii: 3px (xs) → 13px (2xl), 999px (pill)
Transitions: 110ms (fast), 190ms (base), 320ms (slow)
```

### Utilities to port:
```
/root/skills-neo-ui-launch-20260526/apps/web/lib/
  ├── skill-slug.ts              → worker-slug.ts (rename util)
  ├── workspace-surfaces.ts      → reuse (surface registry logic)
  └── ui/library-types.ts        → adapt types (LibrarySkill → WorkerConfig, etc.)
```

---

## Single S22 PR Strategy

**Title:** "feat: port skills-neo /library → /workers (Workeros surface v1)"

**Commits (suggested order):**
1. Copy LibraryBody → WorkersBody; strip Floom branding
2. Copy LibrarySkillBody → WorkerDetailBody; adapt tabs to runs/triggers/config/env
3. Copy NewSkillBody → NewWorkerBody; swap skill-slug → worker-slug
4. Port library.css → workers.css (rename classnames)
5. Port settings.css, new-skill.css → adapt for Workeros context
6. Update types (LibrarySkill → WorkerConfig, etc.)
7. Wire routes: `/workers`, `/workers/[id]`, `/workers/new`
8. Integration test: "Can list workers, view detail, create new worker"

**Expected diff:** ~4–6 KB new component code + ~8 KB CSS + ~2 KB types = 14–16 KB net addition.


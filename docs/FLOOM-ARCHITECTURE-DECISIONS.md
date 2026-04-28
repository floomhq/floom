# Floom architecture decisions — single source of truth

Date: 2026-04-27 (forensic audit)

## Summary

Federico has raised 20+ distinct architectural decisions across sessions since 2026-04-15. Of these, **7 are fully documented in current specs**, **13 are scattered across memory, JSONL transcripts, and doc comments** (not in V26-IA-SPEC.md), and **1 critical pattern (sharing visibility + rate limits) was explicitly "raised before but got dropped from the v25 spec and surfaced again on 2026-04-27"**.

This audit surfaces all decisions, their implementation status, and gaps for the v26 launch.

---

## Decision Log (Complete)

### A. DOCUMENTED & LOCKED (7)

These appear in ARCHITECTURE-DECISIONS.md (ADR-001 through ADR-022).

#### ADR-001 — Creator analytics (private by default)

- Date raised: 2026-04-26
- Federico's quote: "your data is yours — that's the differentiator from Replit/Glitch/StackBlitz"
- Decision: Creators see aggregate run counts only. Per-run input/output sharing is opt-in.
- v1 implementation: Private by default
- v1.1+: "share with creator" toggle per run
- Status:
  - [x] Documented in ARCHITECTURE-DECISIONS.md (ADR-001)
  - [x] Implemented in backend (access control in `apps/server/src/routes/run.ts`)
  - [x] In wireframes (v23/v24 no direct UI; gated behind future modal)
- Source: docs/ARCHITECTURE-DECISIONS.md:13-18

---

#### ADR-002 — Source visibility separate from app visibility

- Date raised: 2026-04-26
- Federico's quote: "visibility and source visibility are different product axes"
- Decision: `apps.source_visible: bool` flag. Source hidden → app cannot be forked.
- v1 implementation: Source visibility toggle; forks get independent copies (GitHub semantics)
- v1.1+: same, plus fork-inherit-secrets refinement (OQ-002)
- Status:
  - [x] Documented in ARCHITECTURE-DECISIONS.md (ADR-002)
  - [x] Implemented in backend (visibility audit table, fork logic)
  - [ ] In wireframes (v23 has Share modal, but fork-vs-install CTA distinction missing)
- Source: docs/ARCHITECTURE-DECISIONS.md:22-30

---

#### ADR-003 — Workspaces and roles

- Date raised: 2026-04-26
- Federico's quote: "v1: single-user workspaces only. v1.1: multi-user team workspaces."
- Decision: Keep DB's `admin/editor/viewer` role names; earlier `admin/contributor/runner` draft was a casual rename, codex caught the mismatch.
- v1 implementation: Single user per workspace; multi-member table exists but hidden
- v1.1+: expose invites and team UI
- Status:
  - [x] Documented in ARCHITECTURE-DECISIONS.md (ADR-003)
  - [x] Implemented in backend (workspace_members table, assertRole service)
  - [x] In wireframes (hidden Team/Billing in v1, shown in future state)
- Source: docs/ARCHITECTURE-DECISIONS.md:33-42

---

#### ADR-008 — App sharing model (4 tiers, 6 states, moderated public)

- Date raised: 2026-04-26
- Federico's quote: "defaults must be private (privacy moat). Public listing requires Floom-team review."
- Decision: 6 visibility states (Private / Link-only / Invited / Pending review / Public-Live / Changes requested). Default: Private.
- v1 implementation: Private, Link-only (anonymous link + optional auth gate), Public-Live (reviewed)
- v1.1+: Invited tier (explicit members)
- Status:
  - [x] Documented in ARCHITECTURE-DECISIONS.md (ADR-008)
  - [x] Implemented in backend (visibility enum, review_status separate axis, audit table)
  - [x] In wireframes (v23 Share modal shows states; v24 updates vocabulary)
- Source: docs/ARCHITECTURE-DECISIONS.md:91-112

---

#### ADR-009 — Agents-native (4 surfaces, agent tokens unify auth)

- Date raised: 2026-04-26
- Federico's quote: "agent tokens are the single auth primitive across MCP + REST + CLI"
- Decision: Token format `floom_agent_<32-char>`. Scopes: `apps:read`, `run`, `secrets:update`, `publish`.
- v1 implementation: Web UI, MCP, REST; agent tokens in web UI + MCP
- v1.1+: CLI, workspace federation, per-app token binding
- Status:
  - [x] Documented in ARCHITECTURE-DECISIONS.md (ADR-009)
  - [x] Implemented in backend (token table, hashed at rest, per-token rate limit, bearer auth)
  - [x] In wireframes (v23/v24 agent tokens page, Copy-for-Claude snippet)
- Source: docs/ARCHITECTURE-DECISIONS.md:115-143

---

#### ADR-014 — DDoS / abuse posture

- Date raised: 2026-04-26
- Federico's quote: "don't over-engineer for launch traffic"
- Decision: v1 rate limits per IP / user / agent-token (process-local). Cloudflare WAF in v1.1 if needed.
- v1 implementation: rate-limit middleware (#783, #786 merged)
- v1.1+: global spend cap per app, WAF
- Status:
  - [x] Documented in ARCHITECTURE-DECISIONS.md (ADR-014)
  - [x] Implemented in backend (rate-limit service, process-local counters)
  - [ ] In wireframes (rate-limit UX for users shown, but no admin spend-cap UI)
- Source: docs/ARCHITECTURE-DECISIONS.md:205-216

---

#### ADR-017 — Shadcn UI adoption (post-launch v1.1, prep now)

- Date raised: 2026-04-26
- Federico's quote: "v1 ships on current custom code; v1.1 does Shadcn migration"
- Decision: ADOPT for commodity primitives (Dialog, Tabs, Dropdown, Toast, etc.); KEEP custom for Floom-voice surfaces (HeroDemo, output renderer, sharing ladder).
- v1 implementation: custom code only
- v1.1+: gradual Shadcn migration with aggressive theming override
- Status:
  - [x] Documented in ARCHITECTURE-DECISIONS.md (ADR-017)
  - [ ] Implemented in backend (N/A; UI-only)
  - [ ] In wireframes (v1 wireframes all custom; Shadcn not shown)
- Source: docs/ARCHITECTURE-DECISIONS.md:307-339

---

### B. RAISED BUT SCATTERED (NOT IN V26-IA-SPEC) (13)

These decisions exist in MEMORY.md, ARCHITECTURE-LAYER docs, or IA-FEEDBACK, but are **NOT locked in the main V26-IA-SPEC.md** and require explicit capture.

#### B1. Sharing visibility + rate limits (3-level model for ALL resources)

- Date raised: Before v24 launch (initial), re-raised 2026-04-27
- Federico's quote (from memory): "both apps and credentials (BYOK keys + Agent tokens) ship with 3-level visibility (only me / selected / public) and rate limits (per workspace member / per external caller / globally). Federico raised pre-v24, missed in v25 spec, surfaced again 2026-04-27 v26 discussion."
- Decision: Apps AND credentials (BYOK + Agent tokens) have unified 3-tier sharing model + rate limits
- v1 implementation: only me + public + global rate limit
- v1.1+: selected + per-caller rates
- Status:
  - [ ] **NOT** in V26-IA-SPEC.md (CRITICAL GAP)
  - [x] Partially in backend (visibility table for apps; per-token rate limit)
  - [ ] In wireframes (BYOK keys / Agent tokens pages do not show sharing + rate controls; deferred to v1.1)
- Source: memory/feedback_floom_sharing_rate_limits.md + IA-FEEDBACK-2026-04-27.md line 14
- **Gap**: This pattern must be documented as a mandatory design rule for all future resource types

---

#### B2. URL rework: /me → /run (URL rename + redirect strategy)

- Date raised: During L4 wireframe rounds (2026-04-24)
- Federico's quote: "canonical URLs are /run/*, /settings/*, /account/settings"
- Decision: Rename `/me/*` to `/run/*`. Keep `/me/*` as compatibility redirects forever.
- v1 implementation: URLs renamed; redirects in place (#806)
- v1.1+: same
- Status:
  - [x] Documented in ARCHITECTURE-LAYER-3-SPEC.md (full rename table, lines 9-63)
  - [x] Implemented in backend (redirects working per #806 tests)
  - [x] In wireframes (all v24+ files use new URLs)
- Source: docs/ARCHITECTURE-LAYER-3-SPEC.md:9-63

---

#### B3. Workspace tier above Run/Studio (IA hierarchy lock)

- Date raised: 2026-04-27 (v26 IA discussion, point 9)
- Federico's quote: "hierarchy is workspace, then run vs studio, then overview, apps, runs/logs"
- Decision: Workspace > (Run | Studio) > (Apps | Runs | Settings)
- v1 implementation: Left rail shows workspace name; toggle below it
- v1.1+: Workspace switcher (hidden until >1 workspace exists)
- Status:
  - [x] Documented in V26-IA-SPEC.md (line 8-19)
  - [x] Implemented in backend (active_workspace context everywhere)
  - [x] In wireframes (v24 shows workspace name in left rail, toggle below)
- Source: V26-IA-SPEC.md line 8-19 + IA-FEEDBACK-2026-04-27.md line 69

---

#### B4. Workspace name click → settings (reduce rail bloat)

- Date raised: 2026-04-27 (v26 IA discussion, point 4)
- Federico's quote: "workspace settings should open when i click the workspace name? to reduce bloat on left side?"
- Decision: Click workspace name in identity block → opens workspace settings modal/popover. Removes settings group from rail.
- v1 implementation: TBD (not yet decided if modal vs page)
- v1.1+: same
- Status:
  - [ ] **PARTIALLY** in V26-IA-SPEC.md (mentioned as proposed, not locked as decision)
  - [ ] Implemented in backend (route exists; UI not built)
  - [ ] In wireframes (v24 not updated; shows settings group still in rail)
- Source: IA-FEEDBACK-2026-04-27.md lines 30-37
- **Gap**: Needs explicit decision: modal vs page. Affects mobile drawer and desktop layout.

---

#### B5. Drop overview pages (/run vs /studio root)

- Date raised: 2026-04-27 (v26 IA discussion, point 9)
- Federico's quote: "overview pages on studio and run still can be improved but honestly we can also remove for now? apps + runs enough?"
- Decision: Remove `/run` and `/studio` overview pages. Only `/run/apps`, `/run/runs`, `/studio/apps`, `/studio/runs`.
- v1 implementation: TBD (not yet decided)
- v1.1+: may add overview with hero metric + activity in a follow-up
- Status:
  - [ ] **NOT locked** in V26-IA-SPEC.md (marked as "Open")
  - [ ] Implemented in backend (routes for overviews exist)
  - [ ] In wireframes (v24 includes overviews; would need removal)
- Source: IA-FEEDBACK-2026-04-27.md lines 73-80
- **Gap**: Federico hasn't locked this; still open. Affects landing-after-login experience.

---

#### B6. Run/Studio toggle placement (rail vs TopBar)

- Date raised: 2026-04-27 (v26 IA discussion, point 2)
- Federico's quote: "why dont we have studio / run on sidebar left as toggle instead of on top header nav?"
- Decision: Move Run/Studio from TopBar center nav to left-rail toggle (mode switcher).
- v1 implementation: TBD (currently in TopBar per L1 spec; v26 may move)
- v1.1+: same
- Status:
  - [ ] **IN FLIGHT** — V26-IA-SPEC.md lines 44-46 show it IN the left rail, confirming the move is locked
  - [ ] Implemented in backend (no backend change; UI routing is same)
  - [ ] In wireframes (v24 updated per V26-IA-SPEC, but v25 still has TopBar toggle)
- Source: IA-FEEDBACK-2026-04-27.md line 16-22 + V26-IA-SPEC.md line 44-46
- **Status**: LOCKED (move confirmed in V26-IA-SPEC)

---

#### B7. App store link on /run missing

- Date raised: 2026-04-27 (v26 IA feedback, point 7)
- Federico's quote: "where is the link to the app store on run page?"
- Decision: /run dashboard must have visible "Browse the store →" link or app-store rail item.
- v1 implementation: TBD
- v1.1+: same
- Status:
  - [ ] **NOT** in V26-IA-SPEC.md (raised as observation, not as decision)
  - [ ] Implemented in backend (no backend change; routing already exists)
  - [ ] In wireframes (v24 does not show app-store link on /run dashboard)
- Source: IA-FEEDBACK-2026-04-27.md lines 54-56
- **Gap**: Needs explicit decision on placement (rail item vs link vs card).

---

#### B8. Per-app workspace BYOK key connection

- Date raised: 2026-04-27 (v26 IA discussion, point 8)
- Federico's quote: "on app level i should be able to connect them from workspace? so secrets tab on app is required?"
- Decision: Studio app secrets page has TWO sections — App creator secrets + Workspace BYOK key requirements.
- v1 implementation: TBD (v25 has only per-app secrets)
- v1.1+: same
- Status:
  - [ ] **NOT** in V26-IA-SPEC.md (raised as question, not locked as decision)
  - [ ] Partially implemented in backend (workspace_secrets table exists; per-app selection missing)
  - [ ] In wireframes (v24 studio-app-secrets.html not updated)
- Source: IA-FEEDBACK-2026-04-27.md lines 58-66
- **Gap**: Needs explicit decision on UI: dropdown to select BYOK keys? multi-select? required?

---

#### B9. Locked vocabulary (3 credential families)

- Date raised: Pre-v24 (referenced in memory, confirmed in v25/v26)
- Federico's quote (from MEMORY.md CRITICAL section): "Vocabulary: BYOK keys + Agent tokens (NEVER 'API keys')"
- Decision: Three credential families, locked names:
  - BYOK (Bring Your Own Key) — user's own Gemini/OpenAI key
  - Agent tokens — workspace-scoped auth for MCP/REST/CLI
  - App creator secrets — per-app embedded secrets
- v1 implementation: All three shipped with locked names
- v1.1+: same
- Status:
  - [x] Documented in MEMORY.md (CRITICAL section, line 114)
  - [x] Implemented in backend (three tables: workspace_secrets, agent_tokens, app_creator_secrets)
  - [x] In wireframes (v24 pages use locked names)
- Source: MEMORY.md line 114 + LAUNCH-STATUS.md line 114 ("BYOK keys + Agent tokens")

---

#### B10. Single emerald accent color

- Date raised: Pre-v24 (color system established)
- Federico's quote (from LAUNCH-STATUS): "single emerald accent"
- Decision: Single accent color (emerald green) for CTAs, toggles, links. No category tints on banners.
- v1 implementation: `--accent: emerald` in CSS; all CTAs use it
- v1.1+: same (may add dark mode variant)
- Status:
  - [x] Documented in LAUNCH-STATUS.md (line 116, design non-negotiables)
  - [x] Implemented in backend (CSS variable, used everywhere)
  - [x] In wireframes (v24 all pages use emerald)
- Source: LAUNCH-STATUS.md line 116

---

#### B11. Light cream banners (no category tints)

- Date raised: Pre-v24 (design system)
- Federico's quote (from LAUNCH-STATUS): "no category tints on banners (single neutral palette)"
- Decision: Banners use neutral palette (cream/light background). No colored left borders, no per-category tints.
- v1 implementation: All banners use neutral background + light gray or dark text
- v1.1+: same
- Status:
  - [x] Documented in LAUNCH-STATUS.md (line 116)
  - [x] Implemented in backend (CSS for banner components)
  - [x] In wireframes (v24 banners all neutral)
- Source: LAUNCH-STATUS.md line 116

---

#### B12. Mobile drawer order (Workspace / Run / Studio / Settings / Account)

- Date raised: 2026-04-27 (L4 round 6: mobile design, task #82)
- Federico's quote: (from ADR-018 and ARCHITECTURE-LAYER-3-SPEC line 61)
- Decision: Mobile drawer groups: Workspace identity, Run, Studio, Workspace settings, Account. Not a separate "Settings" group.
- v1 implementation: Mobile drawer built per spec
- v1.1+: same
- Status:
  - [x] Documented in ARCHITECTURE-LAYER-3-SPEC.md (line 61, mobile-menu.html update)
  - [x] Implemented in backend (no backend; mobile drawer is client-side)
  - [x] In wireframes (v24 mobile-menu.html shows new order)
- Source: ARCHITECTURE-LAYER-3-SPEC.md line 61 + ADR-018

---

#### B13. Three surfaces parity rule (Web / MCP / HTTP)

- Date raised: 2026-04-26 (agents-native design, ADR-009)
- Federico's quote: "agent tokens are the single auth primitive across MCP + REST + CLI"
- Decision: Any feature shipping on Web must also ship on MCP and HTTP (or have explicit defer). Auth, scopes, and token model unified across surfaces.
- v1 implementation: Web UI, MCP, REST all use same token + scope model
- v1.1+: CLI added with same auth
- Status:
  - [x] Documented in ARCHITECTURE-DECISIONS.md (ADR-009)
  - [x] Implemented in backend (three routes: web session, MCP, REST; same auth logic)
  - [ ] In wireframes (not explicitly shown; implicit in design)
- Source: docs/ARCHITECTURE-DECISIONS.md line 115-143

---

### C. WIREFRAME-ONLY / UNCHALLLENGED (4)

These appear in wireframes and docs but haven't been explicitly locked by Federico as decisions. Listed for completeness.

#### C1. App "fork" vs "install" vs "run" CTAs (semantic distinction)

- Status: In v23/v24 wireframes but no explicit ADR or lock
- Source: studio-app-access.html + app-page.html (wireframe distinction between fork, install, run buttons)
- Needed: Explicit decision on CTA semantics and when each appears

---

#### C2. Members + Billing v1.1 deferral (hidden in v1)

- Status: In all docs as deferred; not contested
- Source: ARCHITECTURE-LAYER-3-SPEC.md lines 69-70 (Members [v1.1], Billing [v1.1])
- Needed: Confirm no v1 creep; ensure hidden in wireframes

---

#### C3. ICP profile (non-dev AI engineer)

- Status: In PRODUCT.md (line 9-13) as locked ICP
- Source: PRODUCT.md line 9-13
- Needed: Ensure all v1 features serve this ICP; no accidental dev-focused scope

---

#### C4. Tagline lock ("Ship AI apps fast." / "The protocol + runtime for agentic work.")

- Status: In MEMORY.md project_floom_positioning (locked 2026-04-18)
- Source: MEMORY.md line 193
- Needed: Ensure landing, docs, and marketing copy align

---

## Gaps Detected

### CRITICAL (v26 launch blocker risk)

1. **Sharing visibility + rate limits model not in V26-IA-SPEC.md** (Raised pre-v24, dropped in v25, re-raised 2026-04-27)
   - ISSUE: Three-level visibility + rate limits for ALL resources is a foundational pattern but not documented as a design rule. When new resource types ship (future: integrations, webhooks, etc.), teams won't know to apply it.
   - FIX: Add section to V26-IA-SPEC.md locking the 3-tier model as mandatory for all future resources

2. **B4 (Workspace name click) not locked** — modal vs page decision needed
   - ISSUE: IA feedback suggests it but doesn't confirm. V24 wireframes still show rail group.
   - FIX: Get explicit decision (modal vs page) and update v26 wireframes

3. **B5 (Drop overview pages) not locked** — still marked "Open" in IA-FEEDBACK
   - ISSUE: Landing-after-login experience unclear. Affects whether /run and /studio are empty or have hero metrics.
   - FIX: Get explicit decision before wireframing v26

4. **B7 (App store link on /run) raised but no placement decision** — v24 wireframes missing it
   - ISSUE: /run dashboard has no visible path to app store. Currently you can only browse from /apps or TopBar.
   - FIX: Decide placement (rail item? card? link?) and update v26

---

### HIGH (v1 launch quality)

5. **B8 (Per-app workspace BYOK key connection) raised but not implemented**
   - ISSUE: Studio app secrets page should let creators declare "this app uses workspace BYOK keys" but UI not built.
   - FIX: Implement dual-section secrets tab before v1 launch

6. **B6 (Run/Studio toggle) — move to rail confirmed but v25 wireframes still show TopBar**
   - ISSUE: V25 wireframes have TopBar toggle. V26 should move it. Risk: code lands before wireframes update.
   - FIX: Ensure v26 wireframes generated per V26-IA-SPEC before React work

---

### MEDIUM (v1.1 planning)

7. **OQ-002 (Fork inherits creator secrets)** — leaning to "detach" but tension between zero-friction and cost accountability
   - ISSUE: When user forks an app, do they inherit the creator's secret references or must they add their own?
   - FIX: Get explicit decision and document in ADR-002 follow-up

8. **OQ-003 (Agent token binding scope)** — currently workspace-only, refinement deferred to v1.1
   - ISSUE: Should tokens optionally bind tighter (workspace + app, or workspace + scope subset)?
   - FIX: Schedule for v1.1 planning; document in OQ section as expected refinement

---

## Process Recommendation

### Immediate (v26 launch this week)

1. **Lock B4 + B5** — Get Federico's explicit decision on workspace-name-click (modal vs page) and overview-pages (drop or keep).
   - Time: 15-min conversation
   - Impact: Blocks v26 wireframe generation if decisions change

2. **Add sharing + rate limits rule to V26-IA-SPEC.md**
   - Template: "All resource types (apps, BYOK, Agent tokens, and future resources) ship with 3-tier visibility (only me / selected / public) + rate-limit controls (per member / per caller / global). v1: only me + public + global. v1.1: selected + per-caller."
   - Time: 10 min
   - Impact: Prevents future drift on new resource types

3. **Verify B6 (rail toggle) in v26 wireframes**
   - Check: Does v26 show Run/Studio toggle in left rail, not TopBar?
   - Time: codex spot-check
   - Impact: Ensure wireframes align with V26-IA-SPEC.md

4. **Implement B8 (dual-section secrets tab) before launch**
   - Scope: Studio app secrets page, add "Workspace BYOK key requirements" section below app creator secrets
   - Time: ~4h (codex backend + Claude UI)
   - Impact: Unblocks full v1 app creator flow

---

### Short-term (v1.1 planning, this month)

5. **Schedule ADR-023 for OQ-002 (fork secret inheritance)**
   - Options: (1) Detach secrets (cost accountability), (2) Inherit with warning (zero-friction)
   - Time: 30-min decision + documentation
   - Impact: Unblocks fork UX refinement

6. **Schedule ADR-024 for OQ-003 (token binding scope refinement)**
   - Current: workspace-only
   - Future: workspace + app? workspace + scope-subset?
   - Time: Research usage patterns post-launch; decision TBD
   - Impact: Informs v1.1 agent token UI

---

### Ongoing (governance)

7. **Add architecture decision to launch checklist**
   - When a new resource type or surface ships, verify it has:
     - [ ] Visibility tier decision documented
     - [ ] Rate limit strategy documented
     - [ ] Multi-surface parity (Web / MCP / HTTP if applicable)
   - Time: Add to CI/CD merge gate
   - Impact: Prevents future drift like sharing + rate limits

8. **Monthly ADR review**
   - Set calendar reminder to re-read ARCHITECTURE-DECISIONS.md + open questions
   - Promote OQ → ADR when locked by Federico
   - Time: 30 min/month
   - Impact: Keeps docs in sync with decisions

---

## Summary Table: Decisions Audit

| Topic | Date | Locked? | In V26-IA-SPEC? | Implemented? | Wireframed? | Gap |
|-------|------|---------|-----------------|--------------|-------------|-----|
| Creator analytics (ADR-001) | 2026-04-26 | Yes | Yes | Yes | Partial | None |
| Source visibility (ADR-002) | 2026-04-26 | Yes | Yes | Yes | Yes | Fork semantics need refinement (OQ-002) |
| Workspaces + roles (ADR-003) | 2026-04-26 | Yes | Yes | Yes | Yes | None |
| App sharing 6 states (ADR-008) | 2026-04-26 | Yes | Yes | Yes | Yes | None |
| Agent tokens (ADR-009) | 2026-04-26 | Yes | Yes | Yes | Yes | None |
| DDoS posture (ADR-014) | 2026-04-26 | Yes | Yes | Yes | Partial | Spend-cap UI deferred |
| Shadcn adoption (ADR-017) | 2026-04-26 | Yes | Yes (post-v1) | No | No | Prep done; actual migration in v1.1 |
| **Sharing + rate limits (B1)** | **Pre-v24** | **No** | **NO (CRITICAL)** | **Partial** | **No** | **Add to V26-IA-SPEC as mandatory rule** |
| URL rework /me→/run (B2) | 2026-04-24 | Yes | Yes | Yes | Yes | None |
| Workspace tier hierarchy (B3) | 2026-04-27 | Yes | Yes | Yes | Yes | None |
| **Workspace-name-click (B4)** | **2026-04-27** | **No** | **No** | **No** | **No** | **Need modal vs page decision** |
| **Drop overview pages (B5)** | **2026-04-27** | **No** | **No** | **No** | **No** | **Need explicit lock** |
| Rail toggle placement (B6) | 2026-04-27 | Yes (by V26-IA-SPEC) | Yes | No | ? | Verify in v26 wireframes |
| **App store link on /run (B7)** | **2026-04-27** | **No** | **No** | **No** | **No** | **Need placement decision + wireframe** |
| **Per-app BYOK key connect (B8)** | **2026-04-27** | **No** | **No** | **Partial** | **No** | **Implement dual-section secrets UI** |
| Locked vocabulary (B9) | Pre-v24 | Yes | Yes | Yes | Yes | None |
| Emerald accent (B10) | Pre-v24 | Yes | Yes | Yes | Yes | None |
| Light cream banners (B11) | Pre-v24 | Yes | Yes | Yes | Yes | None |
| Mobile drawer order (B12) | 2026-04-27 | Yes | Yes | Yes | Yes | None |
| Three surfaces parity (B13) | 2026-04-26 | Yes | Yes | Yes | Implicit | None |

**TOTAL: 21 decisions identified. 7 fully locked + documented. 13 scattered or incomplete. 1 critical pattern (B1) needs urgent capture.**

---

## How to Use This Document

### For Federico
- Skim the **Summary Table** to verify nothing critical was missed
- Review **Gaps Detected: CRITICAL** section for v26 launch blockers
- Confirm decisions B4, B5, B7 (still open) before wireframe generation

### For codex/Claude doing v26 wireframes
- Check that v26 wireframes implement decisions per the table above
- Specifically: B4 (workspace-name-click), B6 (rail toggle), B7 (app-store link)
- Flag if B5 (drop overviews) is locked; update IA accordingly

### For future feature work
- Any new resource type (integrations, webhooks, etc.) must apply the B1 pattern (3-tier visibility + rate limits)
- Reference the mandatory pattern when proposing new surfaces
- Add new ADR when design differs from B1

### For launch readiness checklist
- Verify all decisions except OQ items are shipped by Tuesday
- Flag B4, B5, B7, B8 as v26 sprint work
- Confirm no decisions were dropped between v25 and v26

---

## Appendix: Open Questions (Not Yet Locked)

These are tracked in ARCHITECTURE-DECISIONS.md but included here for cross-reference:

- **OQ-001**: Workspace analytics access in v1.1 (who sees runs: all members, editors+, admins only?)
- **OQ-002**: Fork inherits creator secrets or must detach? (tension between zero-friction and cost accountability)
- **OQ-003**: Agent token binding scope — workspace-only (v1) vs workspace+app or workspace+scope-subset (v1.1)?
- **OQ-004**: Revoked workspace member tokens — auto-revoke or keep working? (default lean: auto-revoke)
- **OQ-005**: Self-host identity federation — local-only (v1) or federate to cloud (v2)?
- **OQ-006**: API deprecation policy — semver vs best-effort vs floor-N-versions?
- **OQ-007**: BYOK cost tracking + surface — track spend and surface in /me (v1.1)?
- **OQ-008**: Outage UX when runner is down but web is up
- **OQ-009**: Public content + abuse policy specifics (Acceptable Use Policy, reporting, appeals)
- **OQ-010**: DMARC policy for floom.dev (p=none, p=quarantine, p=reject?)

---

## ADR-22 to ADR-33 — locked 2026-04-27 (Federico + claude + codex synthesis)

Codex (gpt-5.5) and claude independently produced 12 backend recommendations; Federico locked the synthesis. Codex picks taken for Q1-9, Q11, Q12. Q10 = claude's nuanced split (strict review for public-visibility only).

### ADR-22 — Job queue v1.1 stays SQLite

Keep the existing SQLite-backed polling queue (`apps/server/src/services/jobs.ts`, `nextQueuedJob()`/`claimJob()`). BullMQ/Redis adds infra burden without a v1.1 requirement; migrate only if measured SQLite contention, multi-node workers, or queue latency targets force it. Default timeout 30 min already wired.

### ADR-23 — Rate-limit ADR-21 enforcement augments existing middleware

Enforce per-(workspace, app, scope) limits from ADR-21 by augmenting `apps/server/src/lib/rate-limit.ts` (existing in-memory sliding-window middleware), not by adding a separate limiter. Add policy lookup/config keyed on workspace_id + app_id + scope while preserving current `ip / user / app / agent_token / mcp_ingest` defaults as fallbacks.

### ADR-24 — `resource_shares` table for "selected" visibility (v1.1)

Generic table:
```sql
CREATE TABLE resource_shares (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  resource_kind TEXT NOT NULL CHECK (resource_kind IN ('app', 'workspace_secret', 'agent_token')),
  resource_id TEXT NOT NULL,
  principal_kind TEXT NOT NULL CHECK (principal_kind IN ('user', 'workspace_member', 'email')),
  principal_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'viewer',
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_resource_shares_lookup ON resource_shares(resource_kind, resource_id);
CREATE INDEX idx_resource_shares_principal ON resource_shares(principal_kind, principal_id);
```
v1.1 ships population only for apps; same shape unblocks future per-secret/per-token sharing.

### ADR-25 — Per-caller rate-limit counter key

Counter key is `(workspace_id, app_id, scope, caller_kind, caller_id)`:
- `caller_kind = 'agent_token'` → `caller_id = agent_token_id`
- `caller_kind = 'cookie'` → `caller_id = device_id` (with authenticated `user_id` recorded for analytics)
- `caller_kind = 'anon'` → `caller_id = normalized_ip`

### ADR-26 — App memory keys declared in manifest

Manifest schema:
```json
{
  "memory": {
    "keys": {
      "user_pref": { "type": "string", "maxBytes": 1024, "ttlDays": 365, "description": "..." },
      "history":   { "type": "array",  "maxBytes": 32768 }
    }
  }
}
```
Writes to undeclared keys → `400 Bad Request: memory key X not declared in manifest`. Keys absent from the manifest are unavailable to the app at read time.

### ADR-27 — Trigger ingress path uses opaque hashed token

`/hook/:path` where `:path` = random 24-byte URL-safe token, generated per trigger row. Server stores the **hash** (sha256), not the plaintext. Plaintext is shown to the creator once at trigger creation. Optional `label` field stores a human-readable name for UI display. No enumeration, no creator-controlled slug.

### ADR-28 — OAuth providers v1: Google + Email/Password only

GitHub OAuth deferred to v1.1. v1 ships:
- Email/Password (Better Auth default)
- Google OAuth (verified end-to-end Track C, creds in `floom-preview-launch` container env)

GitHub remains hidden until creds, callback config, and login regression tests are all complete.

### ADR-29 — Workspace switcher UX (v1.1)

Chevron `▾` in the WorkspaceIdentityBlock opens an anchored dropdown (not a modal) listing workspaces with the active one highlighted, plus `+ New workspace` and `Workspace settings` entries. v1 hides the chevron because there's only one workspace per user.

### ADR-30 — Output renderer caps

- Runner-level cap: persist full output up to 1MB encoded JSON.
- UI rendering cap: render the **first 100 top-level items OR first 256KB**, whichever hits first.
- Beyond cap: show "Showing 1 of N · Download JSON" link + copy controls for the full retained payload.

### ADR-31 — App publish lifecycle (split by visibility)

Existing schema: `publish_status ∈ {pending_review, published, rejected}`.

Lifecycle:
- New app → `pending_review`
- Admin approves → `published`; rejects → `rejected`
- Rejected app can be resubmitted → `pending_review`

**Edit-after-publish behaviour depends on visibility**:
- `visibility = public` (live on /p/:slug) → edit creates a new version row going to `pending_review`. Public /p/:slug serves the latest **published** version until a newer version is approved. Strict review keeps the public store quality high.
- `visibility = only_me` / `selected` (workspace-scoped) → edit updates the existing row, `updated_at` bumps, no re-review needed. Owner is the sole consumer.

### ADR-32 — App memory size cap

64KB hard cap per `(workspace, app, user, key)` JSON value. Reject writes over the cap with `400 Bad Request: memory value exceeds 64KB cap`. Cap is per-key, not per-blob — creators can declare multiple keys.

### ADR-33 — DEK rotation policy

No automatic DEK rotation in v1. Documented manual procedure for v1.1:

1. Generate new DEK
2. Re-encrypt affected ciphertext in batches with the new DEK
3. Verify row counts + checksums match
4. Mark old DEK `decrypt-only` during migration (still reads, no writes)
5. Retire old DEK after successful verification + grace period

KEK rotation handled separately at the env-var layer.


# S22 — Reference-based Workeros redesign plan

**Created:** 2026-05-28
**Status:** DRAFT — awaiting the operator sign-off before any code lands
**Replaces:** the brute-force piecemeal fixes shipped in S15-S20

## Why this exists

the operator verdict on the current Workeros UI: "still looking really bad" and "manual / brute force." Earlier polish batches (S15-S20) shipped one fix at a time without a coherent design source. Result: pages look adjacent, not unified. The fix is wholesale ports from polished references, not more piecemeal patches.

This doc maps every Workeros surface to its lift source, with concrete file paths. Six parallel reference surveys (referenced below) fed into it.

## Surface → lift source decision matrix

| Workeros surface | Primary lift source | Supplemental | License | Confidence |
|---|---|---|---|---|
| Global chrome (sidebar + header + theme) | skills-neo-ui-launch-20260526 `WorkspaceShell.tsx` | openchat-v2 `app-sidebar.tsx` + theme-toggle | local + local | HIGH |
| Cmd-K palette | openchat-v2 `command-history.tsx` + `ui/command.tsx` | shadcn primitive | local + MIT | HIGH |
| `/workers` list | skills-neo `LibraryBody.tsx` (36 KB) | Tremor `SparkAreaChart` + `Tracker` per row | local + Apache 2.0 | HIGH |
| `/workers/<id>` config tabs (config/env/triggers/SKILL.md) | skills-neo `LibrarySkillBody.tsx` (51 KB) | openchat-v2 `ui/tabs.tsx` | local + local | HIGH |
| `/workers/<id>` IN-PROGRESS RUN | Trigger.dev `runs.$runParam/route.tsx` ResizablePanelGroup + `RunTimeline.tsx` | vercel/ai-elements `<Tool>` + `<Terminal>` + `<StackTrace>` for transcript content | Apache 2.0 + MIT | HIGH |
| `/workers/<id>/runs/<run_id>` completed run detail | Trigger.dev split-pane (same as above) | vercel/ai-elements components for transcript; Trigger.dev `LogDetailView` for logs tab | Apache 2.0 + MIT | HIGH |
| `/workers/new` | skills-neo `NewSkillBody.tsx` (18 KB) | prompt-kit `<PromptInput>` for spec textarea (already vendored in openchat-v2) | local + MIT | HIGH |
| `/connections` | shadcn Card + Badge primitives (bespoke layout — no direct analog in any reference) | Inngest `/apps` pattern as reference (NO code copy — SSPL); Composio provider logos already wired | MIT primitives | MEDIUM |
| `/runs` global history | Kiranism `next-shadcn-dashboard-starter` TanStack DataTable + nuqs URL filters | Trigger.dev `RunFilters` patterns; Tremor `BarList` for top-failing | MIT + Apache 2.0 | HIGH |
| `/settings` | skills-neo `SettingsBody.tsx` (24 KB) | Cal.com IA pattern reference only (NO code copy — AGPL) | local | HIGH |

## Pattern-only references (NEVER copy code)

| Reference | License risk | Use as |
|---|---|---|
| Inngest `RunDetailsV3`, `RunsPage`, `FunctionConfiguration`, `Apps` | SSPL (forces open-source the whole stack on copy) | UX spec for run-detail trace tree pulse, infinite-scroll filter bar |
| dub.co `@dub/ui` | AGPL-3.0 (viral) | analytics dashboard pattern reference |
| Cal.com settings | AGPL-3.0 (viral) | settings IA reference (nested sub-nav, token mgmt, danger zone) |
| LangGraph Studio | closed-source | timeline-rows-not-bubbles paradigm for agent runs |

## Backend protocol decision — adopt AI SDK part-type union

The biggest single UX leverage point is **changing the AgentDriver wire format** to emit AI SDK-style parts over SSE:

```ts
type Part =
  | { type: "text"; text: string }
  | { type: "tool-call"; toolName: string; args: unknown; callId: string }
  | { type: "tool-result"; callId: string; result: unknown; isError: boolean }
  | { type: "reasoning"; text: string }
  | { type: "step-start"; stepNumber: number }
```

Why this matters:
- Frontend uses Vercel AI SDK `useChat` directly → live streaming for free, retries for free, type safety per tool
- vercel/ai-elements `<Tool>`, `<Terminal>`, `<StackTrace>` components map 1:1 to part types
- No custom event schema invented → less code to maintain, less to break
- Trigger.dev's `runs.$runParam.stream/route.tsx` SSE pattern is the reference

Cost: AgentDriver currently writes JSONL transcript at end of run; needs to also stream parts as they happen. This is a Codex lane (backend-aware), not Claude.

## Foundation decisions to settle before porting (DISCUSS WITH FEDERICO)

These conflict between reference sources. Each needs a pick.

### D1 — Font stack
- skills-neo uses **Inter + JetBrains Mono**
- openchat-v2 (already in Workeros S20) uses **Geist + Geist Mono**
- **Recommendation:** keep Geist + Geist Mono (already shipped, S20 matte palette built around it; Geist is Vercel-canonical). Override skills-neo when porting.

### D2 — Blue accent token
- skills-neo uses `#3a6ea5` (Cursor blue, warm-cool)
- Workeros S20 currently uses `oklch(0.52 0.13 250)` light / `oklch(0.72 0.14 250)` dark (Floom blue)
- **Recommendation:** keep current Floom blue. Override skills-neo blue when porting.

### D3 — Surface treatment
- skills-neo uses glass surfaces (`color-mix(var(--paper) 38-54%, transparent)`)
- openchat-v2 / Workeros S20 use solid matte
- **Recommendation:** stay solid matte (cleaner, less framework-fragile). Override skills-neo glass when porting.

### D4 — Tremor analytics in S22 or defer?
- Tremor sparklines on `/workers` rows + KPI cards + BarList on `/runs` would be high-impact
- Cost: medium — needs run-history aggregation in API
- **Recommendation:** defer to S23. S22 already large.

### D5 — Cmd-K palette in S22 or defer?
- openchat-v2 has command-history.tsx ready to fork
- Adds polish but isn't a release-gate flow
- **Recommendation:** ship in S22 as a freebie (the chrome PR already touches the layout).

### D6 — Sequencing
Two viable shapes:
- **A. One mega-PR (S22):** lands everything as a coherent redesign. Easier to review as a whole, but high blast radius. Reverting requires reverting everything.
- **B. Sequenced PRs S22a-S22f:** ship surface-by-surface. Each is independently shippable + reversible. Slower per-surface, but each lands faster.
- **Recommendation:** B (sequenced). Order below.

## PR sequence (recommended, all in worktrees per shared-checkout rule)

| # | Worktree | Lane | Scope | LoC est. | Source |
|---|---|---|---|---|---|
| **S22a** | `/tmp/workeros-s22a-chrome` | Claude | Global shell: WorkspaceShell-style sidebar + header + theme + Cmd-K. Land base for everything else. | ~600 | skills-neo + openchat-v2 |
| **S22b** | `/tmp/workeros-s22b-workers` | Claude | `/workers` list (LibraryBody port) + `/workers/<id>` config tabs (LibrarySkillBody port). Skip running-state for now. | ~1500 | skills-neo |
| **S22c** | `/tmp/workeros-s22c-newworker` | Claude | `/workers/new` (NewSkillBody port) + prompt-kit PromptInput vendoring | ~700 | skills-neo + prompt-kit |
| **S22d** | `/tmp/workeros-s22d-rundetail` | Codex | Backend: AgentDriver SSE part-type stream. Frontend: Trigger.dev split-pane + ai-elements `<Tool>`/`<Terminal>`/`<StackTrace>` transcript. THE big UX win. | ~2000 | Trigger.dev + ai-elements |
| **S22e** | `/tmp/workeros-s22e-runs` | Claude | `/runs` global list (Kiranism DataTable + nuqs URL filters) | ~800 | Kiranism |
| **S22f** | `/tmp/workeros-s22f-conn-settings` | Claude | `/connections` polish + `/settings` (SettingsBody port). Settings IA reference Cal.com (pattern only) | ~1000 | skills-neo + bespoke |

Total: ~6600 LoC, 6 PRs.

After all six: Lane C verification (multi-agent), Lane D worker smoke, release-gate matrix.

## Out of scope for S22 (deferred to S23+)

- Tremor analytics layer (sparklines, KPI cards, BarList) — needs API support
- Trigger.dev TRQL-style query builder — overkill for v0
- Bulk actions on /runs — premature
- Public worker marketplace (skills-neo PublicSkillBody) — Workeros is single-user v0

## Non-negotiable license rules

- **NEVER copy SSPL code** (Inngest) — § 13 force-opens our entire service stack. Patterns only.
- **NEVER copy AGPL code** (dub.co, Cal.com) — viral. Patterns only.
- Apache 2.0 (Trigger.dev, Tremor, vercel/ai-elements, Vercel chatbot) and MIT (prompt-kit, Kiranism, shadcn/ui) are safe to lift with attribution.

## Discussion checkpoints before code

the operator decides:
1. D1-D5 above (font, blue, surface, Tremor, Cmd-K)
2. Mega-PR vs sequenced (D6)
3. Whether the AI SDK part-type protocol change is in S22d scope (high impact, real backend work) or a separate Codex PR
4. Whether to keep `/connections` bespoke or commission a 7th survey for it
5. Anything to add to the OUT OF SCOPE list

Once those land, S22a starts.

## Sources
- `references/01-trigger-dev.md` — Apache 2.0, primary for run detail
- `references/02-inngest.md` — SSPL, pattern-only
- `references/03-vercel-templates.md` — prompt-kit (MIT), Kiranism dashboard (MIT), Tremor (Apache 2.0)
- `references/04-openchat-v2.md` — local, primitives + chrome plumbing
- `references/05-skills-neo.md` — local, primary for /workers /workers/<id> /workers/new /settings
- `references/06-agent-loop-ui.md` — vercel/ai-elements (MIT) for transcript components

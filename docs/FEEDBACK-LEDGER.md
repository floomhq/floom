# the operator's feedback ledger — Workeros session 2026-05-28/29

Single source of truth for every concrete UI / product / runtime callout the operator made this session, with true status as of **2026-05-29 reconcile**.

> **Authoritative tracker for current open work: `WORKPLAN-20260529-road-to-100.md`**
> This ledger records the historical feedback items and whether they shipped. For what is actively in flight or genuinely open today, read the WORKPLAN.

## Summary (2026-05-29 reconcile)

**72 items total — 65 shipped, 7 genuinely open (see WORKPLAN)**

Genuinely open items (all tracked in WORKPLAN-20260529-road-to-100.md):
1. **E5** — Import the operator's 17 existing stdio MCPs from cursor/.claude configs (verdict done, import not shipped)
2. **E7** — Stdio transport support in E2B sandbox (verdict published, implementation open)
3. **M5** — Cloud agent vendoring + Supabase JWT + RLS + Stripe (separate Cloud lane, not OS)
4. **O2** — GITHUB_PAT secret missing on prod (github-digest worker needs it; needs the operator to set)
5. **O7** — Full S41 stdio integration (MCP tab ✅; stdio import flow genuinely open)
6. **WORKPLAN 1.5.1** — Approve/reject endpoint must transition original run status off pending_approval
7. **WORKPLAN 1.5.2-1.5.5** — Correctness/data-hygiene items (zombie overview links, audit runs, worker count mismatch, robots.txt/favicon)

---

## Legend

- ✅ **Shipped** — merged to main, live on workers.floom.dev
- ❌ **Genuinely open** — not shipped as of 2026-05-29; tracked in WORKPLAN
- ~~🚧~~ / ~~⏸~~ — stale status cleared in this reconcile

---

## A. Runtime + backend quality

| # | the operator's callout | Status | Where |
|---|---|---|---|
| A1 | SQLite WAL + concurrency hardening (DB locks from S34) | ✅ | PR #163 |
| A2 | Graceful shutdown — runs land `error_code=interrupted_by_restart`, E2B sandbox killed | ✅ | PR #164 |
| A3 | OOM classification (`error_code=sandbox_oom`) | ✅ | PR #165 |
| A4 | Hourly backups + disk-guard + artifact rotation + restore drill | ✅ | PRs #166-#168 |
| A5 | `/metrics` Prometheus + `/health` deep checks | ✅ | PR #169 |
| A6 | Silent-failure audit doc | ✅ | PR #170 |
| A7 | Async architecture / Vercel 60s explained in plain language | ✅ | `docs/architecture/prod-architecture-verdict-2026-05-29.md` — verdict written, on main |

## B. /overview page

| # | Callout | Status | Where |
|---|---|---|---|
| B1 | Outcome-shaped tiles (not infra counters) | ✅ | PR #156 |
| B2 | "Worker keeps failing" must name the worker + cause | ✅ | PR #176 (S39) |
| B3 | Page left the design system (warm tokens applied /overview only) | ✅ | PR #180 (S43) — rolled app-wide |
| B4 | Red AI-slop cards (colored left border + warm-tint bg) | ✅ | PR #180 strip removed |
| B5 | Single-screen fit, no scroll needed | ✅ | PR #187 (S45) — overview compression |
| B6 | Metric tiles get sparklines | ✅ | PR #187 (S45) — AlertsBell + sparkline tiles |
| B7 | "Needs attention" → notifications-style button top-right | ✅ | PR #187 (S45) — AlertsBell top-right |
| B8 | "Last 7 days" redundant with sparklines | ✅ | PR #187 (S45) — subtitle dropped |

## C. /workers list

| # | Callout | Status | Where |
|---|---|---|---|
| C1 | Workers = employees (name + trigger + tools + last result + needs-attention) | ✅ | PR #185 |
| C2 | Cards too tall (h-16 reserved hover block waste) | ✅ | PR #185 — ~160-180px |
| C3 | No tool-logos on cards (Langdock pattern) | ✅ | PR #185 — strip + AI icon + N |

## D. /workers/<id> detail + edit

| # | Callout | Status | Where |
|---|---|---|---|
| D1 | Back arrow + About-as-separate-tab + Triggers inline cron + Apps tab | ✅ | PR #141 (earlier) |
| D2 | Triggers panel duplicated (ConfiguredTriggersSummary + editor) | ✅ | PR #177 — summary deleted, list pattern shipped |
| D3 | `+ Add trigger` placement ABOVE configured triggers | ✅ | PR #179 (S42-followup) |
| D4 | `/edit` shell fundamentally different from detail tabs | ✅ | PR #177 — `?edit=1` toggle, kill /edit route |
| D5 | Multiple-triggers UX (n8n list summary rows, click-to-expand) | ✅ | PR #179 |

## E. /connections

| # | Callout | Status | Where |
|---|---|---|---|
| E1 | "Reconnect" button shown on every row even when active | ✅ | PR #194 |
| E2 | Account names show "Connected account" or UUID slice, not real email | ✅ | PR #194 |
| E3 | "default scopes" hardcoded, never real granted scopes | ✅ | PR #194 |
| E4 | MCP servers as own tab (not mixed with OAuth) | ✅ | PR #206 (S41) — MCP tab on /connections |
| E5 | Integrate his 17 existing stdio MCPs from cursor/.claude configs | ❌ | Stdio verdict done (`docs/architecture/mcp-stdio-verdict-2026-05-29.md`); import flow not yet shipped |
| E6 | One-command MCP add (`floom mcp add github`) + paste-JSON + catalog | ✅ | PR #206 (S41) — MCP tab with shareable links + paste-JSON |
| E7 | Stdio transport support in sandbox | ❌ | Verdict: Path A (hybrid). Implementation not shipped. Open in WORKPLAN. |

## F. /runs + run detail

| # | Callout | Status | Where |
|---|---|---|---|
| F1 | Grouped-by-day table, per-row failure reason inline | ✅ | PR #159 |
| F2 | Run detail surfaces outputs + files + download | ✅ | PR #158 |
| F3 | Run detail empty pane reserved 520px dead height | ✅ | PR #171 |

## G. /contexts (S36 + S46)

| # | Callout | Status | Where |
|---|---|---|---|
| G1 | Contexts as folder, mounted into sandbox, any file type | ✅ | PRs #172-#175 (S36) |
| G2 | MCP exports for contexts (read/write/list) | ✅ | PR #175 |
| G3 | Seed worker-author-style context content | ✅ | Direct write 2026-05-28 |
| G4 | ANTI-PATTERNS.md content with no emoji slop | ✅ | Direct write — Don't:/Do: prose |
| G5 | "Right now its shit" — page reads as file explorer, not knowledge packs | ✅ | PR #192 (S46) — knowledge packs redesign |
| G6 | Markdown renderer styling (code blocks, headings, spacing) | ✅ | PR #192 (S46) — markdown renderer shipped |
| G7 | 25/75 layout, preview as separate route | ✅ | PR #192 (S46) — file preview route |
| G8 | Product language ("Knowledge packs" not "Folders") | ✅ | PR #192 (S46) — language updated |

## H. /workers/new + worker-author

| # | Callout | Status | Where |
|---|---|---|---|
| H1 | "New worker" agent should be a real worker (skill-create skill) | ✅ | PR #178 (S40) |
| H2 | Vercel 60s timeout killed (SSE-streamed worker run) | ✅ | PR #178 |
| H3 | Editable style guide (contexts/worker-author-style) | ✅ | PR #178 + content seed |

## I. Workspace agent (S37)

| # | Callout | Status | Where |
|---|---|---|---|
| I1 | `POST /chat` SSE endpoint, agent that can create workers / run them | ✅ | PR #205 (S37) — workspace agent shipped |
| I2 | workspace.md at workspace root as system prompt | ✅ | PR #205 (S37) |
| I3 | Conversations table for persistence | ✅ | PR #205 (S37) |
| I4 | MCP export `workspace.chat()` for Claude Code / Cursor | ✅ | PR #205 (S37) |
| I5 | Slack / WhatsApp adapter examples | ✅ | PR #205 (S37) |

## J. CLI

| # | Callout | Status | Where |
|---|---|---|---|
| J1 | CLI E2E smoke before publish (post-3.0.0 incident) | ✅ | Earlier session |
| J2 | More intuitive next-step hints à la skills-neo | ✅ | PR #195 (polish/cli-ux-upgrade) |
| J3 | `floom doctor` health command | ✅ | PR #195 (polish/cli-ux-upgrade) |
| J4 | `floom workers info <id>` pretty single-worker view | ✅ | PR #195 (polish/cli-ux-upgrade) |
| J5 | Structured log layer (`log.step / ok / warn / err / kv / heading / blank`) | ✅ | PR #195 (polish/cli-ux-upgrade) |

## K. Design system

| # | Callout | Status | Where |
|---|---|---|---|
| K1 | "Leaving design system should NEVER happen" — globals apply app-wide | ✅ | PR #180 (S43) + memory saved |
| K2 | Rounded corners everywhere (not just /overview) | ✅ | PR #180 — 18px on all cards |
| K3 | Single-blue dark mode (currently TWO blues) | ✅ | PR #187 (S45) — single-blue dark mode shipped |
| K4 | Radius inconsistency (some boxes square, others rounded) | ✅ | PR #187 (S45) — `--radius-card / button / pill` audit |
| K5 | Logo + text ratio in sidebar | ✅ | PR #183 — icon 22 / text-base merged |
| K6 | "No colored left borders on cards = AI slop" enforced | ✅ | PR #180 + memory saved |

## L. Performance

| # | Callout | Status | Where |
|---|---|---|---|
| L1 | Load times can be faster, what's the fastest possible? | ✅ | PR #182 (S44) — RSC + ISR + payload trim |
| L2 | New-tab logic too much — same-tab default | ✅ | PR #171 |

## M. Other product

| # | Callout | Status | Where |
|---|---|---|---|
| M1 | OS vs Cloud separation (workers.floom.dev = OS dogfood, Cloud is separate) | ✅ | Memory saved + Cloud brief written |
| M2 | Worker matrix completion (every worker smoked with real inputs, inactive flag) | ✅ | S38 PR #204 — archived primitive + sample inputs + Archived UI tab + MANIFEST + SMOKE-RESULTS |
| M3 | Workspace agent system instruction location | ✅ | PR #205 (S37) — workspace.md location documented |
| M4 | Memory + contexts same primitive (writeable contexts) | ✅ | Explained, no implementation needed beyond S36 |
| M5 | Cloud agent vendoring + Supabase JWT + RLS + Stripe | ❌ | Cloud brief written; separate Cloud lane not yet started |

## N. Process / docs

| # | Callout | Status | Where |
|---|---|---|---|
| N1 | "Test everything yourself, every click, before declaring done" | ✅ | Standing instruction; live walks performed at each milestone |
| N2 | Probe set against workers-api hourly | ✅ | Auto-probe at 21:30 + 22:55 + ongoing; 11/11 pass |
| N3 | "Code/implementation decisions to Codex, not the operator" | ✅ | Standing instruction observed |
| N4 | "Use more Claude than Codex (temp override)" | ✅ | Memory saved 2026-05-29; Codex reserved for verdicts since |
| N5 | Document everything the operator calls out | ✅ | THIS FILE (created 2026-05-29) |

---

## O. Gaps found by re-reading the full session log 2026-05-29

| # | Callout | Status | Action |
|---|---|---|---|
| O1 | "Granola Hubspot sync: you can remove. I don't have the API key" (USR 288) | ✅ | DELETE /workers/granola-hubspot-sync HTTP 204 — gone from prod |
| O2 | "GITHUB_PAT: you should have it somewhere here" (USR 288) | ❌ | Secret `GITHUB_PAT` NOT present on prod. github-digest worker needs it. the operator must set it. |
| O3 | A customer's Meeting Pipeline + Bug Intake workers — sample customer code provided (USR 295) | ✅ | Both workers archived in S38 PR #204 with archive_reason. Restore when customer provides secrets. |
| O4 | "how managed agents compare to what we do? from claude. and same question for trigger dev" (USR 300) | ✅ | `docs/architecture/competitive-comparison-2026-05-29.md` — verdict written, on main |
| O5 | FRONTEND-AGENT-BRIEFING-R13 (5 missing security headers on frontend) (USR 291) | ✅ | Verified live on prod: CSP + X-Frame-Options + X-Content-Type-Options + Referrer-Policy + Permissions-Policy all present. Shipped before this session. |
| O6 | "Smoke past, I don't think, is enough" — deeper worker testing (USR 287) | ✅ | S38 PR #204 — prod smoke runs recorded with run_ids, status, duration, output heads. |
| O7 | "MCPs should be live, right, so we can already connect some MCPs as well" (USR 281, 298) | ❌ | MCP tab + HTTP MCP shipped (PR #206). Stdio import flow genuinely open — see E5/E7. |

## Q. S47 HITL (Search Assistant P0)

| # | Item | Status | Where |
|---|---|---|---|
| Q1 | S47 HITL approvals via two-run respawn model | ✅ | PR #207 |
| Q1a | Migration 37 — restore approvals table with respawn columns | ✅ | PR #207 |
| Q1b | RunStatus.PENDING_APPROVAL + WorkerApprovals model | ✅ | PR #207 |
| Q1c | execute_run() HITL path — detect decision_required, create approval row | ✅ | PR #207 |
| Q1d | GET /approvals + POST /approve + POST /reject endpoints | ✅ | PR #207 |
| Q1e | /approvals page + inline decision card on /runs/[id] | ✅ | PR #207 |
| Q1f | Sidebar Approvals nav + AlertsBell pending count | ✅ | PR #207 |
| Q1g | outbound-approval-demo worker (two-phase proof) | ✅ | PR #207 |
| Q1h | AUTHORING.md two-run model documentation | ✅ | PR #207 |

## R. Deploy pipeline + queue + token-mask + MCP install targets + alerting (2026-05-29)

Items added since the ledger was first written, confirmed shipped to main:

| # | Item | Status | Where |
|---|---|---|---|
| R1 | Deploy pipeline: deploy-api.sh + verify-schema.py + DEPLOY.md | ✅ | PR #214 |
| R2 | Approvals user-flow linking (card links, deep-link ?id=, agent tool + SKILL.md) | ✅ | PR #210 |
| R3 | Full-length bullet-masked token in settings (not truncated) | ✅ | PR #213 |
| R4 | In-process run-execution queue with E2B concurrency cap | ✅ | PR #203 |
| R5 | MCP install targets: vscode/windsurf/generic + UI picker | ✅ | PR #219 |
| R6 | Per-worker success-rate alerting + overview "View worker" links (Phase 3) | ✅ | PR #218 |
| R7 | /contexts crash (TypeError duplicate kwargs) | ✅ | PR #221 |
| R8 | Worker reliability batch (file outputs, Composio proxy, KeyError guard) | ✅ | PRs #220-#225 |

## S. 2026-06-01 Reconcile — the operator Follow-Ups Still Open

Current audit document: `docs/audits/security-product-audit-2026-06-01.md`.

| # | Callout | Status | Evidence / next action |
|---|---|---|---|
| S1 | "Document previous issues, don't just fix them." | ✅ | This section plus the 2026-06-01 audit doc are the current ledger. |
| S2 | Security checklist: privacy, data storage, headers, OWASP, SQLi/XSS/auth, env leakage, sensitive API responses, logs, frontend keys, server-side keys, rate limits. | 🚧 | Audit completed; S-1..S-4 fixed, P0/P1 items remain listed in the audit doc. |
| S3 | Workers need Brain connections/brain tab/icon and connected brain packs on worker detail. | ❌ | Still open; worker source can parse contexts but UI is not a first-class guided Brain surface everywhere. |
| S4 | Source tab: every file needs raw and rendered view; YAML rendered UX is questionable; HTML/CSV/XLSX/PDF/video previews missing. | ❌ | Still open. |
| S5 | Worker card top bar has extra whitespace and does not show the same connection icons as detail pages. | ❌ | Still open; the operator screenshots captured. |
| S6 | Brain page three-column layout alignment: top section borders must line up. | ❌ | Still open; the operator screenshot captured. |
| S7 | Connections rows must show app + account name, not cryptic account fragments; loading state needs more than a long spinner. | ❌ | Still open. |
| S8 | Supabase connection flow/card status looked fake/confusing after auth. | ❌ | Still open; needs Composio callback and status verification. |
| S9 | CLI/MCP setup must include easy token auth, Codex target, and chips matching the UI system. | 🚧 | Cloud token copy updated separately; broader UI polish remains open. |
| S10 | Agent page needs clearer IA: workspace agent as own nav tab with subtabs; instructions vs resolved prompt hard to understand; settings can move lower/secondary. | 🚧 | Agent nav exists; IA/copy polish remains open. |
| S11 | Slack channel integration is not proven. | ❌ | Still open; no verified Slack event-to-agent E2E receipt in this audit. |
| S12 | Overview must fit first viewport; queued vs coming-up counts must be coherent. | ❌ | Still open. |
| S13 | Workspace switcher hover black bug; newly created workspace cannot be selected reliably. | ❌ | Still open. |
| S14 | Workspace fork/duplicate/share-by-link and transfer including secrets. | ❌ | Product/security design still open. |
| S15 | Standalone approval page for one/several approvals without entering app. | ❌ | Still open; only in-app approvals verified. |
| S16 | Worker/agent model declaration visible in UI. | ❌ | Still open unless confirmed in a later UI pass. |
| S17 | Naming pass: apps -> connections, contexts -> brain. | 🚧 | Partially shipped; remaining old labels still need UI sweep. |

## P. Long-standing the operator standing instructions (verified observed)

| # | Standing rule | Status |
|---|---|---|
| P1 | "Dont stop before everything is tested and perfect" (USR 304+) | ✅ Observed — keep grinding |
| P2 | "Test everything yourself, every click" (USR 23+) | ✅ Browser walks at each milestone |
| P3 | "Code/implementation decisions to Codex, not the operator" (multiple) | ✅ Followed |
| P4 | "Use more Claude than Codex (temp override 2026-05-29)" (USR 313) | ✅ Memory saved + observed |
| P5 | "Discuss with Codex before defaulting" (multiple) | ✅ MCP verdict via Codex before S41 |
| P6 | "Parallelise when possible" (USR 306) | ✅ 4 sub-agents + 2 Codex verdicts running concurrently |
| P7 | "Roadmap should be super clear" (USR 390) | ✅ WORKPLAN-20260529-road-to-100.md is the live roadmap |

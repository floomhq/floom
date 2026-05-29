# Federico's feedback ledger — Workeros session 2026-05-28/29

Single source of truth for every concrete UI / product / runtime callout Federico made this session, with current status. Updated whenever something changes.

## Legend

- ✅ **Shipped** — merged to main, live on workers.floom.dev
- 🚧 **In flight** — sub-agent or Codex working right now
- 📝 **Brief written, dispatching** — sub-agent fired this turn
- ⏸ **Waiting on you** — needs a decision before I can dispatch
- ❌ **Not started** — gap, needs a brief

---

## A. Runtime + backend quality

| # | Federico's callout | Status | Where |
|---|---|---|---|
| A1 | SQLite WAL + concurrency hardening (DB locks from S34) | ✅ | PR #163 |
| A2 | Graceful shutdown — runs land `error_code=interrupted_by_restart`, E2B sandbox killed | ✅ | PR #164 |
| A3 | OOM classification (`error_code=sandbox_oom`) | ✅ | PR #165 |
| A4 | Hourly backups + disk-guard + artifact rotation + restore drill | ✅ | PRs #166-#168 |
| A5 | `/metrics` Prometheus + `/health` deep checks | ✅ | PR #169 |
| A6 | Silent-failure audit doc | ✅ | PR #170 |
| A7 | Async architecture / Vercel 60s explained in plain language | 🚧 | Codex verdict running |

## B. /overview page

| # | Callout | Status | Where |
|---|---|---|---|
| B1 | Outcome-shaped tiles (not infra counters) | ✅ | PR #156 |
| B2 | "Worker keeps failing" must name the worker + cause | ✅ | PR #176 (S39) |
| B3 | Page left the design system (warm tokens applied /overview only) | ✅ | PR #180 (S43) — rolled app-wide |
| B4 | Red AI-slop cards (colored left border + warm-tint bg) | ✅ | PR #180 strip removed |
| B5 | Single-screen fit, no scroll needed | 🚧 | S45 sub-agent |
| B6 | Metric tiles get sparklines | 🚧 | S45 sub-agent |
| B7 | "Needs attention" → notifications-style button top-right | 🚧 | S45 sub-agent |
| B8 | "Last 7 days" redundant with sparklines | 🚧 | S45 sub-agent (drops the subtitle) |

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
| E4 | MCP servers as own tab (not mixed with OAuth) | ⏸ | S41, gated on stdio verdict |
| E5 | Integrate his 17 existing stdio MCPs from cursor/.claude configs | ⏸ | S41, gated on stdio verdict |
| E6 | One-command MCP add (`floom mcp add github`) + paste-JSON + catalog | ⏸ | S41, gated on stdio verdict |
| E7 | Stdio transport support in sandbox | ⏸ | Codex stdio verdict running, then S41 |

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
| G5 | "Right now its shit" — page reads as file explorer, not knowledge packs | 🚧 | S46 sub-agent |
| G6 | Markdown renderer styling (code blocks, headings, spacing) | 🚧 | S46 sub-agent |
| G7 | 25/75 layout, preview as separate route | 🚧 | S46 sub-agent |
| G8 | Product language ("Knowledge packs" not "Folders") | 🚧 | S46 sub-agent |

## H. /workers/new + worker-author

| # | Callout | Status | Where |
|---|---|---|---|
| H1 | "New worker" agent should be a real worker (skill-create skill) | ✅ | PR #178 (S40) |
| H2 | Vercel 60s timeout killed (SSE-streamed worker run) | ✅ | PR #178 |
| H3 | Editable style guide (contexts/worker-author-style) | ✅ | PR #178 + content seed |

## I. Workspace agent (S37)

| # | Callout | Status | Where |
|---|---|---|---|
| I1 | `POST /chat` SSE endpoint, agent that can create workers / run them | ⏸ | S37 brief written, NOT dispatched — needs go-ahead |
| I2 | workspace.md at workspace root as system prompt | ⏸ | Same |
| I3 | Conversations table for persistence | ⏸ | Same |
| I4 | MCP export `workspace.chat()` for Claude Code / Cursor | ⏸ | Same |
| I5 | Slack / WhatsApp adapter examples | ⏸ | Same |

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
| K3 | Single-blue dark mode (currently TWO blues) | 🚧 | S45 sub-agent |
| K4 | Radius inconsistency (some boxes square, others rounded) | 🚧 | S45 sub-agent — `--radius-card / button / pill` |
| K5 | Logo + text ratio in sidebar | 🚧 | PR #183 open (icon 22 / text-base) |
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
| M3 | Workspace agent system instruction location | ⏸ | S37 |
| M4 | Memory + contexts same primitive (writeable contexts) | ✅ | Explained, no implementation needed beyond S36 |
| M5 | Cloud agent vendoring + Supabase JWT + RLS + Stripe | ⏸ | Cloud brief written for separate agent lane |

## N. Process / docs

| # | Callout | Status | Where |
|---|---|---|---|
| N1 | "Test everything yourself, every click, before declaring done" | ✅ | Standing instruction; live walks performed at each milestone |
| N2 | Probe set against workers-api hourly | ✅ | Auto-probe at 21:30 + 22:55 + ongoing; 11/11 pass |
| N3 | "Code/implementation decisions to Codex, not Federico" | ✅ | Standing instruction observed |
| N4 | "Use more Claude than Codex (temp override)" | ✅ | Memory saved 2026-05-29; Codex reserved for verdicts since |
| N5 | Document everything Federico calls out | ✅ | THIS FILE (created 2026-05-29) |

## Open decisions waiting on Federico

1. **MCP stdio (Path A / B / C / hybrid)** — Codex verdict running. Wait for it, then pick.
2. **S37 workspace agent dispatch** — brief ready, awaiting go-ahead.
3. **Contexts ASCII style (proposal 1/2/3/4)** — pending your pick; default in flight is Proposal 1 (current Don't:/Do: prose) inside S46 redesign.

## Open briefs ready to dispatch

- ~~S38 worker matrix completion~~ ✅ PR #204
- Cloud vendoring (for the Cloud agent lane, not OS)

---

## O. Gaps found by re-reading the full session log 2026-05-29

Things I missed in the original ledger. Re-grep of /root/.claude/projects/-root/ab820815-*.jsonl turned these up.

| # | Callout | Status | Action |
|---|---|---|---|
| O1 | "Granola Hubspot sync: you can remove. I don't have the API key" (USR 288) | ✅ | DELETE /workers/granola-hubspot-sync HTTP 204 — gone from prod |
| O2 | "GITHUB_PAT: you should have it somewhere here" (USR 288) | ⏸ | Verified: secret `GITHUB_PAT` NOT present on prod. Need you to set it (or paste it and I'll set via API). github-digest worker needs it. |
| O3 | Kugelaudio Meeting Pipeline + Bug Intake workers — sample customer code provided (USR 295) | ✅ | Both workers archived in S38 PR #204 with archive_reason. Restore when customer provides secrets. |
| O4 | "how managed agents compare to what we do? from claude. and same question for trigger dev" (USR 300) | 🚧 | Codex verdict dispatched — writes `docs/architecture/competitive-comparison-2026-05-29.md` |
| O5 | FRONTEND-AGENT-BRIEFING-R13 (5 missing security headers on frontend) (USR 291) | ✅ | Verified live on prod: CSP + X-Frame-Options + X-Content-Type-Options + Referrer-Policy + Permissions-Policy all present. Shipped before this session. |
| O6 | "Smoke past, I don't think, is enough" — deeper worker testing (USR 287) | ✅ | S38 PR #204 — prod smoke runs recorded with run_ids, status, duration, output heads. |
| O7 | "MCPs should be live, right, so we can already connect some MCPs as well" (USR 281, 298) | ⏸ | Partial: MCP add UI exists (PR #161). Full S41 (tab + import + stdio) blocked on Codex stdio verdict. |

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

## P. Long-standing Federico standing instructions (verified observed)

| # | Standing rule | Status |
|---|---|---|
| P1 | "Dont stop before everything is tested and perfect" (USR 304+) | ✅ Observed — keep grinding |
| P2 | "Test everything yourself, every click" (USR 23+) | ✅ Browser walks at each milestone |
| P3 | "Code/implementation decisions to Codex, not Federico" (multiple) | ✅ Followed |
| P4 | "Use more Claude than Codex (temp override 2026-05-29)" (USR 313) | ✅ Memory saved + observed |
| P5 | "Discuss with Codex before defaulting" (multiple) | Partial — need to check more often (the A/B MCP question) |
| P6 | "Parallelise when possible" (USR 306) | ✅ 4 sub-agents + 2 Codex verdicts running concurrently |
| P7 | "Roadmap should be super clear" (USR 390) | ✅ This ledger is the roadmap snapshot |

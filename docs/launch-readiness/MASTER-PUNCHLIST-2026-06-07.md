# Master Punchlist - 2026-06-07

Durable issue tracker for Federico's June 7 live test and launch-readiness follow-ups.

Source evidence:
- `/tmp/fede-livetest-issues-2026-06-07.md`
- Open PRs in `floomhq/workeros` and `floomhq/workeros-cloud` as of 2026-06-07 05:39 CEST
- `docs/launch-readiness/*` on `origin/main`
- PR #490 UX walk: `docs/launch-readiness/ux-walk-2026-06-07.md`
- PR #491 Codex audit: `docs/launch-readiness/audit-codex-2026-06-07.md`
- Local in-flight branches/worktrees: `fix/livetest-ui-polish`, `codex/m85-brain-fixes`, `fix/p1-assistant-base-state`, `fix/p0-cloud-magic-link`

Status legend: `OPEN` / `IN-PROGRESS PR#xxx` / `FIXED-not-deployed` / `DEPLOYED` / `VERIFIED-LIVE`.

## Summary

| Metric | Count |
|---|---:|
| Total tracked rows | 43 |
| P0 | 6 |
| P1 | 22 |
| P2 | 11 |
| Decisions awaiting Federico | 3 |
| Test-coverage matrix rows | 1 |
| Rows with visible fix branch coverage | 6 |
| Rows documented by open evidence/design PRs | 16 |
| Rows covered by this tracking PR | 1 |
| Rows with no assigned owner | 0 |
| Rows without a visible fix PR/branch | 36 |

## P0 - Data, Auth, Durability, Launch Blockers

| ID | Title | Severity | Status | Owner | Notes |
|---|---|---|---|---|---|
| FL1 | Federico's workers hidden by role-aware visibility | P0 | OPEN | Vivek | Data verified safe in source brief: 100 workers, 99 owner=`federico`, mostly `local-default`; root is visibility/session mapping, not data loss. Blocks trust. |
| FL2 | Durable worker store for Cloud | P0 | OPEN | Vivek | PR#489 documents git-backed workspace storage. Implementation/deploy remains open. Related to FL27. |
| FL27 | Cloud git-tracking not included | P0 | OPEN | Vivek | PR#489 is design documentation only; no live git-backed Cloud store is verified. |
| LR-CODEX-P0-1 | Live deployment lacks multi-member auth/PAT/users routes | P0 | OPEN | Vivek | PR#491 documents the blocker. Live `/auth/*`, `/users`, PAT route probes returned 404, so role-aware visibility and PAT boundaries were unverified. Overlaps FL1. |
| LR-CODEX-P0-2 | Seven-day run health far below launch threshold | P0 | OPEN | Codex backend | PR#491 documents 1,683 failed runs out of 1,866 and 13 open incidents. No fix PR found. |
| LR-UX-P0-1 | Cloud magic-link confirmation URL corrupted | P0 | OPEN | Claude UI | PR#490 documents reproduced broken email signup. Local branch `fix/p0-cloud-magic-link` is identical to `origin/main`; no visible fix diff found. Related to FL3. |

## P1 - Functional And UX Issues

| ID | Title | Severity | Status | Owner | Notes |
|---|---|---|---|---|---|
| FL3 | Cloud login returns home page or confusing route | P1 | OPEN | Claude UI | Cloud login remains covered by PR#490 and cloud PR#112 evidence, but magic-link signup is still broken in PR#490. |
| FL4 | Signed-in homepage shows Sign in instead of Dashboard | P1 | OPEN | Claude UI | No dedicated fix PR found. Cloud PR#112 verifies `/app/login` HTTP 200, not signed-in homepage copy. |
| FL5 | Brain image upload without folder returns Request body too large | P1 | FIXED-not-deployed | Codex backend | Local branch `codex/m85-brain-fixes` has commit `1003cb8` for context writes and first-drop upload. Live deployment not verified. |
| FL6 | `.txt` files lack Preview/Raw tabs | P1 | FIXED-not-deployed | Claude UI | Local branch `fix/livetest-ui-polish` commit `fad2c17` adds Preview/Raw for plain-text and code files. No open PR found. |
| FL7 | Brain jargon says knowledge pack instead of folders/files | P1 | FIXED-not-deployed | Claude UI | Local branch `fix/livetest-ui-polish` commit `187adcd` de-jargons Brain UI. RECURRING/claimed-done-but-partial: source brief flags this as previously partial; live grep/browser verification still required. |
| FL8 | Brain/Workers/Runs/Approvals skeletons feel partial | P1 | FIXED-not-deployed | Claude UI | Local branch `fix/livetest-ui-polish` commit `4bd9501` covers Brain and Runs. Workers/Approvals coverage not verified from that commit list. |
| FL10 | Clear all runs is too prominent near search | P1 | FIXED-not-deployed | Claude UI | Local branch `fix/livetest-ui-polish` commit `241585f` de-emphasizes clear run history in command palette. Main runs-page placement still needs live check. |
| FL11 | Gmail scope count lacks visible scope detail | P1 | OPEN | Claude UI | No fix PR found. |
| FL12 | Trust peek for last emails is absent | P1 | OPEN | Claude UI | Product/design request; no fix PR found. |
| FL13 | Test connection/status/refresh status semantics confusing | P1 | OPEN | Claude UI | No fix PR found. |
| FL14 | OAuth guidance lives inside a scrolling card | P1 | OPEN | Claude UI | No fix PR found. |
| FL15 | MCP page needs intuitive JSON/form/import redesign | P1 | OPEN | Codex backend | No active fix PR found. Main launch matrix still lists MCP as not yet tested. |
| FL18 | Pages and boxes do not fill full-page height | P1 | OPEN | Claude UI | No fix PR found. Related to skeleton/content whitespace across Overview, Brain, Runs. |
| FL20 | Workspace-action labels are confusing | P1 | OPEN | Claude UI | No fix PR found. PR#490 could not test authed Cloud workspace actions because magic-link auth is broken. |
| FL21 | Brain file viewer lacks reading space | P1 | OPEN | Claude UI | No direct fix found. PR#408 is an older worker-detail preview-only PR, not a Brain viewer fix. |
| FL25 | Main `/workers/new` prompt lacks inline Granola/HubSpot highlight | P1 | OPEN | Claude UI | RECURRING/claimed-done-but-partial: source brief says #480 covered example cards/pills, not the main prompt box. |
| FL26 | Cloud has no Emily chat option | P1 | OPEN | Claude UI | No fix PR found. |
| LR-CODEX-P1-1 | Alert webhook accepts encoded CRLF-shaped URLs | P1 | OPEN | Codex backend | PR#491 documents the security gap. No fix PR found. |
| LR-CODEX-P1-2 | OSS sign-in gate calls missing `/api/auth/setup` | P1 | OPEN | Codex backend | PR#491 documents a frontend/API route mismatch. Overlaps LR-CODEX-P0-1. |
| LR-CODEX-P1-3 | Private worker list responses include public share links | P1 | OPEN | Codex backend | PR#491 documents raw share-link fields in private worker list responses. No fix PR found. |
| LR-UX-P1-1 | OSS `/assistant` base-instructions editor 404s | P1 | OPEN | Claude UI | PR#490 documents the defect. Local `fix/p1-assistant-base-state` has an uncommitted API fallback diff only, so it is not counted as fixed. |
| PROCESS-1 | Issue tracking was ephemeral and partial items were claimed done | P1 | IN-PROGRESS PR#494 | Codex backend | This document and PR#494 are the corrective action. Mark fixed only after the PR merges and future issues stay in committed docs. |

## P2 - Polish And Copy

| ID | Title | Severity | Status | Owner | Notes |
|---|---|---|---|---|---|
| FL9 | Sidebar order places Workers above Assistant | P2 | FIXED-not-deployed | Claude UI | Local branch `fix/livetest-ui-polish` commit `09ac76e` moves Assistant above Workers. No open PR found. |
| FL17 | Shadow artifacts below Overview boxes | P2 | OPEN | Claude UI | New June 7 issue; no fix PR found. |
| FL19 | Logout belongs on avatar hover, not separate sidebar icon | P2 | OPEN | Claude UI | No fix PR found. |
| FL22 | Remove emojis everywhere, use icons only | P2 | OPEN | Claude UI | Design rule. No sweep PR found for June 7. |
| LR-UX-P2-1 | Runs list column headers collide | P2 | OPEN | Claude UI | PR#490 documents "Worker"/"Trigger" collision. No fix PR found. |
| LR-UX-P2-2 | OSS 404 is bare Next.js default | P2 | OPEN | Claude UI | PR#490 documents missing branded 404. No fix PR found. |
| LR-UX-P2-3 | Cloud login/title says Floom instead of Workeros | P2 | OPEN | Claude UI | Naming/copy inconsistency documented in PR#490. |
| LR-UX-P2-4 | Cloud landing copy says Floom shows the trigger | P2 | OPEN | Claude UI | Copy inconsistency documented in PR#490. |
| LR-UX-P2-5 | Cloud confirmation email copy is all-Floom | P2 | OPEN | Claude UI | Copy issue documented separately from the P0 broken link. |
| LR-UX-P2-6 | OSS Developer tab contains Floom infra strings | P2 | OPEN | Claude UI | PR#490 flags this as a Federico naming decision because headers/package prefixes are real infra identifiers. |
| LR-UX-P2-7 | Theme toggle does not persist Light across navigation | P2 | OPEN | Claude UI | PR#490 documents a low-priority persistence issue. |

## Decisions Awaiting Federico

| ID | Title | Severity | Status | Owner | Notes |
|---|---|---|---|---|---|
| FL16 | Naming: workers to agents; assistant to Chief of Staff/Mother/Orchestrator | DECISION | OPEN | Claude UI | Awaiting Federico. Do not apply broad rename until decision is explicit. |
| FL23 | Rename WorkerOS to Agent Space and workers to agents | DECISION | OPEN | Claude UI | Awaiting Federico. Source brief says this reverses prior positioning; confirm full switch before implementation. |
| FL24 | Agent creation moves into Emily chat instead of `/workers/new` | DECISION | OPEN | Claude UI | Awaiting Federico. Major flow redesign; no implementation PR found. |

## Test Coverage

| ID | Surface | Current Pass/Untested State | Status | Owner | Notes |
|---|---|---|---|---|---|
| FL28 | Worker setup + Emily across UI/MCP/WhatsApp/Slack | UI: pass in source brief; WhatsApp: pass in source brief; MCP: untested; Slack: untested | OPEN | Codex backend | Main `TEST-MATRIX.md` lists MCP not yet tested. Source brief says UI+WhatsApp done and Slack+MCP pending. Keep open until all four channels have dated evidence. |

## PR And Branch Coverage Map

| PR/Branch | Type | IDs covered | Coverage result |
|---|---|---|---|
| workeros PR#491 `audit/codex-launch-2026-06-07` | Docs/evidence | LR-CODEX-P0-1, LR-CODEX-P0-2, LR-CODEX-P1-1, LR-CODEX-P1-2, LR-CODEX-P1-3 | Documents live blockers and evidence; closes no fix by itself. |
| workeros PR#490 `docs/lr-ux-walk-20260607` | Docs/evidence | LR-UX-P0-1, LR-UX-P1-1, LR-UX-P2-1 through LR-UX-P2-7 | Documents UX findings; closes no fix by itself. |
| workeros PR#489 `design/git-workspace-storage-2026-06-06` | Design doc | FL2, FL27 | Covers storage design direction; implementation still open. |
| workeros PR#408 `ui/worker-detail-cleaner` | Preview UI PR | No direct June 7 closure | Older preview-only worker-detail work; not mapped to Brain viewer FL21. |
| workeros-cloud PR#112 `codex/sync-followups-20260607` | Docs/evidence | FL3, FL4 context only | Verifies Cloud dashboard root/deploy and `/app/login` HTTP 200; does not close magic-link or signed-in homepage issues. |
| Local branch `fix/livetest-ui-polish` | Fix branch, no open PR found | FL6, FL7, FL8, FL9, FL10 | Branch has five commits ahead of `origin/main`; not deployed and not in an open PR. |
| Local branch `codex/m85-brain-fixes` | Fix branch, remote gone | FL5 | Commit `1003cb8` supports context writes and first-drop upload; not verified live. |
| Local branch `fix/p1-assistant-base-state` | Uncommitted local diff | LR-UX-P1-1 | Fallback diff exists but is not committed or opened as PR. |
| Local branch `fix/p0-cloud-magic-link` | Empty branch | LR-UX-P0-1 | Branch currently matches `origin/main`; no fix diff visible. |

## Explicit Recurring / Partial Items

| ID | Reason it is flagged |
|---|---|
| FL7 | Source brief says Brain jargon was claimed done while partial. Branch-only rename exists, but live verification across all Brain/context surfaces is absent. |
| FL25 | Source brief says inline highlight was claimed done in #480, but the main `/workers/new` prompt still lacks the Granola/HubSpot highlight. |
| PROCESS-1 | Source brief records the meta-failure: tracking existed only in `/tmp`, and "done" claims were not tied to live evidence. |

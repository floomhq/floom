# Reconcile 2026-06-07

Source brief: `/tmp/reconcile-brief.md`.

Primary sources inspected:
- `docs/audits/conversation-gap-scan-2026-06-04.md`
- `git log -p -- ISSUES.md`
- `gh issue list --repo floomhq/workeros --state all --limit 1000`
- `gh issue list --repo floomhq/workeros-cloud --state all --limit 200`
- `origin/main` code/docs for direct verification

`floomhq/workeros-cloud` returned no issues. Reconciliation tracking was therefore kept on the canonical `floomhq/workeros` issue board, using `area:cloud` where the item is Cloud-specific.

## M1-M30 Mapping

| M | Status | Mapping / action | Evidence |
|---|---|---|---|
| M1 | Covered | Covered by #498, #523, #525, #530 for Cloud/storage/auth/signup tracking. | Current GH board has Cloud-specific open issues. |
| M2 | Done | No duplicate created. | `origin/main` exposes Emily/workspace MCP tools including `mcp_tools__list/register/update/delete`; `docs/audits/backend-pass2-2026-06-05.md` records production verification. |
| M3 | Created | #535 | Google/Workspace avatar backend/profile action was not on the board. |
| M4 | Done | No duplicate created. | `origin/main:apps/web/app/runs/RunsClient.tsx` links each run row worker name to `/workers/{worker_id}`. |
| M5 | Done | No duplicate created. | `origin/main:apps/web/app/overview/page.tsx` no longer renders the old rounded tab strip. |
| M6 | Created | #536, paired with M26. | Worker Source still has file kinds that fall back to a single Source view instead of Preview/Raw. |
| M7 | Created | #537 | No current GH issue tracked the broader tabs-at-top consistency request. |
| M8 | Created | #538 | Slack UI and event handling exist, but zero-UI Slack-first onboarding was untracked. |
| M9 | Covered | Covered by #488 / #498. | Git-backed worker/brain/persona source storage is the canonical durability track. |
| M10 | Done | No duplicate created. | `docs/audits/backend-pass2-2026-06-05.md` records production model envs `WORKEROS_CHAT_MODEL` and `WORKEROS_CODEGEN_MODEL`. |
| M11 | Covered | Covered by #507, #508, #510. | Current board tracks connection scope/trust/OAuth explainability gaps. |
| M12 | Done | No duplicate created. | `origin/main` has per-approval unlisted links in `apps/web/app/approvals/page.tsx` and public approval route/tests. |
| M13 | Done | No duplicate created. | `origin/main` has approval annotation UI/API/tests under `apps/web/app/approvals/review/annotations.tsx` and `apps/api/tests/test_approval_annotations.py`. |
| M14 | Done | No duplicate created. | `origin/main` unifies Versions into a header dropdown and removes the worker Versions tab. |
| M15 | Created | #539 | Worker-detail cognitive-load issue was not tracked as an open GH issue. |
| M16 | Covered/done | Covered by closed #504. | Loading skeleton issue was closed via FL8; Approvals skeleton comments in `origin/main` mirror the loaded card layout. |
| M17 | Created | #540 | Existing code adds an Open Slack CTA, but the exact continue-in-Slack flow remains partial/untracked. |
| M18 | Done | No duplicate created. | `DESIGN_SYSTEM.md` exists on `origin/main`. |
| M19 | Created | #541 | Assistant UI chrome/personality pass was not tracked. |
| M20 | Created | #542 | No reusable Slack onboarding skill/artifact issue existed. |
| M21 | Done | No duplicate created. | Mac check found `~/Desktop/Documents/2026-06-04__document-whatsapp-setup__whatsapp-setup-guide-emily.txt`. |
| M22 | Created | #543 | No GH issue tracked the dedicated work-email OpenBrowser profile. |
| M23 | Done | No duplicate created. | `origin/main:apps/web/components/assistant/SlackConnect.tsx` has step-by-step Slack onboarding in Settings. |
| M24 | Done | No duplicate created. | `workers/workspace-agent/SKILL.md` has no stale GPT-4.1-mini wording; backend-pass2 records current production model envs. |
| M25 | Covered | Covered by #511. | Current board tracks MCP page JSON/form/import redesign. |
| M26 | Created | #536, paired with M6. | Same Source Preview/Raw consistency issue. |
| M27 | Covered/done | Covered by #511 for UI discoverability; backend exists. | `origin/main` has custom MCP tool CRUD endpoints and Emily tools. |
| M28 | Done | No duplicate created. | `origin/main:apps/web/components/CliCommandPanel.tsx` embeds token-aware CLI/MCP/API snippets and swaps reference lists per tab. |
| M29 | Created | #544 | Operational secret rotation/verification was untracked; issue body avoids secret values. |
| M30 | Created | #545 | Standalone share tokens exist, but dual run-on-Workeros / install-as-skill mode was untracked. |

## Status Drift Cleanup

| Issue | Action | Result |
|---|---|---|
| #466 | Verified fix commit/code on `origin/main`; added `P1`, `area:ui`, `status:fixed-pending-deploy`; commented. | Left open because live deployment was not verifiable from available evidence. |
| #467 | Verified fix commit/code on `origin/main`; added `P1`, `area:ui`, `status:fixed-pending-deploy`; commented. | Left open because live deployment was not verifiable from available evidence. |
| #468 | Verified assistant restore fixed but contexts restore still calls `confirm()`; added `P1`, `area:ui`, `recurring`; commented. | Left open; created dedicated #546 for the contexts-page partial gap. |
| #469 | Verified fix commit/code on `origin/main`; added `P1`, `area:ui`, `status:fixed-pending-deploy`; commented. | Left open because live deployment was not verifiable from available evidence. |
| #470 | Verified fix commit/code on `origin/main`; added `P1`, `area:ui`, `status:fixed-pending-deploy`; commented. | Left open because live deployment was not verifiable from available evidence. |
| #471 | Verified fix commit/code on `origin/main`; added `P1`, `area:ui`, `status:fixed-pending-deploy`; commented. | Left open because live deployment was not verifiable from available evidence. |
| #472 | Verified fix commit/code on `origin/main`; added `P1`, `area:backend`, `status:fixed-pending-deploy`; commented. | Left open because live deployment was not verifiable from available evidence. |
| #473 | Verified equivalent fix commit `7f6b9d8` on `origin/main`; added `P1`, `area:backend`, `status:fixed-pending-deploy`; commented. | Left open because live deployment was not verifiable from available evidence. |

No #466-#473 issue was closed. The brief required closing only issues that were provably done and live; this run verified `origin/main` but did not have live-deployment proof for those drift items.

## New Issues Created

| Issue | Source |
|---|---|
| #535 | M3 |
| #536 | M6 + M26 |
| #537 | M7 |
| #538 | M8 |
| #539 | M15 |
| #540 | M17 |
| #541 | M19 |
| #542 | M20 |
| #543 | M22 |
| #544 | M29 |
| #545 | M30 |
| #546 | #468 contexts-page partial gap |

## Final Counts

| Metric | Count |
|---|---:|
| Total tracked GitHub issues in `floomhq/workeros` | 64 |
| Open GitHub issues in `floomhq/workeros` | 51 |
| GitHub issues in `floomhq/workeros-cloud` | 0 |
| M1-M30 items verified done, no duplicate issue created | 13 |
| M1-M30 items newly tracked by this reconciliation | 12 |
| New GitHub issues created by this reconciliation | 12 |

everything-accounted: yes

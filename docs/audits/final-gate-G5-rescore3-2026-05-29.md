# Final Gate G5 — Independent Re-score #3 (Workeros)

- **Date:** 2026-05-29
- **Target:** https://workers.floom.dev (LIVE prod)
- **Reviewer frame:** Fresh, skeptical founder/operator. Did NOT trust "fixed" claims; judged the live deployed product. Independent of the concurrent final-converge audit.
- **Method:** AX41 Browser Broker (desktop, pool-a) + Chrome DevTools CDP @375px (mobile), real interactions. Backend cross-checked via `/api/proxy/*` and source at `/root/workeros`.
- **Prior independent walks:** 88 → 93. This is re-score #3.
- **Scope of change since #93:** (a) #258 per-run loop isolation (kills "Event loop is closed" under concurrency); (b) #256 operator error humanization via `error_code` taxonomy + `error_raw` preservation + 3 UX fixes (approval badge/list sync, failed-run result headline, HITL pending = "Awaiting approval" not red "Failed").

---

## VERDICT (up front)

**Overall: 92/100. State: NOT launch-ready at the ≥95 G5 bar. Gate NOT passed.**

The prior-93 SOLE named blocker (raw runtime jargon on the run **list** surface) is **genuinely GONE** — verified live and via API (`.error` clean across 20 runs, list rows show only calm headlines). #256 and #258 both shipped and work. The HITL round-trip, the dashboard, connections, contexts, and mobile are all launch-grade.

It does NOT reach ≥95 because a **fresh, reproducible P1 in the product's hero flow** surfaced this pass, plus the raw "Event loop is closed" string is still visible on the run **detail** page (timeline subtitle + default-visible logs), one surface short of fully closing the #256 intent.

---

## FLAWS FIRST (anti-inflation)

### P1 — Worker generation silently resets to empty form; no editor, no run page, no toast (HERO FLOW)
- **Reproduced twice live.** Typed a prompt → "Generate" → live "Worker Author" progress UI ran ~24-40s → the page **reset to the empty `/workers/new` form** with the prompt still in the box, **no navigation, no success toast, no error toast.**
- **The worker WAS created both times** (backend confirmed: worker count 11→12→13; new workers `ai-news-summary` and `github-pull-request-summary` exist and open correctly; dashboard "Worker activity" shows "Worker Author — Completed 28.3s"). So generation succeeds server-side; the failure is purely the front-end terminal handling.
- **Impact:** The literal product hero ("describe the job → Floom drafts it → opens the editor so you can review before running", per positioning + the page's own subtitle) visibly breaks. An operator sees their work vanish and would conclude it failed, then re-submit — creating duplicate workers. The created worker is only discoverable by manually browsing `/workers`.
- **Root cause (code, apps/web/app/workers/new/page.tsx):** On SSE terminal, the success path is `router.push(/runs/${runId})` (line 137) gated on `event.type === "status" && event.status === "completed"`. The backend `/runs/{id}/events` endpoint does emit `{"type":"status","status":"completed"}` (apps/api/main.py:6152). But the `evtSource.onerror` fallback (line 150-159) reads `streamRunId` from a **stale closure** (captured `null` at handler creation; set async via `setStreamRunId` on line 120), so if the stream closes/errors before `onmessage` processes the completed status, it hits the `else` → `setGenerating(false); setStreamLogs([])` → silent reset, no navigation, no toast. Worker-author runs complete fast enough to race the EventSource lifecycle, which is what the live walk hit on both attempts.
- **Evidence:** `/tmp/wk-G5-final3/workers-new.png` (composer), generation run reset to empty form (two snapshots), `worker-ai-news.png` (silently-created worker opens fine).

### P1 — Raw "Event loop is closed" still visible on run DETAIL page (timeline subtitle + default logs)
- The run-detail **Error banner** (`.error`) IS humanized: "This worker hit an internal error and stopped. Check the run logs, then edit or re-run the worker." ✓ (#256 works for the `.error` field; API confirms `error_raw="Event loop is closed"`, `error_code="agent_runtime_error"`.)
- BUT two sibling surfaces on the SAME default view still echo the raw string:
  1. **Timeline card subtitle** (left column, directly beside the calm banner): header "Failed" with raw subtitle **"Event loop is closed"**. Source: `error: run.error` is humanized, but the timeline node uses `part.error` (raw SSE finish-part error) — RunDetailSplitPane.tsx ~line 603/639.
  2. **"Recent logs" panel** (default-visible on the Result tab, not behind the Logs tab): two red ERROR rows "Agent runtime error: Event loop is closed" / "Run failed: Event loop is closed".
- **Nuance / fairness:** The specific run I inspected (run_bd593adb5874, 10:25 AM) started **before** #256 (10:45) and #258 (11:01) deployed — it is a legacy pre-fix run, NOT a post-#258 regression. Logs being raw is also legitimate (engineer escape hatch; brief says raw is kept). The genuinely-inconsistent surface is the **timeline subtitle**, which presents raw jargon as a headline 6px from the calm banner. Confirmed identical on desktop and mobile (`run-failed-internal.png`, `mobile-run-failed.png`).
- **Why it still counts against ≥95:** #256 was scoped as "all failed-run `.error` fields show calm headlines." The `.error` field is fixed; the operator-facing run-detail view as a whole still shows the raw string without the user clicking anything. One operator surface short of the stated intent.

### P2 — Seed-data success rates surface low (judged as noise, reported per brief)
- OpenDraft 28%, Gmail Intake 43%, CSV Enricher 50%, CV Writeup 50%. These are file-input workers fired by audit-agent churn without uploads (failures = "needs a file uploaded"), so the rates are seed-data noise, not a code defect. The failure HEADLINES are correctly humanized ("This worker needs a file uploaded for one of its inputs. Upload the file, then re-run."). Not a gate blocker, but a skeptical investor scanning the catalog sees a wall of sub-60% rates on the front-line worker cards. Worth re-seeding before any public demo.

### P2 — Lingering "Approvals 1" badge from a prior session
- A pending approval (run_53cea99493a8) from a prior session persists. My own approve cleanly decremented 2→1. Not a bug per se (it's a real pending item), but stale demo state.

---

## WHAT WORKS (verified live this pass)

- **HITL round-trip, full end-to-end:** Ran outbound-approval-demo → run 1 entered **"Awaiting approval"** (calm, NOT red "Failed") ✓ → appeared in `/approvals` with full drafted message + Approve/Edit/Reject ✓ → sidebar **"Approvals" badge appeared (2)** ✓ → I approved my run → it spawned run-2-execute (run_241d0dcfdc0b), **completed in 4.2s with `SENT: true`** (side-effect fires only in run 2, idempotency honored) ✓ → **badge auto-decremented 2→1** ✓. All 3 named UX fixes verified.
- **Prior-93 blocker is gone:** `/runs` list shows only humanized headlines across all failure classes (timeout / internal error / missing-file). API confirms 0 raw-leak `.error` fields across 20 runs.
- **#256 taxonomy real:** `error` = calm headline, `error_raw` = raw preserved, `error_code` = structured (`agent_runtime_error`). Three calm headlines observed live for three distinct failure classes.
- **#258 timing checks out:** My fresh runs (HITL + 2 generations) completed cleanly with no "Event loop is closed"; the only instances of that string are on pre-11:01 legacy runs.
- **Hero create flow (backend):** Prompt → "Worker Author" streaming progress (Reading prompt → style context → drafting worker.yml → SKILL.md/run.py → validating schema) → real worker created and openable. The engine works; only the front-end terminal navigation is broken.
- **Positioning dead-on:** "Work done / N outcomes this week", outcome tiles (not infra counters), "Hire a new AI worker", employee-style worker cards (name + trigger + last result + success% + "Needs attention" + tags + folders), artifact-native run detail (inputs/output/logs/raw/metadata + download + re-run).
- **Connections:** Tabs (Connected/Browse/MCP/Secrets), real OAuth accounts (GitHub, Gmail, Calendar, Drive, LinkedIn, Notion) with scopes/last-used/Active-Expired/Reconnect. Real logos.
- **Contexts:** Honest empty state, clear "Reusable knowledge packs your workers can read before they act."
- **No 5xx/4xx anywhere:** All routes + `/api/proxy/*` returned 200. Console clean on run-detail (0 errors/warnings).
- **Mobile (375px):** Clean hamburger nav, stacked outcome tiles, responsive run-detail with tabs, no overflow. ChatGPT-grade restraint, no AI-slop, restrained palette.

---

## PER-CATEGORY TABLE

| # | Category | Score | Evidence |
|---|----------|-------|----------|
| 1 | First impression / positioning fit | 9/10 | Outcome tiles + "Hire an AI worker" prompt hero. On-model. |
| 2 | Worker catalog (employee cards) | 8/10 | Name + trigger + last result + success% + needs-attention + tags + folders. Docked for low seed success rates surfacing prominently (P2). |
| 3 | Create / generate flow | **5/10** | Backend generation works; **front-end silently resets after success — no editor, no run page, no toast (P1).** Hero flow visibly broken. Heaviest dock. |
| 4 | Run a worker | 9/10 | Run tab: clean form, sample-input helper, labelled system fields, ran live to output. |
| 5 | Run detail / observability | 7/10 | Tabs + download + re-run + redacted logs + humanized Error banner. Docked: timeline subtitle + default logs still show raw "Event loop is closed" (P1). |
| 6 | HITL approvals | 9/10 | Full round-trip verified live; badge sync verified; pending = "Awaiting approval". Excellent. |
| 7 | Run history | 9/10 | Grouped-by-day, trigger badges, status filters, CSV export, **per-row humanized failure cause (prior P1 GONE — verified clean).** |
| 8 | Error / failure hygiene | 7/10 | List surface clean; `.error` humanized; taxonomy real. Docked for residual raw string on run-detail timeline subtitle + logs (P1). |
| 9 | Contexts / knowledge packs | 9/10 | Honest empty state, clear definition, no engine leak. |
| 10 | Connections / settings | 9/10 | Real OAuth accounts, scopes, status, reconnect, MCP/Secrets tabs, real logos. |
| 11 | Visual / responsive (desktop + mobile) | 9/10 | shadcn, restrained, responsive, no AI-slop. ChatGPT-grade. |
| 12 | Backend correctness / no 5xx | 9/10 | All routes 200; sanitized logs; taxonomy present; concurrency fix holds on fresh runs. |

**Weighted overall: 92/100.** Category 3 (the hero create flow) is the new binding constraint this pass; Cat 5/8 (run-detail raw leak) is the residual from #93.

---

## REMAINING GAP TO ≥95 (precise)

Two fixes, both small and well-scoped:

1. **(P1, hero) Fix the worker-generation terminal navigation.** In `apps/web/app/workers/new/page.tsx`:
   - Use a ref (e.g. `runIdRef`) instead of the stale `streamRunId` state inside `evtSource.onerror`, so the fallback navigates to `/runs/<id>` (or better, the created worker) instead of silently resetting.
   - On `completed`, prefer navigating to the **created worker editor** (the positioning promise: "opens the editor so you can review"), not just the generation run page. The author run result carries the suggested worker id.
   - Always show a toast on terminal (success → "Worker drafted", failure → mapped headline). Never reset to empty form with zero signal.
   - Verify live: generate → confirm URL changes to the worker/run + a success toast appears, no duplicate workers.

2. **(P1, run-detail) Stop the timeline subtitle from rendering raw `part.error`.** In `apps/web/components/RunDetailSplitPane.tsx`, feed the timeline node the same humanized `run.error` (or map `part.error` through the operator-message helper) so the subtitle matches the calm Error banner. Keep raw in the Raw tab + logs. ~5 lines.

After both: re-walk the create flow + a fresh failed run, confirm (a) generation lands on the worker/run with a toast, (b) no raw "Event loop is closed" on any default run-detail view. That clears ≥95.

---

## GATE DECISION

**92/100. NOT ≥95. G5 gate NOT passed.** The prior-93 blocker is genuinely closed and the named #256/#258 fixes work, but a fresh P1 in the hero create flow (silent reset on successful generation, reproduced twice live) plus the residual run-detail raw-string leak keep it under the bar. Both fixes are small (front-end only, ~10-15 lines + verification). The product is otherwise launch-grade. Recommend: ship the two fixes, re-walk, re-score — at that point this is a clear ≥95.

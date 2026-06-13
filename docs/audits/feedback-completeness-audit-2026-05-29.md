# Feedback Completeness Audit — Workeros (2026-05-29)

**Trigger:** the operator, 2026-05-28 23:xx (session ab820815):
> "As I made all these points before today, maybe have one more agent checking the session logs for open items that were not addressed. Also, looking at the feedback ledger, for example. Maybe it's not complete."

**Method.** Mined the operator's verbatim USER messages from the Workeros-related Claude Code session transcripts:
`ab820815` (current, 26,557 workeros mentions, 419 user msgs), `06ae6ad8` (cloud wiring), `ac2b2e4d` (landing), `877bed75` + `ac2b2e4d` (skills-neo Live Skills precursor), `ab90e586` (launch video). Deduped repeated asks. For each item, verified **reality** (curl prod API, grep `origin/main` code, `gh` PRs, prod SHA) — NOT the ledger's self-report. Cross-referenced against `docs/FEEDBACK-LEDGER.md`, `ISSUES.md`, `WORKPLAN-20260529-road-to-100.md`.

**Scope note.** This audit covers the **Workeros OS** product (workers.floom.dev / workers-api.floom.dev). It does NOT re-litigate the skills-neo Live Skills history (separate repo) except where the operator explicitly tied it to Workeros primitives.

---

## Headline counts

| Bucket | Count |
|---|---|
| Distinct the operator asks extracted (deduped) | **58** |
| ✅ SHIPPED + VERIFIED on prod now | 33 |
| 🔁 PARTIAL (some done, gap remains) | 9 |
| ⚠️ DONE-BUT-NOT-LIVE / REGRESSED (merged to main, NOT on prod, or broke again) | 6 |
| ❌ NEVER ADDRESSED (no evidence) | 10 |
| **Genuinely-open (⚠️+❌+🔁 gaps)** | **25** |
| Items in transcripts but MISSING from ledger AND workplan AND ISSUES | **7** |

> The ledger claims **65/72 shipped, 7 open**. Reality is closer to **33 truly-live, 25 with a real gap**. The single biggest distortion: the ledger marks items ✅ on "merged to main" while **prod was last deployed 2026-05-29 05:26 UTC and several `main` merges (incl. PR #233 connections fix at 07:48) are NOT live.** "Merged" ≠ "the operator can see it."

---

## The ranked actionable gap (the key deliverable)

Ordered by (a) how many times the operator raised it, (b) whether the ledger falsely calls it done.

### TIER 1 — Repeated 3+ times AND ledger says ✅ but reality disagrees

1. **Connections show placeholder identity + empty scopes + wrong Reconnect — STILL LIVE ON PROD.**
   Raised **5×** (USR 216, 359, 388, 416, + 2026-05-28 22:37). Ledger E1/E2/E3 = ✅ (PR #194/#233). **Reality:** `GET /connections` on prod right now returns `"account_label":"Connected account"`, `"display_name":null`, `"scopes":[]` for every connection. PR #233 (the real fix) merged 07:48 but **prod SHA started 05:26 — not deployed.** This is a ⚠️ DONE-BUT-NOT-LIVE. the operator literally said on 2026-05-28: *"All these points I made before. Also, default scopes, I think, is not correct."* — and it's still wrong. **ACTION: deploy main to prod + verify the account-info sweep repopulates real email/scopes.**

2. **`robots.txt` + `favicon.ico` return 404 (app HTML).**
   Raised 2× (USR 185 "no proper favicon"; workplan 1.5.5). **Reality:** `curl /robots.txt` → `text/html; 404`; `/favicon.ico` → `text/html; 404`. ❌ NEVER ADDRESSED. Workplan has it as `[ ]` 1.5.5 but ledger summary doesn't list it in the "7 open". **ACTION: ship static robots.txt + favicon + og/twitter tags.**

3. **Overview page design / "looks like a default admin dashboard."**
   Raised 4× (USR 363, 372, 378, 307 "overview is horrible? wtf is this?"). Ledger B1-B8 all ✅. **Reality:** the operator's LAST words on it (USR 372, 2026-05-28): *"this overview tab now completely left the design system... these red cards look like ai slop"* and (USR 307) *"overview is horrible."* Workplan still has overview polish implied. Status 🔁 PARTIAL — tiles/sparklines shipped, but the operator's design-quality bar was not signed off; needs a fresh visual gate. **ACTION: visual re-walk of /overview at the ChatGPT-simplicity bar; get explicit sign-off.**

### TIER 2 — Repeated, genuinely open, correctly-or-partly tracked

4. **MCP servers — connect the operator's existing 17 stdio MCPs.** Raised 4× (USR 204, 281, 289, 369). Ledger E5/E7/O7 = ❌. MCP *tab* + HTTP MCP shipped (#206); **stdio import flow never shipped.** `GET /connections/mcp` → 405 on prod (no list endpoint wired the way the operator expects). ❌ for the stdio part. Correctly open in ledger.

5. **Mobile optimisation pass (375px) across all surfaces.** Raised 2× (USR 250 "also mobile, once done"; USR 413 implied). Workplan 4.2 `[ ]`. ❌ NEVER ADDRESSED — no evidence of a mobile sweep. NOT in ledger's "7 open" list. **Gap in ledger.**

6. **Worker detail vs `/edit` layout divergence.** Raised 4× (USR 209, 269, 273, 370 "still has a fundamentally different layout... wasnt the plan"). Ledger D4 = ✅ (`?edit=1` toggle). **Reality:** USR 370 (2026-05-28, AFTER the ledger's PR) still reports `/workers/weekly_update/edit` "still has a fundamentally different layout." 🔁 PARTIAL / possibly ⚠️ regressed — needs a live diff of `/workers/<id>` vs `?edit=1`.

7. **CLI published to npm (`npx @floomhq/workeros install`).** Raised 3× (USR 138-142, 151). Workplan: "npm publish needed (flag: bump to 4.1.0)". ❌ NOT published — gated on E2E smoke. the operator explicitly asked "Tell me whenever the CLI package is published." Not in ledger's open list. **Gap.**

8. **Approvals as a standalone page reachable from the workspace agent.** Raised 2× (USR 400, 403 "I want to see the approvals standalone page once it exists"). Ledger Q1e/R2 = ✅. 🔁 likely shipped (PR #207/#210) but the operator never confirmed seeing it live — needs verification + show-the operator.

9. **Worker cards still too tall / activity bar on hover changing card size.** Raised 5× (USR 279, 285, 362, 375, 418 "jumping in size on hover (not good)"). Ledger C2 = ✅. **Reality:** USR 418 is the LATEST (2026-05-28 22:39) and still complains "jumping in size on hover." ⚠️ likely regressed or incompletely fixed.

### TIER 3 — Open, lower frequency

10. **Workers should not open in a new tab anymore.** USR 365, 418 ("As said before, workers should not open as a new tab anymore when I click on them"). Earlier ledger L2 = ✅ same-tab. the operator re-reports it 2026-05-28 → ⚠️ REGRESSED.

11. **Run detail left panel "scroll into infinity."** USR 418 ("/runs/run_192471d3a456 -> left panel scroll into infinity"). ❌ NEW, not in ledger. **Gap.**

12. **Folder-select "jump is weird when I select a folder because a new row opens up."** USR 418. ❌ NEW, not in ledger. **Gap.**

13. **Worker source code appears empty for some workers.** USR 418 ("why empty? /workers/opendraft#code Did you just remove the source code?"). **Reality:** API returns `run_py_content`/`skill_md_content`/`files` for opendraft (present). 🔁 — data exists; the `#code` tab rendering is the gap. Not in ledger.

14. **"Workeros" label bottom-left → user profile.** USR 287 ("'Workeros' at bottom left sucks. replace. maybe with user profile? like 'local user'"). Status unverified, not in ledger. **Gap.**

15. **Granola-HubSpot example produces only .md, not md+py.** USR 212 ("the granola + hubspot example should have md + py but rn only produces md"). Worker since deleted (O1), so moot — but the underlying "worker should support multi-file md+py" generation was a recurring ask (USR 191, 198, 235). 🔁 — multi-file supported in contract; generation default unverified.

16. **OpenDraft/OpenBlog real-engine limits ("there should be no limits", 300s timeout "is a lie").** USR 313, 314, 316. Workplan Phase 2: opendraft "IN PROGRESS (long-running ~44min)". 🔁 — runs complete but the "no limits / honest timeout" concern and runtime-quality assessment the operator demanded is not closed.

17. **`env-vars-worker` / `node-smoke-test` internal test workers visible in operator list.** Workplan DoD #3 ("no internal/test workers leaking"). **Reality:** both appear in `GET /workers`; `env-vars-worker` has `is_example=None` (not even labeled). ❌ — leaking. Not in ledger.

18. **Context not linked to any worker + only 1 context seeded.** USR 372/380/384 (contexts "right now its shit"). **Reality:** `GET /contexts` → 1 pack, `worker_count:0`. Ledger G-series ✅, but the seeded context isn't wired to a worker and nesting/preview polish (USR 401 "nested folders ofc") only landed in #226. 🔁.

---

## Items in transcripts but MISSING from ledger + workplan + ISSUES (the ledger's blind spots)

These are the items the operator's "maybe it's not complete" instinct was pointing at:

| # | Verbatim (abbrev) | USR | Status |
|---|---|---|---|
| G-1 | `robots.txt`/favicon 404 | 185 / workplan | ❌ (in workplan only, NOT in ledger 7-open) |
| G-2 | Mobile 375px sweep | 250, 413 | ❌ (workplan 4.2 only) |
| G-3 | CLI npm publish | 138-142, 151 | ❌ (workplan note only) |
| G-4 | Run-detail left panel infinite scroll | 418 | ❌ (nowhere) |
| G-5 | Folder-select row-jump UX | 418 | ❌ (nowhere) |
| G-6 | `env-vars-worker`/`node-smoke-test` leaking to operator | DoD#3 | ❌ (nowhere) |
| G-7 | "Workeros" bottom-left → user profile | 287 | ❌ (nowhere) |

---

## Full ask ledger (deduped)

Legend: ✅ shipped+live · ⚠️ done-but-not-live/regressed · ❌ never addressed · 🔁 partial · times = times raised.

| Item | Verbatim (abbrev) | Session | × | Status | Evidence | In ledger? | In workplan? |
|---|---|---|---|---|---|---|---|
| Spec fulfilled (create/run/observe workers) | "is this full spec fulfilled?" | ab820815 | 3 | 🔁 | 12 workers live, runs work; reliability ~90% | yes | yes |
| Host on vercel + real domain | "want a real domain, host on vercel?" | ab820815 | 1 | ✅ | workers.floom.dev 200 | M1 | — |
| API on self-hosted server | "api on this ax41 pls" | ab820815 | 1 | ✅ | workers-api.floom.dev live | — | — |
| Standalone product (not skills-neo) | "workeros should be standalone" | ab820815 | 3 | ✅ | separate repo + memory | M1 | — |
| Composio integration | "composio integration like skills-neo?" | ab820815 | 3 | ✅ | gmail/github connections active | E-series | — |
| Create workers from UI | "i can not create new workers?" | ab820815 | 2 | ✅ | /workers/new + draft endpoint | H1 | — |
| Observability on runs | "runs has 0 observability?" | ab820815 | 2 | ✅ | run timeline/logs/output | F1-F3 | — |
| Approvals: don't show fake | "i dont need approvals" → A-now-C-later | ab820815 | 2 | ✅→ | HITL respawn shipped (#207) | Q1 | — |
| Workspace switching / workspaces | "switch between workspaces" | 06ae6ad8/ab820815 | 3 | ❌→deferred | owner_id only; the operator later said "no multi-user for now" | M5 | DoD |
| Workers = skills (any md/py/multi-file) | "workers are based on skills" | ab820815 | 6 | ✅ | agent/script modes; WorkerContract | H-series | — |
| Sandbox: e2b or local | "sandbox logic? either local or e2b" | ab820815 | 4 | ✅ | runner=e2b on prod | A-series | — |
| Cron + webhook triggers | "obv we need cron and webhook" | 877bed75/ab820815 | 3 | ✅ | trigger_type on workers | — | — |
| Composio triggers (app events) | "Composio triggers like cron/webhook" | ab820815 | 2 | 🔁 | t15a lane; not confirmed live | — | — |
| 1000 Composio integrations on browse page | "all of the 1,000 integrations?" | ab820815 | 2 | ✅ | /connections/browse catalog | E-series | — |
| Real logos + scopes on connections | "real logos and all... scope we connected for" | ab820815 | 3 | ⚠️ | logos yes; scopes `[]` live | E3 | — |
| White-label Composio → Floom screen | "say floom + secured by composio" | ab820815 | 4 | 🔁 | interstitial added; the operator re-flagged USR 338 | — | — |
| Account name shows real email | "Connected as federico cannot be it" | ab820815 | 5 | ⚠️ | live = "Connected account" | E2 | — |
| Reconnect only when broken | "why reconnect if already connected" | ab820815 | 3 | ⚠️ | fix #233 not deployed | E1 | — |
| MCP connections tab | "next to connections i should add MCPs" | ab820815 | 4 | 🔁 | tab+HTTP shipped; stdio import ❌ | E4/E5/E7 | yes |
| Import 17 existing stdio MCPs | "integrate all the ones i have" | ab820815 | 2 | ❌ | not shipped | E5 | yes |
| One-command MCP add | "usually is just one command" | ab820815 | 2 | ✅ | paste-JSON + targets (#206/#219) | E6/R5 | — |
| Worker cards = employees, logos, short | "feel like employees... avatar" | ab820815 | 5 | 🔁 | cards+logos (#185/#229); hover-jump ⚠️ | C1-C3 | yes |
| Cards jump size on hover | "jumping in size on hover (not good)" | ab820815 | 5 | ⚠️ | re-flagged USR 418 (latest) | C2 | — |
| Worker detail tabs + back arrow | "no arrow back to workers" | ab820815 | 4 | ✅ | tabs+back (#141/#177) | D1 | — |
| detail vs /edit same UX | "edit page fundamentally different" | ab820815 | 4 | 🔁 | `?edit=1` (#177); re-flagged USR 370 | D4 | — |
| Triggers: add ABOVE configured | "add trigger ABOVE configured" | ab820815 | 2 | ✅ | #179 | D3 | — |
| Multiple triggers list UX | "what if i have multiple triggers?" | ab820815 | 2 | ✅ | #179 | D5 | — |
| Runs grouped + click-through | "not clear i can click recent runs" | ab820815 | 3 | ✅ | #159/#158 | F1 | — |
| Run detail output + download | "show output (+download) and input" | ab820815 | 2 | ✅ | #158 | F2 | — |
| Run page alignment w/ other pages | "not aligned with the other yet, at all" | ab820815 | 4 | 🔁 | square design adopted; left-panel scroll ❌ | F3 | — |
| Run-detail infinite left scroll | "scroll into infinity" | ab820815 | 1 | ❌ | USR 418, nowhere | — | — |
| Contexts as folder, any file type | "context... folder with files" | ab820815 | 4 | ✅ | /contexts live | G1 | — |
| Contexts nested folders + preview | "nested folders ofc?" | ab820815 | 2 | ✅ | #226 | G-series | 5.1 |
| Contexts "right now its shit" redesign | "needs to be improved" | ab820815 | 3 | ✅ | #192 knowledge-packs | G5 | — |
| Context linked to workers | (implied) | ab820815 | 1 | 🔁 | worker_count:0 live | — | — |
| Workspace agent (chat endpoint) | "agent that sits on top of my workspace" | ab820815 | 2 | ✅ | POST /chat 200 | I1 | — |
| Chat endpoint not full UI | "chat ui not necessary for launch" | ab820815 | 1 | ✅ | endpoint only | I1 | — |
| OpenAI Agents SDK | "we want to use the agent SDK" | ab820815 | 3 | ✅ | openai-agents==0.17.4 | — | — |
| web_search + native tools work | "web search... not acceptable" | ab820815 | 4 | ✅ | WebSearchTool wired; CRIT-1 fixed | — | 1.5 |
| Worker reliability — actually run | "mostly focus on workers actually running" | ab820815 | 5 | 🔁 | 9/10 smoke; github-digest needs re-auth | M2 | Phase 2 |
| OpenDraft/OpenBlog real engines, no limits | "300s timeout is a lie" | ab820815 | 3 | 🔁 | runs complete; limits concern open | — | Phase 2 |
| Label mock/test workers | "label all skills as mock" | ab820815 | 1 | ✅ | is_example=True | M2 | — |
| Internal test workers leaking | (DoD #3) | ab820815 | 1 | ❌ | env-vars/node-smoke live | — | — |
| LinkedIn engagement skill | "scraping my LinkedIn posts" | ab820815 | 2 | 🔁 | built; archived (Apify credits) | — | 2.2 |
| Overview = command center, not admin | "looks like a default admin dashboard" | ab820815 | 4 | 🔁 | tiles/sparklines; design re-flagged | B1-B8 | — |
| Overview left design system / AI slop | "ai slop... never leave design system" | ab820815 | 2 | ⚠️ | USR 372 re-flagged | B3/K1 | — |
| Overview fits one screen | "fit on one screen, no scroll" | ab820815 | 1 | ✅ | #187 | B5 | — |
| Tabs on URL slug (#) | "all tabs should have # on url" | ab820815 | 2 | 🔁 | partial; USR 307 "no # slugs" | — | — |
| Workers NOT open in new tab | "should not open as a new tab" | ab820815 | 2 | ⚠️ | re-flagged USR 418 | L2 | — |
| Single-blue dark mode | "stick to one shade of blue" | ab820815 | 3 | ✅ | #187 | K3 | — |
| Square/rounded consistency | "global design system" | ab820815 | 3 | 🔁 | tokens #187; 4.1 radius open | K4 | 4.1 |
| Sidebar darker than content / no blue border | "remove blue border on sidebar" | ab820815 | 3 | ✅ | #180/#183 | K-series | — |
| Faster load times | "fastest possible?" | ab820815 | 2 | ✅ | RSC+ISR #182 | L1 | — |
| robots/favicon | "no proper favicon" | ab820815 | 2 | ❌ | 404 live | — | 1.5.5 |
| Mobile sweep | "also mobile" | ab820815 | 2 | ❌ | no evidence | — | 4.2 |
| CLI npm publish | "tell me when CLI published" | ab820815 | 3 | ❌ | not published | — | note |
| "Workeros" → user profile | "'Workeros' bottom left sucks" | ab820815 | 1 | ❌ | unverified/nowhere | — | — |
| Security: sandbox/auth/OWASP | "I owned your machine" audits | ab820815 | 6 | ✅ | e2b isolation real; 11/11 probe; #232 P0 fix | A/N | yes |
| Cost cap on OpenAI/runtime | "cap the cost of the OpenAI agent" | ab820815 | 2 | 🔁 | concurrency cap #203; per-run cost cap unverified | R4 | — |
| Email alerting (later, not Slack) | "later on via email will be good" | ab820815 | 2 | ✅ | SMTP alerting #218 | R6 | Phase 3 |
| Cloud version (Supabase auth/billing) | "cloud-hosted with supabase" | 06ae6ad8/ab820815 | 4 | ❌→Cloud lane | separate repo, not started | M5 | — |
| Keep OS/Cloud modular/interchangeable | "auth and db interchangeable" | ab820815 | 2 | 🔁 | brief written; not implemented | M1 | — |
| Positioning: stop "OS for background workers" | "still saying OS for background workers" | ab820815 | 3 | 🔁 | copy partly updated; memory saved | — | DoD#5 |
| Document all feedback / don't lose items | "we need to document" | ab820815 | 3 | 🔁 | ledger exists but undercounts (THIS audit) | N5 | — |

---

## Systemic patterns (what keeps slipping)

1. **"Merged" treated as "done." The #1 leak.** The ledger marks ✅ on PR-merge; prod was last deployed 05:26 UTC while fixes kept merging after (PR #233 at 07:48). the operator sees the *live* site, so a merged-but-undeployed fix reads to him as "ignored again." **Fix: ledger status ✅ requires a prod-SHA + live-curl/screenshot timestamp, not a PR number.**

2. **Visual/design items closed on "code shipped," never on the operator's eyes.** Overview, worker cards hover-jump, edit-vs-detail, run-page alignment were all marked ✅ then re-flagged by the operator in a later session. Greppable evidence ≠ visual parity (this is the exact CLAUDE.md anti-pattern).

3. **Latest-message-wins not enforced.** Several items have an early ✅ PR and a *later* the operator complaint about the same thing (cards hover USR 418, new-tab USR 418, edit-layout USR 370, overview USR 372). The ledger captured the early PR, not the later re-flag.

4. **Brand-new one-off complaints in image-heavy messages get dropped.** USR 418's three sub-bugs (infinite scroll, folder row-jump, empty #code) landed in NO doc. Dense multi-point messages with screenshots are where items vanish.

5. **"Tracked in workplan only" ≠ tracked.** robots/favicon, mobile, CLI-publish live in the workplan as `[ ]` but are absent from the ledger's "7 genuinely open" summary, so a reader trusting the ledger headline misses them.

---

## Recommended immediate actions (smallest set that closes the trust gap)

1. **Deploy `main` to prod now** and re-verify connections account-name + scopes + Reconnect live (closes the single most-repeated grievance, #1/#16/#17).
2. **Ship robots.txt + favicon** (trivial, 404 today, raised twice).
3. **Live visual re-walk** of /overview, /workers cards (hover), /workers/<id> vs ?edit, /runs/<id> — fix the re-flagged regressions, get explicit sign-off (don't self-close).
4. **Add the 7 missing items** (G-1..G-7) to ISSUES.md + workplan so nothing lives only in this audit.
5. **Change the ledger's ✅ definition** to require prod-SHA + live evidence + "latest the operator message on this topic" check.

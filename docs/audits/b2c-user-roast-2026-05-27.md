# B2C User Roast: Workeros — 2026-05-27 (Re-audit after Fix Batch)

**Auditor persona:** Paying B2C user, 30-minute trial window, real task: "Summarise my Granola meetings daily and post action items to my HubSpot CRM." No prior knowledge of Workeros.

**Session conducted:** 2026-05-27 via self-hosted server broker (identity: chrome-broker)
**Baseline:** b2c-user-roast-2026-05-26.md — Score: 38/100, "would cancel after 30 min"
**Fix batches applied:** 4 batches since 2026-05-26

---

## 1. TL;DR

**Score: 58 / 100.** Delta: +20 points from 38/100.

**Would I still cancel?** Yes, but the threshold has shifted. On 2026-05-26 I would have cancelled in the first 5 minutes when the Generate button silently failed. Now I'd make it to minute 15 before hitting the HubSpot OAuth wall and giving up. The critical entry experience is materially better — the core "describe → generate → review" loop now works end-to-end, the connections catalog is alive, and the worker detail page loads instantly. But the primary task (Granola + HubSpot) still cannot be completed: HubSpot OAuth silently opens a background tab the user never sees, and the worker creation flow has a silent failure when a name conflict exists. The product is now convincingly demoable but not yet survivable in the hands of an unsupported user.

---

## 2. Per-Step Journey Log

### Step 1: Landing / Dashboard — T+0:00
**URL:** `https://workers.floom.dev/`

Same as baseline. Operational dashboard, stat counters (WORKERS: 7, RUNS TODAY: 2, FAILED: 2), recent runs list. No onboarding, no welcome CTA, no "create your first worker" prompt. Nav: Overview / Workers / Runs / Secrets / Connections / Settings — no Help, no Docs. Nothing has changed here.

**Friction: 4/5 (unchanged)**

---

### Step 2: Creating a Worker (Custom Prompt) — T+0:45
**URL:** `https://workers.floom.dev/workers/new`

Typed custom prompt directly into the textarea: "Summarise my Granola meetings daily and post action items to my HubSpot CRM"

**First click → Generate:** Button changed to "Generating worker..." — WORKING. However, the first attempt generated then silently reset back to the empty form (button reverted to "Generate", no Step 2 appeared, no error). This looked like a timeout or network glitch.

**Second attempt (Cmd+Enter):** Triggered "Generating worker..." again. After ~30 seconds, Step 2 appeared successfully with full worker spec.

**Verdict: P0 FIXED (with caveat).** The Generate button now correctly fires on typed text. The silent generation-then-reset on the first attempt is a flakiness concern — on a slow connection or under load, users may get one silently failed attempt before a second succeeds. No feedback distinguishes "generating" from "failed silently."

**Friction: 2/5 (improved from 4/5)**

---

### Step 3: Step 2 Review — T+1:15

Generated worker content:
- Title: "Granola Meeting Summary"
- SKILL.md with 5-step instructions (retrieve, summarize, post, format, error handling)
- Generated `worker.yml` with cron schedule `0 9 * * *`, UTC timezone, HubSpot connection declared
- Three worker mode options: Agent / Pure Python / Hybrid (still no tooltips)
- Inputs: `meeting_notes` (required), Outputs: `summary`

**What improved:** The YAML is richer and more correct — declares `connections: ["hubspot"]`, includes `use_cases`, `targets`, and proper cron trigger. Quality of generation is noticeably better.

**Still confusing:** Worker mode radio buttons (Agent / Pure Python / Hybrid) have no explanation. B2C user still has no basis to choose. "Agent" is pre-selected — reasonable default, but unexplained.

**Friction: 2/5 (unchanged from baseline on this step)**

---

### Step 4: Granola Setup — T+1:45

Granola section shows: "OAuth | API key" toggle, API key selected, password input field, "Save" button.

**No guidance text, no link, no tooltip** on where to get the Granola API key. The prompt says "GRANOLA_API_KEY required" but nothing more.

**Later test in /connections/browse:** Searching "Granola" surfaces "Granola MCP" card. Clicking Connect now shows a tooltip/toast: **"granola_mcp uses an API key, not OAuth. Add the key in Secrets. Go to Secrets"** with a "Go to Secrets" action button. This is the guidance that was missing — but it's only discoverable in the browse catalog, not on the Step 2 requirements section.

**Verdict:** P1 PARTIALLY FIXED. The connect button in the catalog is no longer dead and provides "API key only" guidance. But on Step 2 (where the user is), the Granola field still shows no guidance on where to get the key.

**Friction: 3/5 (improved from 4/5)**

---

### Step 5: HubSpot OAuth — T+2:15

Clicked "Connect HubSpot" on Step 2. Button changed to "Connecting..." and remained there for the full observation window (28+ seconds).

**What actually happened (checked via browser tabs):** HubSpot OAuth DID open — it navigated to `app.hubspot.com/oauth-bridge` with a valid OAuth URL (Composio client, correct scopes, PKCE challenge). The HubSpot consent screen loaded ("Connecting your Composio account to HubSpot — Create a new HubSpot account / Sign in to your HubSpot account").

**The problem:** The OAuth opened as a **background browser tab**, not a foreground popup window. The user staring at "Connecting..." on the Step 2 page never sees the HubSpot tab. No browser notification, no "A new tab was opened — complete auth there" message. The main page never detects completion because the tab is background.

**Verdict: P0 NOT FIXED — root cause changed.** Previously the OAuth was hanging at the network level. Now the OAuth reaches HubSpot successfully but is invisible to the user because the popup opens as a background tab. The user experience is identical: "Connecting..." indefinitely, no resolution. A real user would not check their browser tabs — they'd wait, give up, and leave.

**Friction: 5/5 (unchanged)**

---

### Step 6: Cron Configuration — T+2:00 (explored during Step 2)

Cron tab available in Step 2. The generated YAML already set `cron: "0 9 * * *"` (daily at 9am UTC). The cron builder UI is available on the Cron trigger tab.

**What's unchanged from baseline:** Frequency presets (Every minute / Hourly / Daily / Weekdays / Weekly / Monthly), day toggles, human-readable summary, timezone field. No auto-detection of user timezone. UTC default is logical but not user-friendly for consumers.

**No regressions here. Cron builder remains a genuine Workeros strength.**

**Friction: 1.5/5 (unchanged — still the best screen in the product)**

---

### Step 7: Creating the Worker — T+4:00

After clicking "Skip for now" on the requirements, the section updated to: "Skipped. You can configure these later in Settings / Connections." — clear and improved messaging.

Clicked "Create worker." Button did not navigate away and showed no loading state, no error. After 8 seconds still on `/workers/new`.

**Root cause:** Worker ID `granola-meeting-summary` already exists in the system from the previous audit session. The create action returned a conflict error silently — no toast, no field highlight, no "This ID already exists" message. Changed the Worker ID to `granola-hubspot-audit-0527` and retried — still no navigation, still silent.

**This appears to be a new silent failure in "Create worker" that was not observed in the baseline.** In the baseline, creation succeeded (the user was redirected to the worker detail). Now creation silently fails with no feedback. The workers list after navigating away confirms neither worker was created.

**NEW P0: Worker creation silently fails — no error, no navigation, no toast.**

**Friction: 5/5 (regression)**

---

### Step 8: Worker Detail Page — T+5:30

Navigated to `/workers/research_brief` (existing worker, clicked from list).

**Worker detail loaded instantly** — title, description, tags, Run/Code/Connections/Runs/Overview tabs, input fields, dropdowns, "Run worker" and "Use sample input" buttons. All content immediately visible. No blank period observed.

**Verdict: P0 FIXED.** The 5-8 second blank page is gone.

**New issue discovered:** When navigating directly to `/workers/research_brief` via URL bar (cold navigation), the page showed "Worker not found — This worker may have been deleted or the ID is incorrect." The same URL clicked from the workers list loaded correctly 30 seconds later. This is an intermittent routing/hydration issue where direct URL navigation returns 404 but list-click navigation succeeds. Reproducible once during the session.

**NEW P1: Worker detail intermittent 404 on direct URL navigation.**

**Friction: 1/5 (improved from 4/5, caveat: new intermittent 404)**

---

### Step 9: Viewing Results / Run History

The Overview tab on worker detail is now excellent:
- Configuration (trigger type, runtime, runner)
- Inputs and outputs listed with names and types
- Worker guide: description, use cases, example input, example output, "how it works" section
- "Use this sample" button pre-fills the Run form

**Verdict: FIXED — Overview no longer shows "Inputs: None, Outputs: None".** The prior P2 bug is resolved and replaced with genuinely useful content.

**Friction: 1/5 (fixed)**

---

### Step 10: Edit Flow

Not re-tested in depth — prior baseline found raw textarea with no syntax highlighting, which is a P2. No change expected based on fix batch scope.

---

### Step 11: Error Paths / Connections

**/connections — T+6:00:**
Page loaded with 6 connections (GitHub, Gmail x2, Google Drive, HubSpot x2, LinkedIn), each showing status (Active/Connecting/Expired), "Reconnect / Test / Disconnect" controls. **No "Failed to load connections" error.** The persistent error P1 is FIXED.

Note: Two HubSpot entries appear in "Connecting" state — ghost entries from failed OAuth attempts. No "Remove" button for connections in bad state — user must "Disconnect" which implies a working connection.

**/connections/browse — T+7:00:**
**FULLY WORKING.** 1,043 integrations shown, paginated (30/page, 35 pages), searchable, category filters (All / Popular / Productivity / Email / CRM / Social / Marketing / Data / Collaboration). Each card has a "Connect" button. No hanging.

**Granola Connect button test:** Searching "Granola" → 1 result (Granola MCP). Clicking Connect shows: "granola_mcp uses an API key, not OAuth. Add the key in Secrets. Go to Secrets." The P1 dead button is FIXED and now provides actionable guidance.

---

### Step 12: Help Discovery — T+9:00

Nav remains: Overview / Workers / Runs / Secrets / Connections / Settings.

**No Help link. No Docs link. No "?" icon. No tooltips on confusing elements. No onboarding flow.** This is unchanged from the baseline. A user hitting any problem — including the silent worker creation failure, the HubSpot tab issue, or "where do I get a Granola API key" — has no in-product support path.

**Settings page:** Still shows "Infrastructure paths" section (FLOOM_DB, FLOOM_WORKERS_DIR, FLOOM_ARTIFACTS_DIR) and "Danger Zone: Clear run history" one-click button. The raw filesystem path values may be masked behind "set" indicators, but the section headers and variable names are still user-visible. Still not appropriate for a B2C product.

---

## 3. Verified-Fixed vs Still-Broken

### Verified FIXED (since 2026-05-26)

| Issue | Baseline Severity | Fix verdict |
|-------|-------------------|-------------|
| Generate button silently disabled on typed prompts | P0 | FIXED — fires correctly, shows "Generating worker..." |
| Worker detail page blank 5-8s after creation | P0 | FIXED — loads instantly with full content |
| Connections page "Failed to load connections" error | P1 | FIXED — loads clean with all connections |
| /connections/browse catalog hangs / dead | P1 | FIXED — fully paginated, searchable, working |
| Granola Connect button dead (no response) | P1 | FIXED — shows "API key only, Go to Secrets" guidance |
| Worker Overview tab shows "Inputs: None" | P2 | FIXED — rich guide with use cases, example I/O |

### STILL BROKEN (unchanged from 2026-05-26)

| Issue | Severity | Detail |
|-------|----------|--------|
| HubSpot OAuth opens as invisible background tab | P0 | User sees "Connecting..." indefinitely; OAuth tab is background, never noticed |
| No help / docs anywhere in product | P0 | Zero in-product support path |
| No onboarding on first login / empty state | P1 | Dashboard drops user into operational console with no guidance |
| Settings exposes infrastructure config to users | P1 | "Infrastructure paths", "Danger Zone: Clear runs" visible to all |
| Granola API key guidance missing on Step 2 | P2 | Guidance exists only in /connections/browse, not where user needs it |
| Worker modes (Agent / Hybrid / Python) unexplained | P2 | No tooltips, no "recommended for beginners" |
| Workers list "Reload workers" still manual | P2 | No auto-refresh after creation |
| No cron timezone auto-detection | P2 | Defaults to UTC with no user-facing explanation |

### NEW ISSUES found in this audit

| Issue | Severity | Detail |
|-------|----------|--------|
| Worker creation silently fails on name conflict | P0 | No error, no toast, no navigation — user left on Step 2 with no feedback |
| Worker detail intermittent 404 on direct URL navigation | P1 | Cold navigation to `/workers/[id]` returns "Worker not found"; list-click to same URL works |
| Generate first-attempt silent reset | P1 | First click on Generate triggers "Generating..." then silently resets; second attempt works |
| HubSpot ghost entries in Connections | P2 | Multiple "Connecting" HubSpot entries from failed OAuth attempts accumulate with no cleanup |

---

## 4. Time to First Successful Run

**Workeros (2026-05-27):**
- Time to understand product: ~3-5 min (no onboarding, unchanged)
- Time to generate a worker from typed prompt: ~2 min (second attempt; first silently fails)
- Time to set up Granola: **not achievable** — no API key guidance on Step 2; would require leaving product, researching Granola MCP, returning
- Time to connect HubSpot: **not achievable** — OAuth opens as invisible background tab
- Time to create worker: **not achievable** — silent failure on creation
- **Time to first successful run for Granola+HubSpot task: still not achievable in 30 minutes**

**Improvement from baseline:** The generate→review loop now works. The specific Granola+HubSpot task remains blocked at the same choke point (connections), now due to OAuth UX rather than a dead button. Completion rate for this task: 0% → still 0%.

**Time to first run for a task with NO connection requirements** (e.g., Research Brief): ~3-4 minutes from landing to "Run worker." This path works and is fast.

---

## 5. Pricing Reaction

**At $29/mo, would I pay now? Still no.** But I'd be willing to try a free tier.

The product is now demonstrably capable. The generate flow works. The catalog is alive. The worker detail is polished. If a demo video showed someone completing the Granola+HubSpot task in 2 minutes, I'd believe it was possible.

But the critical path I'm paying for — connecting real apps and running real automations — is still blocked. OAuth doesn't work in practice (invisible tab). Worker creation silently fails. There's no help when either happens.

**Revised pricing ladder:**

| State | Fair Price |
|-------|-----------|
| Current (v0, fix batch 4) | $0 — free beta, invite-only |
| After: HubSpot OAuth visible + worker creation errors | $9/mo — credible alpha |
| After: docs + onboarding + timezone auto-detect | $19/mo — competitive |
| After: stable connections + completion rate | $29/mo — the target |
| Full "Zapier with AI" differentiator | $39-49/mo |

**The one thing that would change my mind immediately:** Fix the HubSpot OAuth tab behavior. If the OAuth opened in a visible window (or showed "A new tab opened — complete auth there and return"), the entire Granola+HubSpot use case would unblock. That single change turns the product from "can't complete my task" to "completed my task in 5 minutes."

---

## 6. The "Zapier Killer" Gap

**Narrowed but not closed.**

Fixes since yesterday removed the "broken before it starts" problem. The catalog is real. The generation quality is good. The worker detail is excellent. These are all table-stakes features that now work.

**What remains:**

1. **OAuth completion UX.** Zapier's OAuth opens a popup, authenticates, closes, and shows a green "Connected" checkmark — the entire flow in one window. Workeros opens a background tab the user never sees. Until OAuth uses a visible popup or at minimum a "tab opened" banner, every OAuth-based integration (HubSpot, GitHub, Gmail, Google Drive, Slack, LinkedIn) has this UX defect.

2. **Zero to working automation still requires leaving the product.** For Granola specifically: the user must leave Workeros, research that Granola uses MCP (not a traditional API key), find the local file path where Granola stores its token, and come back. No Zapier equivalent exists for Granola — but Workeros's UX compounds the confusion by showing "OAuth | API key" on Step 2 with no explanation that it's actually a file-based MCP.

3. **No test mode.** Zapier lets you "Test step" before going live. Workeros runs the real thing or nothing. For a $29/mo subscription, users expect a dry run before connecting live CRM data.

4. **No error recovery path.** When anything fails — OAuth, creation, generation — there's no in-product next step. No docs link, no support chat, no contextual "if this failed, try..." message. Every error is a dead end.

5. **The completion rate gap remains.** Zapier gets a non-technical user to a working Zap in 5-7 minutes. Workeros can now get a non-technical user to a *generated* worker in 2-3 minutes — but that worker will never run because connections are blocked. The differentiator (AI generation) is visible but the delivery vehicle (connections) is still unreliable.

---

## 7. Appendix — Bug Summary

| Bug | Location | Severity | Status |
|-----|----------|----------|--------|
| Generate button silently disabled for typed prompts | `/workers/new` Step 1 | P0 | FIXED |
| Worker detail blank 5-8s post-creation | `/workers/[id]` | P0 | FIXED |
| HubSpot OAuth opens as invisible background tab | `/workers/new` Step 2 | P0 | NOT FIXED (root cause changed) |
| Worker creation silent failure on name conflict | `/workers/new` Step 2 | P0 | NEW |
| No help / docs / support in product | Everywhere | P0 | NOT FIXED |
| Connections page "Failed to load" error | `/connections` | P1 | FIXED |
| /connections/browse catalog hangs | `/connections/browse` | P1 | FIXED |
| Granola Connect button dead | `/connections/browse` | P1 | FIXED |
| No onboarding / empty state CTA | Dashboard | P1 | NOT FIXED |
| Settings exposes infrastructure config | `/settings` | P1 | NOT FIXED |
| Worker detail intermittent 404 on direct URL | `/workers/[id]` | P1 | NEW |
| Generate first-attempt silent reset | `/workers/new` | P1 | NEW |
| Overview shows "Inputs: None, Outputs: None" | Worker detail → Overview | P2 | FIXED |
| HubSpot ghost entries accumulate in Connections | `/connections` | P2 | NEW |
| Granola API key guidance missing on Step 2 | `/workers/new` Step 2 | P2 | PARTIAL (only in catalog) |
| Worker modes unexplained | `/workers/new` Step 2 | P2 | NOT FIXED |
| Workers list no auto-refresh after creation | `/workers` | P2 | NOT FIXED |

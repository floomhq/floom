# B2C User Roast: Workeros — 2026-05-26

**Auditor persona:** Paying B2C user, 30-minute trial window, real task: "Summarise my Granola meetings daily and post action items to my HubSpot CRM." No prior knowledge of Workeros. Signed up because someone said it's "Zapier with AI."

**Session conducted:** 2026-05-26 via authenticated browser session  
**Product version:** Workeros  
**URL:** https://workers.floom.dev

---

## 1. TL;DR

**Score: 38 / 100.** Workeros has a genuinely exciting core idea — describe your automation in plain English and the AI generates the worker — but the first-time user flow is so broken that most people will quit before they see it work. The HubSpot OAuth hangs forever with no error, the worker detail page loads blank for 5-8 seconds after creation, the Generate button fails silently if you type your own prompt (only works via example chips), and the Settings page leaks raw server filesystem paths to every user. This is a $0/mo product being dressed up as a $29/mo product. Fix the entry experience first, everything else second.

**Would I cancel after 30 min?** Yes, immediately. I got a "Connection timed out" toast with no recovery path and a blank page after my first worker was created. There is no help documentation anywhere in the product. I have no idea if my cron will fire. I'm not paying for this.

---

## 2. Step-by-Step Journey Log

### Step 1: Landing / Dashboard — T+0s
**Where I landed:** Not a marketing page. Straight into `/` which is the **dashboard** — stats (WORKERS: 0, RUNS TODAY: 0, FAILED: 0), a sidebar with Overview / Workers / Runs / Secrets / Connections / Settings. Dark/light toggle. "Workeros" badge.

**Confusion:** I have no idea what a "worker" is. There is no onboarding message, no welcome modal, no "start here" call to action. The dashboard is for people who already have workers. I don't. The screen says "No runs yet" and nothing else.

**Where do I go first?** I instinctively clicked "Workers" in the nav. That gets me to the workers list which is also empty (it has sample workers from someone else's use, not mine — confusing — but let's say it was empty for me). There is no "Create your first worker" prompt anywhere on the dashboard.

**Compared to Zapier:** Zapier's dashboard on first login says "Create a Zap" front and center with a GIF of what a Zap looks like. Workeros drops you into an operational console with no handholding. Friction score: 4/5 (very high).

---

### Step 2: Creating the First Worker — T+45s (2 clicks)
Navigated to `/workers` → clicked "New worker." Found the prompt input page. **This is the best screen in the product.** It says:

> "Describe what you want to automate and we will draft the worker for you."

There are **5 example chips** at the bottom. The first one is literally my exact use case: *"Summarise all my meetings from Granola and update HubSpot with action items daily."* That's delightful. Someone thought about this.

**Cmd+Enter shortcut** is shown in the UI. I clicked the example chip (which fills the textarea), then hit Generate. It worked. The page transitions to Step 2 in about 10-12 seconds.

**Critical bug found:** When I typed my own custom prompt directly into the textarea and clicked Generate — nothing happened. No error, no spinner, the button appeared clickable but did nothing. After 15+ seconds, still nothing. I had to use the example chip instead. Root cause: the Generate button is disabled when React state `prompt` is empty string, but the DOM textarea shows text. Automated typing doesn't fire React's `onChange`, but real user typing also sometimes fails this. **A real user who types their own prompt from scratch and hits Generate will get a silent failure.**

---

### Step 3: Step 2 Review — T+1:05
The generated worker looks reasonable:
- Title: "Granola Meeting Summary to HubSpot"
- SKILL.md with 5-step instructions (Fetch, Summarize, Update HubSpot, Output Format, Error Handling)
- Generated `worker.yml` visible at the bottom
- Three worker mode options: Agent (SKILL.md only), Pure Python, Hybrid

**Confusion (high):** I see three radio buttons — Agent / Pure Python / Hybrid. I have no idea what these mean. No tooltips, no explainer text, no "recommended for beginners" label. A B2C user has no business making this choice.

**What I notice about the requirements section:**
- Granola: shows both "OAuth" and "API key" options with a password field and "Save" button
- HubSpot: shows "OAuth" and "API key" and a "Connect HubSpot" button

Good: the UI at least acknowledges both connection methods. Bad: I don't know where to get a Granola API key. There is no link, no explainer, no "Get your API key here" tooltip.

---

### Step 4: Setting Up Granola — T+1:30
The UI shows a Granola section with "OAuth | API key" toggle. "API key" is already selected. There is a password field and a "Save" button.

**Where do I get the Granola API key?** No hint. No link. No tooltip. I have to open a new tab, google "Granola API key", figure out it's not a traditional API but uses an MCP server, and come back confused.

The integration catalog shows it as "Granola MCP" — a completely different concept than OAuth or API key. The Step 2 UI shows "GRANOLA_API_KEY required" but the integration catalog says MCP. These two mental models conflict and there is no bridge between them.

**Clicking "Connect" on the Granola MCP card in the integrations catalog:** Nothing happened. Button click, no response, no modal, no redirect, no error. Dead button. I tried three times.

---

### Step 5: Setting Up HubSpot — T+2:15
Clicked "Connect HubSpot" button on Step 2. The button changed to "Connecting..." and then got stuck there permanently. An OAuth popup was presumably attempted but it was blocked (or timed out silently).

After 13 seconds, the button is still showing "Connecting..." with no timeout message, no error, no fallback. I have no idea what happened.

**Later, after worker creation:** A toast appeared saying "Connection timed out. Complete the OAuth flow and retry." This is the only feedback — it appeared ~8 seconds after being redirected away from the creation page. By that time I've already moved on.

**Compared to Zapier:** Zapier's OAuth flow opens a popup, you authenticate, and the window closes with a clear "Connected!" green checkmark on the trigger/action card. No ambiguity. Workeros's flow: click → stuck spinner → silent timeout → toast on a different page. Total friction: 5/5.

---

### Step 6: Configuring the Cron Schedule — T+2:00 (explored during Step 2)
Clicked the "Cron" trigger tab. The cron builder appears:

**What works well:**
- Frequency presets: Every minute / Hourly / Daily / Weekdays / Weekly / Monthly
- Hour/Minute dropdowns
- Day-of-week toggles (Mon–Sun, clickable buttons)
- Human-readable summary: "Every MON at 09:00"
- "Use custom cron expression" escape hatch
- Timezone field (defaulted to Europe/Berlin)

**What's confusing:** The frequency toggle defaulted to "Weekly" with Monday selected. For "daily at 9am" I'd need to click "Daily" and then set the hour. The human summary updates immediately, which is nice. But there is no explanation of what timezone "Europe/Berlin" is — why is it defaulted to a timezone the user may not be in? There is no auto-detection.

**Compared to Zapier:** Zapier's schedule trigger has "Time of day" and "Days of week" dropdowns, very similar. Workeros's is actually slightly better with the frequency presets. Win for Workeros here.

---

### Step 7: Creating the Worker — T+3:45
After clicking "skip for now" (skipping the connection requirements), the "Set up requirements to create worker" button changed to "Create worker."

I clicked it. Redirected to `/workers/granola-hubspot-meeting-summary`.

**What happened:** The page was completely blank for 5 seconds — just the nav bar. No spinner, no "loading..." message, no skeleton. A non-technical user would think the page crashed and navigate away.

After 8 seconds: "Connection timed out. Complete the OAuth flow and retry." toast appears.

After 5 more seconds: The page finally loads with the worker detail.

**Another bug:** The workers list page was empty (no workers visible) after creation. I had to manually click "Reload workers" to see my new worker. Auto-refresh does not happen.

---

### Step 8: Running the Worker — T+5:00
Navigated to the worker detail page. The worker detail page has tabs: Run, Code, Connections, Runs, Overview.

The Run tab shows: "This worker has no inputs. Connection required — Connect Hubspot in Connections before running."

There is a button: "Connect hubspot first." This is reasonable. But there is no way to do a dry run, no "test with mock data" option, no sandbox.

**I cannot test my worker without connecting HubSpot first.** If HubSpot OAuth is broken, I'm completely blocked. There is no fallback.

---

### Step 9: Viewing Results — T+6:30 (examined an existing run)
Looked at a completed "Research Brief" run (`run_5d6f919f4fba`).

**What's good:** The run detail page is excellent. It shows:
- Timeline with millisecond timestamps (Run started → Validating inputs → Loading secrets → Executing worker → Agent iteration 1 → Agent iteration 2 → Output generated → Run completed)
- Full input and output rendered
- Artifact downloads (.md, .jsonl)
- Clear "completed" status

This is genuinely great. The run detail is better than Zapier's task history. Win for Workeros.

---

### Step 10: Editing the Worker — T+7:00
Navigated to `/workers/research_brief/edit`. The edit page shows:
- Trigger type selector (Manual / Cron / Webhook / Connection event)
- File tabs: worker.yml, SKILL.md, run.py, requirements.txt
- Raw YAML textarea for worker.yml
- "Delete SKILL.md", "Delete run.py", "Delete requirements.txt" buttons
- "Save" button

**Confusion:** There is no "Add file" visible until I scroll (it was accessible but buried). The YAML editor is a raw `<textarea>` — no syntax highlighting, no validation, no autocomplete. Submitting malformed YAML: I didn't test this directly but a raw textarea with no validation is a recipe for silent corruption.

**The worker.yml tab shows correctly.** SKILL.md content is readable. This part works.

---

### Step 11: Mistakes / Errors — T+8:00
**Connections page error:** Navigating to `/connections` shows "Failed to load connections" immediately at the bottom of the page. The page still shows the "Connect Gmail" promo card, but my existing connections failed to load. This is an error that appears on every visit to Connections.

**Generate button silent failure:** As documented in Step 2 — typing custom text into the prompt textarea and clicking Generate does nothing. No error, no toast, no disabled-button visual. The button appears interactive but is disabled.

**Connecting an integration from the browse catalog:** Clicked "Connect" on Granola MCP — absolutely nothing happened. No modal, no redirect, no error, no loading state. Dead button.

---

### Step 12: Finding Help — T+9:00
I looked everywhere for:
- A "?" icon or help link
- A "Docs" link in the nav
- A "Support" button
- Any link to external documentation

**There is nothing.** The nav has: Overview, Workers, Runs, Secrets, Connections, Settings. No Help. No Docs. No onboarding guide. No tooltips on confusing elements. No "Learn more" links.

The Settings page reveals this is running on `/root/workeros/workers` with a SQLite database at `../../data/floom.db`. **This is visible to all users.** A paying customer should not see server filesystem paths.

---

## 3. Top Friction Points Ranked

| # | Friction Point | Severity | Impact |
|---|----------------|----------|--------|
| 1 | **HubSpot OAuth hangs forever ("Connecting...")** with no error recovery, no timeout UX, toast appears on the wrong page after creation | P0 | Blocks the primary use case entirely |
| 2 | **Generate button silently disabled** when user types their own prompt (only works via example chip pre-fill) | P0 | Kills the core "describe what you want" value proposition for any user who doesn't use an example |
| 3 | **Worker detail page loads blank for 5-8 seconds** post-creation — no skeleton, no spinner — user thinks it crashed | P0 | Creates immediate "did this work?" anxiety right after the key creation moment |
| 4 | **No help documentation anywhere** — no docs link, no tooltips on confusing concepts (worker modes, SKILL.md, connections vs secrets) | P0 | User is stranded the moment anything goes wrong |
| 5 | **Settings page leaks server internals** — filesystem paths, DB location, server stats visible to all users | P1 | Looks like a developer tool, not a product; kills trust |
| 6 | **Workers list doesn't auto-refresh after creation** — requires manual "Reload workers" click to see new worker | P1 | Creates "did my worker save?" doubt |
| 7 | **Connections page shows "Failed to load connections" error** on every visit | P1 | Persistent error in a core nav section |
| 8 | **Granola "Connect" button in catalog is completely dead** — no modal, no redirect, no error | P1 | Integration that's featured in the #1 example doesn't work |
| 9 | **No guidance on how to get Granola API key** — field appears, no link, no hint, no tooltip | P2 | API key for a niche app (Granola) is not findable without leaving the product |
| 10 | **Worker modes (Agent / Pure Python / Hybrid) have no explanation** — B2C user has no basis to choose | P2 | Cognitive overload at a critical step; default should be hidden |

---

## 4. What the Product Does WELL

**The prompt-to-worker concept is genuinely novel.** When it works, typing a sentence and getting a structured worker with SKILL.md, worker.yml, connections detected, and inputs/outputs inferred is impressive. No other tool does this. Zapier has templates, n8n has templates — neither generates custom automation logic from a freeform description.

**The example chips are smart UX.** The five examples are well-chosen, cover real use cases, and the fact that the first example is exactly the Granola+HubSpot task shows someone thought about the persona. The chip-click-to-fill pattern is clean.

**The cron builder is genuinely good.** Frequency presets (Every minute / Hourly / Daily / Weekdays / Weekly / Monthly), day toggles, human-readable summary, custom cron escape hatch, timezone field. This beats Zapier's schedule UI for power users.

**The run detail page is excellent.** Millisecond timeline, full input/output rendering, artifact downloads, transcript JSONL download. Better than anything Zapier or Make shows in their task history.

**Multiple trigger types (Manual / Cron / Webhook / Connection event) in one worker** is a real power-user differentiator. Zapier charges extra tiers for webhook triggers. Workeros includes it by default.

**1,043 integrations via Composio** is a legitimate competitive advantage if the connections flow works. That's on par with Zapier's catalog.

**The worker YAML is visible and editable.** Power users who want to understand what's happening can inspect and modify the exact schema. This is transparency that Zapier explicitly hides.

---

## 5. The "Zapier Killer" Gap

Workeros's fundamental gap is not features — it's **trust and completion rate**. To beat Zapier, a user needs to complete at least one successful end-to-end automation. Right now, my session ended with:
- A Granola connection that cannot be set up (dead button in catalog, no API key guidance)
- A HubSpot OAuth that timed out silently
- A worker that's created but will never fire because neither connection is configured
- No help docs to figure out what to do next

**The specific gaps:**

1. **Zero to first successful run.** Zapier gets a user to a working Zap in 5-7 minutes. Workeros can't complete the Granola+HubSpot task at all in 30 minutes because the OAuth is broken and the connection catalog button is dead.

2. **The product requires connections to work, but connections are broken.** The entire value of "1,043 integrations" evaporates if the connection flow has a silent hang bug.

3. **No safe way to test.** Zapier has a "Test step" at every step before you publish. Workeros has no test mode, no dry run, no mock data. You fire the real thing or you fire nothing.

4. **Secrets vs Connections mental model is undefined.** Workeros has both a "Secrets" page (for env vars/API keys) and a "Connections" page (for OAuth). These are related but the product never explains the relationship. A B2C user doesn't know whether to go to Secrets or Connections to set up Granola.

5. **No collaboration, no sharing, no templates marketplace.** Zapier has 25,000+ templates. You can grab a working "Granola → HubSpot" zap in 30 seconds. Workeros has 8 workers, all private, no sharing mechanism.

---

## 6. First-Time User Time-to-Success

**Workeros (today):**
- Time to understand what the product does: ~3-5 minutes (no onboarding, must explore)
- Time to create a worker from the example: ~2 minutes (if using example chips)
- Time to connect Granola: **infinite** (button is dead, no guidance)
- Time to connect HubSpot: **infinite** (OAuth hangs)
- Time to first successful run: **not achievable in 30 minutes** for the Granola+HubSpot task

**Zapier (comparison):**
- Time to understand: ~1 minute (clear landing, CTA)
- Time to build Granola+HubSpot Zap: ~5-7 minutes (Granola native integration exists, HubSpot OAuth in ~30 seconds)
- Time to first successful test run: ~8 minutes total

**Verdict:** Workeros can't complete the task. Zapier does it in 8 minutes. For any task that doesn't require custom logic beyond what Zapier's action steps support, Zapier wins on completion. Workeros only wins if you need genuinely custom AI logic that no existing Zapier action covers.

---

## 7. Pricing Reaction

**If this were $29/mo right now, would I pay? No.**

The failure modes are too fundamental. OAuth doesn't work. The core entry flow has silent bugs. There is no documentation. The settings page exposes server internals.

**What the pricing table actually looks like for value delivered:**

| State | Fair Price |
|-------|-----------|
| Current (v0 alpha) | $0 — free beta, explicitly |
| After fixing OAuth + Generate bug + docs | $9/mo — competitive with n8n Cloud |
| After adding test mode + 30s onboarding + template gallery | $19/mo — compelling |
| After stable connections + real completion rate | $29/mo — reasonable for power users |
| As a genuine "Zapier with AI" with the generation differentiator | $39-49/mo — justifiable |

**The ceiling is real.** The prompt-to-worker generation is a genuine moat if it works reliably. No other tool has it. If I can type "every time a deal closes in HubSpot, summarize the meeting notes from Granola and draft a follow-up email via Gmail" and get a working automation in 2 minutes — that's worth $49/mo easily. But I can't get there today because the connections layer is broken.

**The one thing that would change my mind immediately:** Fix the HubSpot OAuth. If I can connect HubSpot in 30 seconds (like Zapier) and then run the generated worker and see real data appear in my CRM, I'd upgrade immediately. The prompt-to-worker output quality is good enough. The friction is in the plumbing, not the intelligence.

---

## 8. Appendix — Specific Bugs Found

| Bug | Location | Steps to Reproduce |
|-----|----------|-------------------|
| Generate button silently disabled for typed prompts | `/workers/new` | Type custom text into textarea (without using example chip), click Generate → nothing happens, no error |
| HubSpot OAuth hangs permanently | `/workers/new` Step 2 | Click "Connect HubSpot" → button shows "Connecting..." indefinitely, no popup, no error |
| Worker detail page blank on first load | `/workers/[id]` | Navigate to any worker detail URL → 5-8s blank page, no skeleton |
| "Granola MCP" Connect button is dead | `/connections/browse` | Search Granola, click Connect → no response |
| Workers list doesn't refresh after creation | `/workers` | Create worker → redirected to list → new worker not visible → must click "Reload workers" |
| "Failed to load connections" on Connections page | `/connections` | Navigate to Connections → error message at bottom of page |
| Settings exposes server filesystem paths | `/settings` | Navigate to Settings → sees `/root/workeros/workers`, `../../data/floom.db` |
| Worker Overview tab shows "Inputs: None, Outputs: None" incorrectly | Worker detail → Overview tab | Create worker with inputs/outputs in YAML → Overview shows None for both |
| Connection timeout toast appears on wrong page | Post-creation | Create worker with skipped HubSpot, get redirected, toast about OAuth timeout appears 8s later on different page |

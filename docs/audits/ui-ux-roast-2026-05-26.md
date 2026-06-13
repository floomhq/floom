# Workeros UI/UX Roast — 2026-05-26

**Audited URL:** https://workers.floom.dev  
**Browser:** chrome-broker identity via self-hosted server broker  
**Viewport tested:** 1280px desktop (broker) + 375x812 mobile (Chrome DevTools emulation)  
**Auditor:** Claude Code agent, no mercy mode

---

## TL;DR

**Overall score: 58/100**

This is a functional internal tool with a clear design system direction, but it reads like a v0 prototype that shipped without a final polish pass. The bones are good — clean sidebar, consistent spacing, a green accent that doesn't feel random. The problems are load-state leaks, broken pages, a sprawling filter bar that overwhelms the workers list, a code editor that's just a file picker with a text area, and a run detail layout that buries the output in a 2-column split nobody asked for.

### Top 3 Wins

1. **Connections page** — best page in the app. Status badges (Active/Expired/Connecting), logos, structured metadata, clear action buttons. Looks like a real SaaS product.
2. **Run detail timeline** — timestamped log entries with `+Nms` deltas is genuinely useful and better than 90% of CI/CD tools. The color-coded failure line stands out correctly.
3. **Navigation sidebar** — simple, icon + label, active state clear, version + theme toggle at the bottom. Nothing to hate.

### Top 5 Things to Fix (immediately)

1. **P0: /connections/browse is broken** — "Loading integrations" never resolves. Shows "No integrations found" + "Page 1 of ..." forever. This is the marketplace. It is dead.
2. **P0: /workers/csv_enricher (and other workers) loads a skeleton that never resolves** — the broker session shows an indefinite loading state for worker detail pages. Whether this is a session-scoping issue or a race condition, it breaks the primary user journey.
3. **P0: Workers list filter bar is out of control** — the tag cloud renders ALL tags as pill buttons before the worker cards. On a fresh load you see 20+ tag buttons before you see a single worker. This is information architecture backwards.
4. **P1: Run detail is a two-column split with no sizing control** — Output fills the right side in a fixed div. Long markdown output has no way to expand. The timeline left column takes ~40% of width for logs nobody needs to read after a run succeeds.
5. **P1: Worker edit page has no syntax highlighting on the YAML/code editor** — It's a monospace textarea. This is a tool for editing agent code. No syntax highlighting, no line numbers, no error indicators. Competitors ship Monaco for this.

---

## Per-Page Findings

### 1. `/` — Overview

**Screenshot:** `screenshots-ui/01-homepage-desktop.png`, `01-homepage-mobile.png`

**First impression:** Looks like a stripped-down Vercel dashboard from 2021. Three stat cards + a recent runs list. Functional, not exciting.

**Issues:**

| # | Finding | Severity |
|---|---------|----------|
| 1 | Stat cards are massive whitespace boxes. "WORKERS: 8" fills a third of the page width with nothing else in it. The icon (box/clock/triangle) sits in the far corner doing nothing. These could be 1/4 the height and show more useful info — avg run time, success rate, last run timestamp. | P1 |
| 2 | "WORKERS", "RUNS TODAY", "FAILED" use ALL CAPS with no visual hierarchy between label and value. The number is bigger but the cap-label reads as equally important as the number. Use a proper label style (small, muted, uppercase tracking) like Linear does. | P1 |
| 3 | "Recent runs" section only shows worker name + trigger + timestamp + status. No link to the worker itself (only to the run). No run duration. No way to tell if "Research Brief" is a good or bad run without clicking in. At minimum show run duration next to the status badge. | P1 |
| 4 | "Export all runs" button in the top-right corner is a secondary action positioned like a primary CTA. It should be a text button or icon-button, not an outlined pill that visually competes with nothing else. | P2 |
| 5 | On mobile (375px), the three stat cards stack into full-width columns, each taking ~160px of height for 2 lines of text. Extremely wasteful on mobile. Should be 2-across grid or a compact table row. | P1 |

**What Linear/Vercel would do differently:** The stat row would be a compact top strip (not giant cards). Recent runs would show duration, have clickable worker names, and have a subtle empty-state illustration instead of just disappearing when empty.

---

### 2. `/workers` — Workers List

**Screenshot:** `screenshots-ui/02-workers-list-desktop.png`, `02-workers-list-mobile.png`

**First impression:** A wall of filter buttons, then cards. The filter system is trying to do too much.

**Issues:**

| # | Finding | Severity |
|---|---------|----------|
| 1 | The tag cloud renders ~20 tag pill buttons ABOVE the worker cards. On the populated view (desktop screenshot), the folder filter row + tag row together push the first worker card below the fold on a 1280px screen. For 8 workers. This is backwards — show workers first, filter controls second (or collapse tags into a dropdown). | P0 |
| 2 | Folder pills show "Operations/Data 1" with the count but the folder path prefix "Operations/" adds visual noise. Nobody needs the folder hierarchy repeated in every chip label. Show "Data (1)" or use a tree structure. | P1 |
| 3 | Worker cards have 3 action buttons: View, Edit (pencil icon), and Run. View is a text link, Edit is an icon-only button with no tooltip visible in screenshot, Run is a full "Run worker" button with a play icon. The visual weight is: low → unknown → high. But "Edit" is probably used as often as "Run" — give them equal treatment or use a kebab menu. | P1 |
| 4 | "healthy" badge on every worker card is styled as a faded green chip with no prominence. It reads as metadata noise, not a status indicator. If it's always healthy, hide it. If it can be "unhealthy" or "degraded", make the badge distinct enough to notice at a glance. | P2 |
| 5 | Usage stats ("Last run 4h ago · 17 runs in 7d · 65% success") are in light gray at the bottom of each card. 65% success rate is important information — it should not be styled the same as "Last run 4h ago". Success rate below 80% should show a different color. | P1 |
| 6 | "Reload workers" button in the header — this is a development artifact. Production users should not need to reload workers manually. If this exists because the list doesn't auto-refresh, that's a real problem. If it's for advanced users only, put it in Settings. | P1 |
| 7 | On mobile (375px), the folder + tag pill rows wrap into a chaotic mass before the cards. Completely unusable. This needs a collapse-by-default approach on mobile. | P1 |

---

### 3. `/workers/csv_enricher` — Worker Detail (tabs: Run / Code / Connections / Runs / Overview)

**Screenshots:** `screenshots-ui/03-worker-detail-desktop.png`, `03c-worker-detail-code-tab.png`, `03d-worker-detail-runs-tab.png`, `03-worker-detail-mobile.png`

**First impression (Run tab):** Clean, centred form. Surprisingly readable. The run form is the best UX on this page.

**Issues:**

| # | Finding | Severity |
|---|---------|----------|
| 1 | **Indefinite skeleton for /workers/csv_enricher** — this worker slug shows an indefinite loading skeleton after 5+ seconds in the broker session. The Run tab for /workers/research_brief loads fine. This suggests worker-specific data fetching is broken for some workers. No error state — just spinning skeleton forever. The user has no idea if it's loading, broken, or timed out. | P0 |
| 2 | The worker detail header has: back arrow, icon + name, subtitle, tags, AND an Edit button in the top-right corner. The tag chips (Research, research, brief, strategy, markdown) are duplicated — the folder "Research" and tag "research" appear as separate chips in the same row, identically styled. Deduplicate or visually distinguish folder vs. tag. | P1 |
| 3 | **Code tab — the file viewer is barely a code editor.** Left panel shows a file tree (worker.yml, SKILL.md, run.py, requirements.txt). Right panel shows raw text with no syntax highlighting, no line numbers. YAML and Python both get the same monospace-on-white treatment. For a product that lives and dies on SKILL.md and worker.yml quality, this is embarrassing. At minimum, use a `<pre>` with a highlight.js pass. Ideally, CodeMirror/Monaco. | P1 |
| 4 | **Connections tab** — not screenshotted in loaded state (broker session) but from the snapshot: the tab shows connections with their status. It's listed as a tab on worker detail, but connections are a global concept managed at /connections. Having a per-worker connections tab that just re-shows the connection list adds navigation confusion without clarity. Should show only the connections declared in worker.yml, greyed out if not connected. | P1 |
| 5 | **Runs tab** — lists recent runs as `run_5d0f919f4fba · 5/26/2026, 6:54:55 PM · completed`. The run ID is shown as the primary label. This is a raw database slug, not a human name. Show "completed · 4h ago" and let the ID be secondary/copyable. | P1 |
| 6 | On mobile (375px), the tab bar clips at the right edge: "Run Code Connections Runs Overvie..." — "Overview" is cut off. The tabs need either horizontal scroll or a dropdown. | P1 |
| 7 | The "Use sample input" button sits isolated between the last field and the Run button. It has a clipboard icon and no visual weight hierarchy relative to the primary Run CTA. It would work better as a small link under the last input field. | P2 |

---

### 4. `/workers/research_brief/edit` — Worker Edit (Multi-file)

**Screenshot:** `screenshots-ui/04-worker-edit-desktop.png`, `04-worker-edit-mobile.png`

**First impression:** Functional but dense. Feels like editing a config file in VS Code's worst early-access era.

**Issues:**

| # | Finding | Severity |
|---|---------|----------|
| 1 | The edit page has a left panel with Trigger, Type, and Files sections, and a right panel with raw file content. The trigger section shows Manual/Cron/Webhook/Connection event as a segmented control — good. But the "Cron" tab presumably opens a cron editor: cannot see if it's a cron builder or free-text. If it's free-text "0 9 * * 1", that's a user-hostile choice for an audience that likely doesn't know cron syntax. | P1 |
| 2 | No save confirmation or auto-save indicator. The "Save" button in the top-right is the only signal. No indication of unsaved changes (no dirty state indicator, no asterisk in the title). Edit something, look away, come back — you don't know if you saved. | P1 |
| 3 | No syntax highlighting on the YAML/Python code panels (same issue as Code tab). The worker.yml content is 100+ lines of dense YAML with nested fields. It's displayed as unstyled monospace. | P1 |
| 4 | File names in the left panel are listed as small text with a file icon. There's no indication of which file is currently active in the right panel — no highlighted/selected state on the file name. | P2 |
| 5 | On mobile (375px), the edit page collapses to a stacked layout: Trigger selector on top, file list below, then YAML content. It's actually workable for reading but the YAML code area is too narrow to meaningfully edit on mobile. This is acceptable since editing code on mobile is not a real use case, but the layout doesn't communicate "this is desktop-only". | P2 |
| 6 | "Edit worker" as the page title and "Research Brief" as the subtitle — the breadcrumb just shows "← Research Brief" as the back link. There's no breadcrumb trail: Overview > Workers > Research Brief > Edit. The back arrow alone is fine, but doesn't tell you which page you're editing FROM (are you coming from the Run tab? The list?). | P2 |

---

### 5. `/workers/new` — New Worker (Step 1)

**Screenshot:** `screenshots-ui/05-workers-new-desktop.png`

**First impression:** The cleanest page in the app. Prompt textarea with example suggestions is a good UX pattern. But the page has an identity crisis.

**Issues:**

| # | Finding | Severity |
|---|---------|----------|
| 1 | The page title is "New worker" with subtitle "Describe what you want to automate and we will draft the worker for you." — but the textarea label says "Describe what you want this worker to do" and there's also a file upload zone AND an "EXAMPLES" list. That's three different UI zones for the same action. The layout reads as three separate affordances rather than one funnel. | P1 |
| 2 | The file upload zone reads: "Drop a file here, or click to browse. .md (SKILL.md), .py (Python script), .zip (full bundle), or a folder. .md and .py files take you to Step 2 to fill in metadata. Zip or folder bundles are created directly." This is 4 sentences of instruction copy in a dropzone. Nobody reads dropzone copy. Shorten to: "Upload a SKILL.md, .py, .zip, or folder" with an expand-on-hover explanation. | P1 |
| 3 | "Browse a folder instead" is a small text link below the dropzone. This is not a minor alt path — folder uploads are how real workers get deployed. Give it equal visual weight. | P1 |
| 4 | The Generate button is full-width muted gray with "Generate →". It should be a primary blue/green CTA. Right now it reads as disabled. The keyboard shortcut "Press Cmd+Enter to generate" hint below it is good — but nobody will find it because they're looking for a primary button. | P1 |
| 5 | The examples list below is plain text links. Clicking one presumably fills the textarea — but there's no visual indicator that these are clickable shortcuts (no underline, no chevron, not even a subtle hover state in the screenshot). | P2 |
| 6 | Step 2 (after Generate or file upload) is not visible unless you perform an action. There's no "here's what happens next" preview — no progress indicator saying "Step 1 of 2". First-time users don't know what they're walking into. | P2 |

---

### 6. `/runs` — Runs List

**Screenshot:** `screenshots-ui/06-runs-desktop.png`

**First impression:** Empty state for the browser session. The empty state message is functional.

**Issues:**

| # | Finding | Severity |
|---|---------|----------|
| 1 | The empty state says: "No runs match these filters. Try clearing filters, or trigger a worker from the Workers page to create a new run." This is actually good microcopy. One of the better messages in the app. BUT it appears even when there ARE no filters applied ("All" workers, "All" status). The message is misleading — "try clearing filters" implies the user has filters set. | P1 |
| 2 | The status filter buttons (All / Queued / Running / Completed / Failed) use different visual treatments: "All" is a filled dark pill, "Queued/Running/Completed/Failed" are outlined. This is correct. But the "All workers" dropdown on the left uses a different visual design (border + chevron). Mixed filter UI patterns. | P1 |
| 3 | Loading state (first screenshot, before content resolves) shows skeleton rows but they have no animation — they're just static gray rectangles. Skeletons without shimmer animation look like blank boxes or broken content. | P1 |
| 4 | "History" as the section header for the runs list adds nothing. The page is already called "Runs". Remove it or rename it to something meaningful like "All executions" or just remove the inner card header entirely. | P2 |
| 5 | "Export CSV" button top-right is persistent even when there are no runs. This is a ghost affordance — pressing it would return an empty CSV. Disable it when the run list is empty. | P2 |

---

### 7. `/runs/<run-id>` — Run Detail

**Screenshots:** `screenshots-ui/07-run-detail-completed.png`, `07b-run-detail-failed.png`

**First impression (completed run):** Dense and information-rich. The timeline + output split is useful. The failure state shows clear error messaging. Strongest functional page in the app.

**Issues:**

| # | Finding | Severity |
|---|---------|----------|
| 1 | The two-column layout (Timeline left, Output right) has no resize control. On long output (like the research brief output which is 4+ paragraphs of rich markdown), the output div scrolls independently within the right panel. This creates two simultaneous scroll contexts on one page — confusing UX, especially on a laptop where the timeline is already fully visible but output requires scrolling. | P1 |
| 2 | The run ID (`run_5d0f919f4fba`) is the page title, with "Research Brief · 5/26/2026, 6:54:55 PM" as subtitle. The ID is the worst possible page title. Use "Research Brief — Run" as the H1, and put the ID in a copyable monospace chip below the title. | P1 |
| 3 | The "Filter logs..." search in the timeline panel is good. But it sits inside the timeline card with no visual affordance that it's interactive (no magnifier icon with sufficient contrast, no border on the input). Looks like placeholder text floating in space. | P2 |
| 4 | Artifacts section at the bottom shows "brief.md" and "transcript.json" as download links. Good. But the download button is a faint "Download" text link on gray background. For the primary deliverable of a run (the output artifact), this deserves a more prominent download button. | P1 |
| 5 | Failed run page (`run_835e33a1e67f`): the error reads "Run failed: Worker did not produce result.json: path '/home/user/worker/result.json' does not exist" in a red box. This is a raw Python error from the sandbox. Users should NOT see internal paths. Translate this to "Worker failed to produce output — check your run.py writes to result.json." | P0 |
| 6 | The "Raw error" link in the failed run output expands to show the full error. This is good. But the link is styled as `→ Raw error` with a right arrow — it reads more like "navigate away" than "expand inline". Use a chevron or `▼ Show raw error`. | P2 |

---

### 8. `/secrets` — Secrets

**Screenshot:** `screenshots-ui/08-secrets-desktop.png`

**First impression:** The emptiest page in the app, but at least it's honest about it.

**Issues:**

| # | Finding | Severity |
|---|---------|----------|
| 1 | Empty state: "No secrets configured. Add one above." — "above" refers to the "+ Add secret" button in the top-right corner. But in the visual layout, the button is top-right and "above" reads as spatial instruction (above this text). The instruction is confusing. Say "Use '+ Add secret' to add your first secret." | P1 |
| 2 | The informational box at the bottom: "Secret values are write-only; they are never returned by the API. Changes to `.env` take effect immediately without restarting workers." — the `.env` inline code chip looks fine but the prose is mixed between user-facing (".env") and developer-facing ("never returned by the API"). If this is a user-facing app, "never returned by the API" means nothing to the user. Say "Secret values are hidden after saving and cannot be viewed again." | P1 |
| 3 | Two separate white card sections for an empty page. The "Environment secrets" card and the info box below it are separated by a gap but both are inside the same content area. This two-card layout suggests there should be more sections (maybe "Platform secrets" vs "User secrets") but there aren't. | P2 |
| 4 | No empty state illustration or icon. Vercel's Secrets page has a lock icon + "No secrets yet" + "Add your first secret to get started" with clear CTA in the center. Workeros has a white box with one line of muted text. | P2 |

---

### 9. `/connections` — Connections (Active)

**Screenshot:** `screenshots-ui/09-connections-desktop.png`, `09-connections-mobile.png`

**First impression:** Best page in the app. Clear status badges, service logos (Gmail M, Drive triangle, HubSpot sprocket, LinkedIn in), clean action buttons.

**Issues:**

| # | Finding | Severity |
|---|---------|----------|
| 1 | "Google Drive — Expired" — the Expired badge is orange-red (correct for urgency) but the connection still shows Reconnect/Test/Disconnect buttons in the same layout as Active connections. There's no visual weighting difference. An expired connection should have "Reconnect" as a prominent primary button (not an outlined secondary), and "Test" should be hidden since it can't work. | P1 |
| 2 | "HubSpot — Connecting" — the yellow "Connecting" badge is mid-state. What does "Connecting" mean? Is this a pending OAuth that the user needs to complete? Is it auto-retrying? There's no guidance. If the user needs to do something, tell them. If it's auto, show a spinner. | P1 |
| 3 | "Last used Never" appears on all 4 connections. This is likely accurate (new account), but for real users it's meaningless noise that clutters the metadata line. Either show "Last used: [date]" only when there's actual data, or replace "Never" with "Not yet used" for clarity. | P2 |
| 4 | "Default scopes" appears under each connection with no expansion. What are the scopes? Users should be able to see what permissions they've granted. This is a one-line affordance that hides important information. | P2 |
| 5 | On mobile (375px), each connection card has Reconnect/Test/Disconnect buttons stacked vertically to the right of the service name. It works but the action buttons are quite large and take up most of the card width. The "Disconnect" button in red is prominent — on mobile where accidental taps happen, this should have a confirmation step. | P1 |
| 6 | The informational box at the bottom: "Connections use OAuth. Workers that declare a connection in their `worker.yml` list it as part of their declared capabilities. Workers that read it will see an error from the upstream API if the connection isn't valid." — This is developer copy, not user copy. Rewrite: "Connected apps are available to workers that request them. If a connection expires, the worker will fail with an auth error." | P1 |

---

### 10. `/connections/browse` — Integration Marketplace

**Screenshot:** `screenshots-ui/10-connections-browse-desktop.png`

**First impression:** Broken. This is the worst-state page in the app.

**Issues:**

| # | Finding | Severity |
|---|---------|----------|
| 1 | **Page never loads integrations.** After 8+ seconds, the right side shows "No integrations found. Clear filters or try a broader search." while the top-right corner shows "Loading integrations" — a persistent loading indicator that never resolves. The pagination shows "Page 1 of ..." with the ellipsis never resolving. This is a P0 production bug, not a design issue. | P0 |
| 2 | The "No integrations found" empty state message assumes the user has active filters — "Clear filters or try a broader search" — but the "All" filter is selected and the search box is empty. The empty state is factually wrong and confusing during the loading failure. | P0 |
| 3 | "Loading integrations" is top-right corner plain text with no spinner. If this is a persistent loading indicator, it needs a spinner/animation. If it's a status message, it needs to resolve to "1043 integrations" once loaded. As-is it's a ghost message. | P1 |
| 4 | Category filter pills: All / Popular / Productivity / Email / CRM / Social / Marketing / Data / Collaboration — the "All" button is styled with the same filled dark treatment as the active status button on the Runs page. Consistent, good. But the pills overflow horizontally and need to scroll (or wrap) on smaller screens. | P2 |
| 5 | "Browse integrations" as the page title with subtitle "Search the full integration catalog and connect any of 1000+ apps for your workers." — the copy says 1000+ but the loading counter says 1043. Use the real number in the subtitle. | P2 |

---

### 11. `/settings` — Settings

**Screenshot:** `screenshots-ui/11-settings-desktop.png`, `11-settings-mobile.png`

**First impression:** Looks like a Django admin panel from 2018. Dense, form-heavy, but at least everything is findable.

**Issues:**

| # | Finding | Severity |
|---|---------|----------|
| 1 | Infrastructure paths are shown with their actual server filesystem paths: `/root/workeros/workers`, `../../data/floom.db`, `/root/workeros/data/artifacts`. These are absolute paths to server internals. Showing `/root/` paths in a production UI is a data exposure issue — confirms the app runs as root, reveals directory structure. At minimum, mask these or show only relative paths. | P0 |
| 2 | "Required secrets" section lists OPENAI_API_KEY, E2B_API_KEY, COMPOSIO_API_KEY, COMPOSIO_WEBHOOK_SIGNING_KEY, FLOOM_SECRET, WORKERS_FRONTEND_URL — all as small key-value rows with a "set" button. The "set" button has no state indicator (is it set? not set?). A green checkmark or red X next to each would communicate status instantly without clicking. | P1 |
| 3 | "Infrastructure paths" section shows FLOOM_DB, FLOOM_WORKERS_DIR, FLOOM_ARTIFACTS_DIR, FLOOM_RUN_TIMEOUT as editable fields with "set" buttons. FLOOM_RUN_TIMEOUT shows "optional, default: 300" as gray text. This is the only field with a default shown inline. Inconsistent — show defaults for all optional fields. | P2 |
| 4 | "Danger Zone" section at the bottom has "Clear run history" with a red "Clear runs" button and text "Deletes all runs, logs, artifacts, and approvals. Cannot be undone." — the section header "Danger Zone" is red text on white background, no border, no box. Compare to GitHub's Danger Zone: red bordered box with clear visual separation. Workeros's version looks like an afterthought. | P1 |
| 5 | "Workers" section contains a single "Reload workers" button with text "Reload workers from disk to pick up config changes." — this is a development action in the production settings page. Either move to a dev-only section or at minimum explain what "reload from disk" means in user language. | P2 |
| 6 | On mobile (375px), the settings page is actually functional — one column, readable. The long filesystem paths overflow their containers slightly but the overall structure holds. The "set" buttons are accessible. This is the one page that doesn't break badly on mobile. | P2 |

---

## Cross-Cutting Themes

### 1. Loading states are inconsistent and leaky
Three patterns in use: (a) skeleton rectangles with no animation on /runs, (b) persistent "Loading integrations" text with no spinner on /connections/browse, (c) indefinite skeleton with no timeout on /workers/csv_enricher. None of these follow a unified loading state pattern. Users get no feedback about whether they should wait or reload. Every page needs: skeleton (max 2s) → real content OR error state with retry. Never a permanent skeleton.

### 2. Developer internals surface in the user UI
Raw server paths (`/root/workeros/`, `/home/user/worker/result.json`), raw run IDs as page titles, raw Python error messages as user-facing errors. This is an internal tool that hasn't been sanitized for a non-developer audience. Every raw technical value should have a user-facing alternative.

### 3. Tag taxonomy is doing too much work
Tags, folder paths, and status badges are all present on worker cards. There are 20+ tags rendered as pill buttons in the filter bar. The tagging system needs curation — either limit tags to 5-8 meaningful categories or convert to a proper faceted search (Algolia-style). The current implementation is a raw data dump of whatever tags someone typed into YAML.

### 4. Microcopy mixes audiences
Some copy is for developers ("never returned by the API", "Changes to `.env`", "worker.yml declared capabilities"), some for operators ("Set these as environment variables on the server"), some for end users ("What is running and what needs attention"). There's no consistent voice. Pick one audience (operator/non-developer) and rewrite all copy for them.

### 5. No inline validation anywhere
Worker run forms (Research topic, Audience, Depth) have required field markers (red asterisk) but no inline validation. Submit with empty "Research topic" — nothing happens until backend error. Validate on blur, show error inline. Standard HTML5 `required` + `pattern` would fix 80% of this.

### 6. Empty states are orphans
Several pages have empty states (Secrets, Runs, Connections/Browse broken state) that don't connect to the next action with a clear visual hierarchy. Vercel's empty states have: illustration + message + primary CTA button centered in the empty zone. Workeros has: one line of muted text, sometimes with "Add one above" as spatial instruction.

---

## The Bar Gap

- **vs. Linear:** Linear's project cards have 3-line summaries, assignee avatars, status chips, priority indicators, and subtle hover states all in a dense but breathable layout. Workeros worker cards have the right structure but no visual hierarchy within the card — everything is the same gray text weight.
- **vs. Vercel:** Vercel's deployment detail page has a two-column layout (logs left, preview right) with a draggable splitter. Workeros run detail has the same two-column concept but with fixed widths, no splitter, and no way to focus either panel.
- **vs. Zapier:** Zapier's integration marketplace loads 100 apps in ~800ms with logo tiles, categories, and search. Workeros's marketplace is broken and never loads.
- **vs. Notion:** Notion's settings page organizes 30+ options into clear sections with icons, hover states, and instant feedback on changes. Workeros settings is a plain HTML-adjacent form with no feedback mechanism.

---

## Top 10 Fixes Ranked by ROI

| Rank | Fix | Impact | Effort |
|------|-----|--------|--------|
| 1 | **Fix /connections/browse — integrations never load** | Unblocks the marketplace entirely. Core feature. | Low (API/auth bug) |
| 2 | **Fix indefinite loading skeleton on some worker detail pages** | Users can't view/run workers. Primary journey broken. | Low-Medium |
| 3 | **Collapse tag filter bar behind a "Filter by tag" dropdown** | Removes 80% of visual noise from the workers list. Workers appear above the fold. | Low |
| 4 | **Add syntax highlighting to Code tab and Edit page** | Transforms the code view from "text dump" to "tool". highlight.js is one import. | Low |
| 5 | **Mask filesystem paths in Settings and error messages** | Removes `/root/` from user-facing UI. Security hygiene + professionalism. | Low |
| 6 | **Add dirty-state indicator + save confirmation to Edit page** | Prevents data loss. "Unsaved changes" indicator is table stakes for any editor. | Low |
| 7 | **Rewrite empty states with centered CTA buttons** | Secrets/Runs/Browse empty states feel like app crashes. Add illustration + primary CTA. | Low-Medium |
| 8 | **Add shimmer animation to skeleton loaders** | Turns static gray boxes into clear "loading" signal. 3 lines of CSS. | Very Low |
| 9 | **Fix run detail page title — replace run ID with worker name** | "run_5d0f919f4fba" as H1 is never correct. "Research Brief — Run" is always right. | Very Low |
| 10 | **Add inline validation to run forms** | Validate required fields on blur. Prevents silent submit-nothing UX. | Low |

---

*Screenshots saved to: `/root/workeros/docs/audits/screenshots-ui/`*  
*Audit conducted: 2026-05-26 via self-hosted server browser broker (chrome-broker identity)*

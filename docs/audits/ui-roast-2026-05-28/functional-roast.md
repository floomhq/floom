# Functional + Interaction Roast — workers.floom.dev

Walk date: 2026-05-27T08:14Z–08:30Z
Agent context: fresh, no implementation memory.
Walk type: click-driven, broker-driven, single-user v0 (x-floom-secret auto-injected by Vercel proxy).
Browser: self-hosted server broker pool-f, headless Chromium.

## TL;DR
- **Functional grade: C+** — Most navigation surfaces work and URL state is mostly synced, BUT there are systemic regressions in the create flow, a confused theme control, and pervasive dual `<a>+<button>` duplication that creates accessibility noise and inconsistent click targets.
- **Number of dead clicks / broken flows surfaced: 9**
- **Top 3 fixes (do these first):**
  1. **`/workers/new` Generate button regression.** Clicking an example pill fills the textarea but the Generate button stays disabled because React state never updates from the synthetic input write. Even after manual keystroke and click, the POST fails with a bare `Failed to fetch` toast. Worst-case: a brand-new user cannot create a worker on first try.
  2. **Eliminate the dual `<a>` + `<button>` pattern on every CTA** (`New worker`, `See all`, `Run worker`, `Edit worker`, `Edit`, `Download all`, `Configure`). Every "primary action" renders TWICE in the DOM — once as a link, once as a button — both pointing to the same destination. Doubles screen-reader output, breaks Tab counts, and creates two click hotspots stacked on top of each other.
  3. **Filter / search / pagination state lives in component state, not URL.** `/runs` status filter (`Failed`), workers tab search query (`?q=cv`), connections browse search and pagination (`?page=2`), and Run-detail tabs (`Run` vs `Transcript`) all reset on reload. Users cannot share a filtered URL. This will become a real complaint as run history grows.

## P0 — broken

### P0.1 `/workers/new` example pills do not enable Generate
- **Click:** any pill (tested `GitHub PR digest 9am`).
- **Expected:** textarea populates with sample prompt AND Generate becomes enabled (the pill is a single-click "fill + ready" affordance).
- **Observed:** textarea fills, but Generate stays `disabled` (Playwright wait failed: "element is not enabled" for 10s after multiple polls). React onChange / form-state is not firing on programmatic value write. The user is left looking at a filled textarea with a greyed-out CTA.
- **Workaround:** focus textarea → type one extra character → Generate enables.
- **Severity:** P0. This is the very first thing a new user clicks on the empty state. Blocking.
- **Evidence:** see `01-workers-new-failed-to-fetch.png` (post-keystroke state showing "Failed to fetch" toast).

### P0.2 `Generate` POST fails with bare "Failed to fetch"
- **Click:** Generate (after the textarea is populated by a pill and a manual keystroke unblocks the button).
- **Expected:** progress UI ("generating worker bundle...") OR a structured error like "OpenAI rate-limited, retry in 30s".
- **Observed:** appended a tiny "Failed to fetch" string at the bottom of the page. No toast severity, no retry button, no link to logs, no explanation.
- **Severity:** P0. The single-most-important user action returns the worst error string in software ("Failed to fetch"). This must be wrapped: distinguish network error, auth error, upstream LLM error.

### P0.3 `Settings > Danger zone > Clear runs` has NO type-to-confirm
- **Path:** `/settings?tab=danger`.
- **Expected per the brief:** "type the confirmation, click — DO NOT actually clear runs."
- **Observed:** there is NO confirmation input. The "Clear runs" button is enabled on first render. The Worker > Overview > Delete worker flow correctly has a "Type Research Brief to confirm" input; the parallel feature for clearing ALL runs has no such guard. Clicking `Clear runs` is one click away from wiping every run history. (I did not click it.)
- **Severity:** P0. Single-click irreversible destructive action with no double-check.

## P1 — confusing

### P1.1 Two theme controls, both labelled "Light", neither updates the other
- The page header and the Appearance section each render a theme toggle. Both are cycle-style buttons whose label always shows the CURRENT theme. Clicking either flips Light → Dark → System, but the OTHER button's label does NOT live-update — you have to navigate away and back to see the synced label. With both visible at once, the user sees one button say "Light" and the other say "Dark" simultaneously.
- Compounding issue: clicking the body "Light" button while in Light mode flips to Dark — but the label still reads "Light" in the snapshot, suggesting the label lags the action. ("Click Light to switch away from Light" is also non-obvious.)
- **Fix:** remove the duplicate. Header switcher OR Appearance section. Not both. Make the active state explicit (3-pill segmented control: `[Light][Dark][System]`).

### P1.2 Run detail tabs (`Run` / `Transcript`) lose state on reload
- URL is `/runs/<id>` regardless of which tab is active. Reloading on Transcript reverts to Run. Users cannot deep-link or paste a "look at the transcript on this run" URL to a collaborator.

### P1.3 Failed runs are missing the `Transcript` tab
- On `run_4f661958b88e` (completed) → two tabs: Run, Transcript.
- On `run_59f3013d9468` (failed) → one tab: Run only.
- This is the exact opposite of what users need: when something fails, the FIRST place to look is the agent transcript. Removing it on failures forces the user to re-run and hope it succeeds.

### P1.4 Worker detail > Connections > "Configure" routes to `/settings`, not `/secrets`
- On worker detail `?section=connections`, the "Required secrets: OPENAI_API_KEY" card has a `Configure` link (and its dupe button). The `<a>` href is `/settings` — which has no UI for managing secrets. Secrets live at `/secrets`. The link is wrong by one path segment.

### P1.5 Search input filtering does NOT sync to URL
- `/workers` (`?q=cv`), `/connections/browse` (`?q=notion`), `/runs` (`?status=failed`), `/connections/browse` (`?page=2`) — none of these sync. Reloading flushes any narrowed view back to "all".

### P1.6 Tag pill on a worker card silently fills the search input
- Clicking the `research` tag on Research Brief card populates the search box with `research` and filters the list. There is no visible "filtered by tag" pill, no clear-tag button beyond clearing the input. New users will be confused why typing `research` is the same as clicking the tag (it isn't if tags are multi-select capable — and right now they're not even multi-select).

### P1.7 Connect on a catalog integration silently opens a new browser tab
- `/connections/browse` → click `Connect` on Notion. Expected (per brief): a pre-confirm page at `/connections/connect/notion`. Observed: a NEW TAB opens to `notion.so/login` immediately. No toast, no "Continue in new tab" indicator on the original page. The brief's pre-confirm-with-Cancel UX doesn't exist.

### P1.8 Catalog does not flag already-connected providers
- `/connections/browse` lists Gmail, Google Calendar, LinkedIn, etc. as Connect targets even though they are already active on `/connections`. There's no "Already connected" badge or "Add another account" CTA. This is how the user ended up with TWO Google Calendar entries (`…849fe7`, `…829218`) — they probably hit Connect twice without realizing the first one already succeeded.

### P1.9 Secrets "Add secret" form has unlabeled inputs
- `/secrets > Add secret` reveals an inline form with two inputs (name, value as password). Neither has a visible label, placeholder, or aria-label. Screen-reader users can't tell which is the key and which is the value. Sighted users have to guess by position.

## P2 — polish

### P2.1 Every primary CTA renders as both `<a>` and `<button>` simultaneously
- Observed on: `New worker` (Overview + Workers list + Workers list new), `See all` (Overview), `Run worker` (Workers list — every card, plus Worker detail Run tab), `Edit worker` (Run detail), `Edit` (Worker detail header), `Download all` (Run detail), `Configure` (Worker > Connections).
- Both elements are visible in DOM, both fire the same navigation. The button likely overlays the link visually so users see one control, but screen readers will announce both, and `Tab` will need two presses to skip past. Pick one (`<a>` for navigation, `<button>` only for in-place state changes) and delete the other.

### P2.2 Stat cards on Overview are not clickable
- `RUNS 24H`, `SUCCESS 7D`, `ACTIVE WORKERS`, `CONNECTIONS 2/5` look exactly like cards / buttons, but clicking them does nothing. Expected: click `RUNS 24H` → `/runs?range=24h`; click `CONNECTIONS 2/5` → `/connections`. Either make them links or remove the affordance (no hover state, no card shadow).

### P2.3 Worker card body click does nothing
- Only the "Run worker" CTA on a worker card is clickable. The bulk of the card (title, description, tags, "Last run", success %) is dead pixels. To get to a worker's detail page the user must click "Run worker" — whose verb implies "I want to TRIGGER a run", not "I want to OPEN the worker page". This causes a learned hesitation: "I clicked Run worker, is it already running?"

### P2.4 Run-list rows duplicate the run ID
- On `/workers/<id>?section=runs`, each row shows `run_62b67fe35ea5` as BOTH the title AND the subtitle. Pick one: short label as title, full ID as subtitle, OR full ID as title with a short label (input topic? duration?) as subtitle.

### P2.5 Run-list row content is sparse
- The row shows: worker name, run ID, timestamp, status. It does NOT show: input snippet (would let users distinguish runs at a glance), duration, output preview. Compare to GitHub Actions runs which lead with branch + commit message + duration.

### P2.6 "Re-run" silently creates a new run without confirming inputs
- On `/runs/<id>`, clicking `Re-run` immediately enqueues a new run with the exact same inputs as the original. No "Edit inputs first?" affordance, no toast saying "Re-running with the same inputs". Combined with the fact that the previous failed run's inputs are visible above the button, this is fine ergonomically, but a new user could accidentally double-run the same prompt with no warning.

### P2.7 No pagination control on `/runs`
- `/runs` returned 17 rows for All / 7 for Failed. Once history grows past ~50 runs this list will be unmanageable. There's `Export CSV` but no "Show more / page 2" within the UI.

### P2.8 "Worker requires no integrations" sits next to "Required secrets: OPENAI_API_KEY"
- Internally consistent (integrations ≠ secrets) but reads as a contradiction to a user. Re-word: "This worker doesn't use any OAuth connections. It requires the following secrets:". Or merge the two sections into "Dependencies".

### P2.9 Recent runs heading mismatches list content
- `/workers` "Recent" tab shows a flat list of last 2 worker cards, but the Overview's "Recent runs" panel and the Workers > All folder grid both call this concept "recent" with different scopes (recent runs vs recent worker activity). Three nearby surfaces use "recent" to mean three different things.

### P2.10 "Needs attention" alert pill shows duplicated provider names
- Overview alert: "3 connections need re-authorization · googlecalendar, googlecalendar, googledrive". The duplicate `googlecalendar` is correct under the hood (there are two separate Google Calendar OAuth tokens) but reads as a typo to a user.

### P2.11 Anonymous (unnamed) buttons in Run detail header
- The element snapshot shows `{tag: button, name: ""}` next to "Copy run ID". Likely a status icon (completed/failed icon) without aria-label. Screen readers will announce "button". Add `aria-label="Run status: completed"`.

### P2.12 Status row buttons on `/runs` are not announced as tabs
- `All / Queued / Running / Completed / Failed` are plain `<button>` elements with no `role="tab"` (unlike `/workers` tabs). They function like tabs but don't announce as such. Either upgrade them to `role="tab"` + `aria-selected` or visually distinguish them from real tabs elsewhere in the app.

## Per-page detail

### `/` (Overview)
- Click `New worker` button → navigates to `/workers/new`. (Both `<a>` and `<button>` work; redundant.) OK.
- Click `See all` → `/runs`. OK.
- Click `Recent runs > Research Brief 2h ago` → `/runs/run_4f661958b88e`. OK. Entire row is a single `<a>`.
- Click `RUNS 24H` stat card → URL unchanged. Dead pixel. Should be a link to `/runs?range=24h`.
- Click `SUCCESS 7D` stat card → URL unchanged. Dead. Should at least open a help tooltip explaining the metric.
- Click `ACTIVE WORKERS 7` → URL unchanged. Dead. Should go to `/workers`.
- Click `CONNECTIONS 2 / 5` → URL unchanged. Dead. Should go to `/connections`.
- Click the "Needs attention: 3 connections need re-authorization" alert → `/connections`. OK.
- Click the "Worker keeps failing" alert → `/workers/research_brief`. OK and helpful — deep-links to the actual failing worker.
- Scheduled today: `GitHub Digest Sender Cron · 0 9 * * * · 11:00 AM in 3h`. Time display is "in 3h" — that's nice but the cron expression `0 9 * * *` shouldn't be exposed to non-technical users in the SAME pill. Pick one.

### `/workers`
- `All` / `Starred` / `Recent` tabs work, URL syncs `?tab=starred` / `?tab=recent`. OK.
- Search box (top-right) filters client-side as you type. NO URL sync (`?q=cv` does not appear).
- Folder cards drill in: click `Operations` → `?folder=Operations`. Sub-folders appear. Click `Reporting` → `?folder=Operations%2FReporting`. Click `Workers` breadcrumb → returns to root. OK.
- Tag button on a card (`research`, `brief`, `strategy`) populates the search field. No URL sync, no "filtered by tag" pill.
- Star toggle works and persists across reload (verified). Tooltip text updates `Add to favourites` ↔ `Remove from favourites`. OK.
- Card body click → no navigation (P2.3).
- 7th worker (`github-digest`) has no tag chips and no `Last run` / success-rate stats — it's a Cron-only worker that hasn't run yet. Card layout breaks visual rhythm with other 7 cards.

### `/workers/new`
- Textarea is centered. 5 example pills below.
- Click a pill → textarea fills BUT Generate stays disabled (**P0.1**). Manual keystroke unblocks it. Click Generate → "Failed to fetch" string appears (**P0.2**), no toast, no progress.
- `Upload .md / .py / .zip` button visible. Did not test file upload (broker doesn't have a trivial file path; would have needed a fixture).

### `/workers/<id>` (worker detail, e.g., `research_brief`)
- Side nav has 6 buttons: `Run`, `Code`, `Triggers`, `Connections`, `Runs (10)`, `Overview`.
- Each updates URL `?section=<name>` and swaps content. OK.
- `Run` form has Research topic (text), Audience (combobox: executive/technical/sales), Depth (combobox: overview/detailed/deep_dive). "Use sample input" populates all three and shows a toast "Sample input applied". OK.
- `Code` shows file tabs (worker.yml, SKILL.md, run.py, requirements.txt) with read-only file contents. Markdown is rendered (good).
- `Triggers` lets you pick Manual/Cron/Webhook/Connection event. Cron sub-form is feature-rich (frequency presets, hour/minute combo, weekday toggles, timezone). Discard button works.
- `Connections` shows "This worker requires no integrations" + "Required secrets: OPENAI_API_KEY" with `Configure` link → **WRONG ROUTE** (`/settings` instead of `/secrets`). (**P1.4**)
- `Runs` shows the worker's run history with each row a clickable link to the run detail. Each row duplicates the run ID (**P2.4**).
- `Overview` shows worker metadata, sample I/O, and a "Danger zone" with type-to-confirm input + Delete worker button (disabled until exact name match). I verified the button STAYS disabled with empty input, with wrong text, and becomes enabled with the exact name. I did NOT click final delete.
- Anonymous button (no label) at index 15 in the header bar — likely the status icon. (**P2.11**)

### `/runs/<id>`
- Header: worker name, run ID, timestamp, status badge, action buttons.
- Tabs: `Run`, `Transcript` (on completed) or `Run` only (on failed) — **P1.3**.
- Action buttons: `Edit worker`, `Re-run`, `Download all`, plus `Cancel run` if status is `running`.
- Re-run created `run_62b67fe35ea5` (status: running with Cancel-run visible). Live progress timeline updates ("Agent iteration 1, 2, 3..."). Good UX.
- Failed run (`run_59f3013d9468`): shows clear schema-violation error in the timeline + "Raw error" toggle reveals `Output schema violation: Missing declared output 'brief'`. Error reporting is solid; missing only the Transcript tab.
- Tab does NOT sync URL (**P1.2**).

### `/runs`
- Header: title + `Export CSV` button.
- Filter chips: `All workers` combobox + `All / Queued / Running / Completed / Failed`.
- Filter chips are plain `<button>`, not `role="tab"` (**P2.12**).
- Click `Failed` → list filters. URL unchanged. Reload restores `All` view. (**P1.5**)
- Rows are full-width `<a>` to `/runs/<id>` — entire row is the click target. Good.
- No pagination control (**P2.7**).

### `/settings`
- 5 tabs as `role="tab"`: `API access`, `System`, `Notifications`, `Appearance`, `Danger zone`. URL syncs `?tab=<name>`. OK.
- `API access`: token masked with prefix/suffix only. `Reveal` shows full token in plain DOM text. `Copy` works (assumed). `Hide` works.
- Setup commands: CLI / MCP / API tabs (nested `role="tab"`). CLI shows `npm i -g @floomhq/workeros · floom login`. OK.
- `Appearance`: shows a single "Light" cycle button. Header has another "Light" cycle button. Clicking either flips theme but the other doesn't visually update. (**P1.1**)
- `Danger zone`: `Clear runs` button is enabled on render. NO type-to-confirm. Single click away from wiping everything. (**P0.3**)

### `/connections`
- Active: Gmail, LinkedIn. Expired: Google Calendar (x2), Google Drive.
- Each row has Reconnect / Test / Disconnect / Refresh status buttons. (Did not invoke any.)
- Two Google Calendar entries with different account IDs — confusing but technically correct (**P1.8** root cause).
- "Connect a tool" link → `/connections/browse`. OK.

### `/connections/browse`
- Catalog: 1043 integrations across 35 pages, 30/page. Categories pill bar (All/Popular/Productivity/Email/CRM/Social/Marketing/Data/Collaboration).
- Search filters client-side. NO URL sync.
- Pagination buttons work. NO URL sync (**P1.5**).
- Click `Connect` on Notion → new tab opens to `notion.so/login`. No pre-confirm page, no on-page feedback (**P1.7**).
- Already-connected providers (Gmail, LinkedIn, Google Calendar) still show "Connect" with no "Already connected" badge (**P1.8**).

### `/secrets`
- Empty state. `Add secret` button → reveals inline form with TWO unlabeled inputs + Save + an anonymous (X?) button. (**P1.9**)
- Empty state copy is fine: "Workers that call external APIs require secrets. Add them here and reference them in your worker YAML."
- But the worker detail says "Required secrets: OPENAI_API_KEY" and `/secrets` is empty — UX inconsistency. Is it env-injected on the server? If so, surface that on the worker page instead of telling the user to "Configure" it. (**P1.4** corollary)

## Keyboard navigation (smoke only)
- Tabbed twice from Overview, pressed Enter → URL did not change. Focus indicator was not visible in headless snapshots. Did not exhaustively test. Worth a sighted pass.
- Escape on no-modal: no-op (correct).

## Constraints respected
- Did NOT delete any worker (verified Delete worker is disabled with empty input; did not click final).
- Did NOT clear runs (Danger zone Clear runs button NOT clicked).
- Created 1 new run (`Re-run` on `run_4f661958b88e` → `run_62b67fe35ea5`). 0 from `/workers/new` (the only path that hit `Failed to fetch`).
- Did NOT complete OAuth — Notion login tab opened but I did not enter credentials. Lease released, tab closes with the session.

## Test environment
- Walked through self-hosted server Browser Broker (`pool-f`, headless Chromium).
- Real `x-floom-secret` proxied transparently by Vercel.
- Lease `02ac4aa0-a3d3-44a9-ba8e-04d3aba882b2` opened 08:14Z, released 08:30Z. No leftover state on the server.

## What I did NOT exercise (gaps for next pass)
- File upload (`Upload .md / .py / .zip` on `/workers/new`).
- Webhook trigger configuration (the secret-token reveal flow).
- Notifications tab inside `/settings`.
- Secrets > Save flow (would require entering a value).
- Connections > Reconnect / Test / Disconnect actions on expired tokens.
- Worker > Edit page (`/workers/<id>/edit`). Brief mentioned but I only verified the link existed; did not open the full editor.
- Mobile/responsive layout — broker is desktop-default.
- Light → Dark visual contrast across pages (only smoke-tested the toggle).

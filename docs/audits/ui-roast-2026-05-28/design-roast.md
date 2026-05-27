# Design + Visual Roast — workers.floom.dev (Claude virgin agent)

Walk date: 2026-05-28T00:25:00Z
Agent context: fresh, no implementation memory, browsed every requested page in light + dark at 1280×800 desktop and 375×812 mobile.

## TL;DR

**Overall design grade: C+**

The app has a deliberate, calm visual language. It is not screaming AI slop. The sidebar, status colours, the spark chart, and the markdown rendering on the run output all show care. But it is currently held back by two classes of bug — one is a **P0 invisible button on the OAuth consent screen** that breaks the primary "connect a tool" flow on first impression, and the other is a **systematic mobile information-density disaster on every detail page** that crushes the main content into a half-column.

The app's worst sin is on the page a first user is *most likely to hit second*: `/connections/connect/googlecalendar`. The big "Connect to Google Calendar" CTA renders as a featureless black bar in light mode (text colour fights background). That is the page that decides whether they ever trust this product, and right now it looks broken.

The second-worst is `/workers/research_brief` returning **"Worker not found"** + a red `Failed to fetch` toast on initial navigation from the workers list. It then quietly resolves on reload. A new user does not reload — they leave.

The third sin is that the design system does not pick a side: card backgrounds, surface elevation, and section dividers are inconsistent across `/workers`, `/runs`, `/connections`, `/settings`. Same primitive — a "panel" — is rendered with at least three different border/shadow treatments. Cumulative effect: looks like 5 designers built 5 pages and never met.

### Top 3 things to fix this week
1. **The OAuth consent CTA renders as an unlabelled black bar in light mode.** Fix `/connections/connect/<provider>` "Connect to X" button colours so the label is visible. This is the gate to every integration; ship a hotfix today. (`08-connections-connect-googlecal-desktop-light.png`).
2. **Worker-detail race condition: initial nav shows "Worker not found" + a red `Failed to fetch` toast before the API returns.** Either suspend until the worker query resolves, or render a skeleton instead of the empty-state. Currently the prettiest worker page looks broken for the first ~500ms. (`03-worker-detail-desktop-light.png` initial state).
3. **Mobile detail pages are unusable.** On `/workers/<id>` mobile, the sub-nav (Run/Code/Triggers/...) renders as a fixed ~140px-wide vertical column, crushing the main content into the remaining ~230px. The H1 "Research Brief" wraps two lines on a 375px viewport because of it. Switch sub-nav to a horizontal scroll-pill row, segmented control, or accordion on mobile. (`03-worker-detail-mobile-dark.png`, `03-worker-detail-mobile-light.png`).

---

## Per-page findings

### /  (Overview)

- Light desktop: `screenshots/01-overview-desktop-light.png`
- Dark desktop: `screenshots/01-overview-desktop-dark.png`
- Mobile light: `screenshots/01-overview-mobile-light.png`
- Mobile dark: `screenshots/01-overview-mobile-dark.png`

**P0 (broken):** none.

**P1 (uncomfortable):**
- The page background in light has a subtle blue-purple tint (`#f4f5fb`-ish) while the cards are pure white. The eye reads this as "card on tinted glass" but the cards have no shadow or border to support that depth illusion — they just float. Either commit to elevation (drop shadow + border) or commit to flat (no tint difference). Currently feels accidentally washed-out.
- "Recent runs" + "Scheduled today" are two columns of *unequal weight*: Recent Runs has 5 dense rows; Scheduled Today has 1 line of empty-state copy. Looks unbalanced — Scheduled Today is reading as a leftover from a deleted feature, not a real surface. Either fold it into a smaller stat-card up top, or fill it (e.g., upcoming cron-triggered runs from the workers).
- "RUNS 24H" card has a green sparkline. "SUCCESS 7D" / "ACTIVE WORKERS" / "CONNECTIONS" cards have no chart. They feel like the spark-line was an experiment on one card and never shipped to the others. Either every stat card gets a 7d trend mini-chart, or none of them do.
- "Needs attention" lists `3 connections need re-authorization`, then directly under it lists `googlecalendar, googledrive, googlecalendar` — that's two googlecalendar entries with no distinguishing info, in tiny grey. From the row, a user can't tell *which* calendar account. (See same gripe on /connections below.)

**P2 (polish):**
- Logo block top-left is **the Floom SVG mark + the wordmark "Floom"**. Both say the same thing. Pick one. The wordmark already includes the mark in most renderings of the brand.
- The footer of the sidebar shows "Workeros" + a small `Light` / `Dark` toggle pill. The pill duplicates the Settings → Appearance tab. Either remove the inline toggle (since Appearance handles it) or remove the duplicate tab.
- The H1 "Today" is paired with the description "What ran, what is running, and what is next." Cute, but reads like a placeholder a copywriter forgot to replace. Compare to Vercel/Linear which have no description on the dashboard. Cut it, or replace with something operational ("Last 24 hours • 15 runs • 60% success") which is actually useful.

---

### /workers (Workers list)

- Light desktop: `screenshots/02-workers-desktop-light.png`
- Dark desktop: `screenshots/02-workers-desktop-dark.png`
- Mobile light: `screenshots/02-workers-mobile-light.png`
- Mobile dark: `screenshots/02-workers-mobile-dark.png`
- Starred tab (empty state): `screenshots/02-workers-starred-desktop-dark.png`
- Recent tab: `screenshots/02-workers-recent-desktop-dark.png`

**P0 (broken):** none.

**P1 (uncomfortable):**
- The Operations / Recruiting / Research **category filter row** sits in a card-shaped container that has its own border, padded out as if it were a section. But the actual category chips are tiny capsules inside. The container is doing nothing visually — strip it, let the chips sit directly under the tab row.
- Cards in dark mode are dark grey on slightly less dark grey. The "Manual" pill, "Last run / 13 runs in 7d / 62% success" footer line, and category text are all rendered in a single washed-out grey (~#7a7a85 on ~#1f2026). On a Retina screen at standard zoom these are barely readable. Either bump the muted-text token by 15-20% lightness in dark, OR raise it to a heavier weight.
- **Tags rendered as `<button>` elements.** "research / brief / strategy / markdown" each become a clickable button. Clicking them does… what? It is not obvious. If they filter the list, they should look like search facets (same style as the category chips above). If they don't, they shouldn't be buttons at all — they should be plain pills. Currently they read as buttons that do nothing.
- Status indicator is a single coloured dot in the card top-left with `aria-label="healthy"` / `"needs attention"`. The visual difference between healthy (small green dot) and needs-attention (small orange dot) is too subtle at this card scale. The "Weekly Update" card with 33% success and a tiny orange dot blends in with the healthy cards. Use the badge convention from the Connections page (a labelled `Active` / `Expired` pill) here too — your design system already has it, use it.

**P2 (polish):**
- The card title sits next to a small icon (cube / box). The icon doesn't differentiate by worker — every worker gets the same generic icon. Either give workers an emoji/icon in their `worker.yml` and surface it, or drop the icon entirely.
- "Run worker" is the bottom CTA on every card AND is also the H1's `<button>` style somewhere else. It's the same label everywhere. Pick "Run", which is shorter and parallels GitHub Actions / Linear etc. "Run worker" inside a card titled "Worker" is duplicate language.
- The search input is empty-state ("Search workers…") at the same width as everything else. Once you have 50 workers the search becomes the most-used control. Consider promoting it (sticky on scroll, command-K hotkey shown in the placeholder).
- Empty state for Starred ("Nothing starred yet. Tap the star on any worker card to pin it here.") is good copy, but says "tap" — Floom is desktop-first. "Click the star" or just "Star a worker to pin it here."

---

### /workers/research_brief (Worker detail — Run sub-section + side-nav)

- Light desktop: `screenshots/03-worker-detail-desktop-light.png`
- Dark desktop: `screenshots/03-worker-detail-desktop-dark.png`
- Mobile light: `screenshots/03-worker-detail-mobile-light.png`
- Mobile dark: `screenshots/03-worker-detail-mobile-dark.png`
- Sub-sections: `screenshots/03-worker-code-desktop-light.png`, `03-worker-triggers-desktop-light.png`, `03-worker-connections-desktop-light.png`, `03-worker-runs-desktop-light.png`, `03-worker-overview-desktop-light.png`

**P0 (broken):**
- **Initial navigation to `/workers/research_brief` displays "Worker not found / This worker may have been deleted or the ID is incorrect" + a red error toast "Failed to load worker: Failed to fetch"** for ~500ms, then resolves into the loaded worker. This is the worst possible first impression. The list page knows the worker exists (it just linked here); a new user sees "deleted" + a red toast and leaves. Render a skeleton, suspend, or pre-warm the cache — anything but the 404 state.

**P1 (uncomfortable):**
- **The side-nav sub-section list order is bizarre.** Top to bottom it is: Run, Code, Triggers, Connections, Runs, **Overview**. Overview should be FIRST (or removed). It's the canonical "what is this worker" page; surfacing it at position 6 means nobody ever sees it.
- The side-nav double-counts what's already in the main left rail. You now have a left rail (Overview/Workers/Runs/Secrets/Connections/Settings) *and* a worker-internal rail (Run/Code/Triggers/Connections/Runs/Overview) two of which share names (Connections, Runs, Overview) but mean different things. That cognitive collision is the #1 reason this page feels confusing. Rename the worker-internal items: Code → Source, Triggers → Schedule, Connections → Required apps, Runs → History, Overview → About.
- The "META" block at the bottom of the sub-nav rail shows "Last run · just now / Status · healthy / Triggers · manual." Useful, but it's pinned to the bottom of the second column where the eye doesn't go. Move it to a fixed strip under the H1 of the main content, where users will actually see it.
- The breadcrumb "back arrow" before the H1 is a 24px icon-only button with no label. On desktop, the left rail already has "Workers" — the back arrow is redundant. On mobile it consumes a whole row of header space.
- **Mobile breakage:** the worker sub-nav (Run/Code/Triggers/...) renders as a fixed full-height vertical column on mobile, eating ~140px of the 375px width. The right column gets ~230px. "Research Brief" H1 wraps to 2 lines because of this. Run worker form labels still fit but feel cramped. Convert sub-nav to a segmented control or horizontally scrolling pill row at the top of the page on mobile.
- The **Run** sub-section's primary CTA "Run worker" is the same blue as the global "New worker" button in the top-right of the workers list page. Same colour, same icon, same word "worker". Two different actions. Either change the verb (Run / Create) or differentiate visually (filled vs outline).
- Tag pills on the worker detail header ("Research / research / brief / strategy / markdown") have the **category** ("Research") rendered with NO visual distinction from the **tags** ("research", "brief", ...). Category and tags should not look identical.

**P2 (polish):**
- The "Code" sub-section file picker (`worker.yml / SKILL.md / run.py / requirements.txt`) renders the active file with the same styling as the inactive ones. The active file is identified by which one has its content rendered, not by any visual highlight in the file list. Light up the active file in the file rail.
- Code content is rendered as plain text with inline markdown styling, not as a code block. `run.py` should be in a monospace block with syntax highlighting; right now it would look like the same prose as `SKILL.md`.
- "Triggers" sub-section: the "Manual" trigger is the only one filled (a black button labelled Manual). "Cron / Webhook / Connection event" are outline buttons. Reading this as "Manual is selected" took me 4 seconds because it looks like a button group where the active one is black-filled. If only one trigger is configured, just show that one as a card; the unconfigured options should be a "+ Add trigger" affordance, not greyed-out buttons.
- "Overview" sub-section has a "Danger zone" card with a "Delete worker" CTA underneath "How it works". A delete CTA under a how-to section is bad placement. Move Danger zone to its own sub-nav item with confirmation flow, like Settings → Danger zone does at the top level.
- "Required secrets" in the Connections sub-section just shows `OPENAI_API_KEY` with a "Configure" button. Show the *status*: is this secret set? Currently you can't tell.

---

### /workers/new

- Light desktop: `screenshots/04-workers-new-desktop-light.png`
- Dark desktop: `screenshots/04-workers-new-desktop-dark.png`
- Mobile light: `screenshots/04-workers-new-mobile-light.png`
- Mobile dark: `screenshots/04-workers-new-mobile-dark.png`

**P0 (broken):** none.

**P1 (uncomfortable):**
- The big textarea has placeholder text "Summarise my Granola meetings and post action items to HubSpot CRM daily" rendered in **what looks like real content colour** — dark grey, full opacity. I had to read it twice to confirm it was placeholder. Standard practice: placeholder text should be much lighter than entered text. Drop the placeholder to ~40% opacity.
- "Generate ⌘↵" is a button containing a keyboard-shortcut glyph. The glyph is rendered in the same colour as the word "Generate" — when disabled (initial state), the whole button is greyed out, including the shortcut hint, so the user doesn't know the shortcut exists. Surface the keyboard shortcut even in the disabled state, OR split it into "Generate" + a separate `⌘↵` hint to the right of the button.
- Sample pills use `→` (Unicode arrow). These look fine on a Mac but render small on some Windows fonts. Either use an inline SVG arrow or accept the trade-off; the bigger issue is the pills are *all the same colour* — there's no signal which one is most popular / recommended. If "Granola → HubSpot daily" is the demo example, give it a "Try this" hint or a brand-aware accent.
- The page is 95% empty whitespace below the example pills on desktop. Either fill it (last 5 user prompts, "What others built", quick stats) or compress the textarea card so the page doesn't feel like a half-loaded form.

**P2 (polish):**
- The "Upload .md / .py / .zip" link in the bottom-left of the textarea card is using a paperclip icon next to text — fine — but the affordance is unclear (looks like a metadata footer, not an upload). Make it a button.
- The page H1 "Create a worker" + subtitle "Tell Floom what to automate" duplicates the title bar's existing context (left rail says Workers, breadcrumb is implied). Either drop the H1 or drop the subtitle.

---

### /runs (Global runs list)

- Light desktop: `screenshots/05-runs-desktop-light.png`
- Dark desktop: `screenshots/05-runs-desktop-dark.png`
- Mobile light: `screenshots/05-runs-mobile-light.png`
- Mobile dark: `screenshots/05-runs-mobile-dark.png`

**P0 (broken):** none.

**P1 (uncomfortable):**
- Each row shows: **bold worker name**, then a 12-char run ID in tiny grey monospace, then `·manual · 4min ago`, then a status pill on the right. The run ID is taking up the same visual real estate as the timestamp and trigger type. A run ID is not what users scan for — they scan by name + time + status. Either drop the run ID into a tooltip / on-hover detail, or shrink it to ~10pt and pin it to the absolute right side, before the status pill.
- The status pill on the right has rounded edges and a faint coloured background — but `completed` is green and `failed` is red. The red `failed` pills are *very* low-contrast on light mode (faint pink fill, faint red text). I see 16 rows and the failed ones don't pop. Make `failed` MUCH louder — bolder text, darker red, or a left-edge red bar on the row.
- The filter row has "All / Queued / Running / Completed / Failed" as button pills + a separate "All workers" combobox. There's no count next to each filter ("Failed (7)"). With 16 rows visible and 60% success quoted on the dashboard, the user wants to know how many failed without scrolling.
- "Export CSV" sits top-right, big as the "New worker" button on other pages. Export is a power-user destination feature; new-worker is the daily action. They should not have equal visual weight.

**P2 (polish):**
- All runs are "manual" on this single-user-v0 install — fine for the demo. But the `· manual` text appears 16 times. Once cron / webhook triggers exist this becomes useful; today it's noise. Suggest hiding the `manual` token until at least one non-manual run exists.
- Pagination: there's none visible. After 16 rows the page just ends. Where are runs 17-100? Add a load-more / pagination control.

---

### /runs/run_4f661958b88e (Run detail)

- Light desktop: `screenshots/06-run-detail-desktop-light.png`
- Dark desktop: `screenshots/06-run-detail-desktop-dark.png`
- Mobile light: `screenshots/06-run-detail-mobile-light.png`
- Mobile dark: `screenshots/06-run-detail-mobile-dark.png`

**P0 (broken):** none — and credit where due: the markdown rendering of the brief output is genuinely good.

**P1 (uncomfortable):**
- The H1 is `research_brief` (the worker SLUG, lowercase with underscore). On the workers list and the worker-detail page it's "Research Brief" (Title Case). On the run detail it suddenly becomes the slug. Pick one display format and use it everywhere.
- Top-row meta is: H1 + run ID + Copy button + "5/27/2026, 6:06:54 AM" + status pill + (Edit worker / Re-run / Download all) buttons. That's 9 distinct UI elements competing on one row. On desktop it just barely fits; on mobile it stacks awkwardly. Group them: title row (H1 + back arrow), meta row (run ID copy, timestamp, status), action row (Edit / Re-run / Download).
- The timestamp `5/27/2026, 6:06:54 AM` is US locale format. Floom users include the EU (DACH compliance worker is listed). Use ISO format (`2026-05-27 06:06:54`) or locale-aware. Worse: this timestamp is missing the timezone. Was that UTC or local?
- The Timeline panel is a great idea but its visual density is wrong. Eight events stack with timestamps + relative durations (+11ms, +25ms, +243ms, +21.4s, +9.6s, +12ms). The +21.4s is the only interesting one (where the agent actually spent time). Bold or highlight long durations; mute the sub-100ms ones.
- The Input panel renders the JSON in a code block but the Output panel renders the markdown as styled headings + paragraphs. Different content types are formatted differently — fine — but they have the same plain "Input" / "Output" section headers, no visual separation between them. Add a soft horizontal rule or a card border.
- "Re-run" should have a confirmation if the worker takes >5s and consumes API tokens. Currently it's a single click next to "Edit worker" with no friction.
- Artifacts list shows `brief.txt 5 KB` and `transcript.jsonl 10 KB`. The "KB" is rendered as a separate text node from the number, so it looks like "5" and "KB" are columns. Concatenate to "5 KB" / "10 KB" inline.

**P2 (polish):**
- The output starts with "RESEARCH BRIEF" before the H1 "Brief: …" — that label is leftover from the run output format. Drop or render as a smaller caption.
- The "Transcript" tab at the top — I never clicked it because the Run tab already has so much content. Worth telling users what the Transcript tab actually adds (logs vs. timeline events?).

---

### /settings (5 tabs)

- API access: `screenshots/07-settings-api-desktop-light.png`, `07-settings-api-desktop-dark.png`
- System: `screenshots/07-settings-system-desktop-light.png`
- Notifications: `screenshots/07-settings-notifications-desktop-light.png`
- Appearance: `screenshots/07-settings-appearance-desktop-light.png`
- Danger zone: `screenshots/07-settings-danger-desktop-light.png`
- Mobile light: `screenshots/07-settings-mobile-light.png`
- Mobile dark: `screenshots/07-settings-mobile-dark.png`

**P0 (broken):** none.

**P1 (uncomfortable):**
- **Notifications tab has 2 toggles labelled `Soon`** with the toggles greyed out. Both options are placeholders. Either ship the feature or remove the tab. A "Soon" feature in production is a credibility leak — a v0 user reads "Soon" as "this team ships features that don't exist yet."
- **Appearance tab has exactly one control: a Light/Dark toggle pill.** It's the same pill that exists in the sidebar footer. Duplicate control, half-empty tab. Either remove the tab and rely on the sidebar pill, OR put more here (font size, density, sidebar position, accent colour — anything).
- **API access tab token reveal:** the redacted token is rendered as `924a********************************************************fe59` — 60+ asterisks. That's visually noisy. Display as `924a****…****fe59` (first 4 + last 4 + ellipsis) for the redacted view; only show full on Reveal.
- The CLI/MCP/API sub-tabs inside the Setup Commands card have no visual indication that the active tab IS active — "CLI" looks the same as "MCP" and "API" except for an underline. On dark it's even fainter. Use a stronger active state.
- The System tab's "All required secrets are set / Workers can run with full platform configuration" callout is a green banner — good — but the icon inside it is just a circle outline with a checkmark, very small. Make the success state more confident (filled green circle, larger icon).
- Mobile settings: the 5 tab pills "API access / System / Notifications / Appearance / Danger zone" sit on one row and the last one ("Danger zone") is **almost cut off** at the right edge. On a 375px viewport this is tight but rendered. On a 360px viewport (common Android) it would clip. Either let the tab row scroll horizontally with an indicator, OR use a popover/select for tab switching on mobile.

**P2 (polish):**
- "Danger zone" tab has only one action: "Clear run history → Clear runs" button. The button is white outline on white background — for a destructive action it should be red outline (or red text on hover). Currently it looks safer than the "Disconnect" button on /connections, which IS red.
- System tab shows Version, Started at, Python, Runner. Useful for debugging. But "Started at" `2026-05-27T05:53:12Z` is ISO format here, while the run-detail page uses US locale. Pick one.

---

### /connections + /connections/browse + /connections/connect/googlecalendar

- Connections list (light): `screenshots/08-connections-desktop-light.png`
- Connections list (dark): `screenshots/08-connections-desktop-dark.png`
- Connections list (mobile dark): `screenshots/08-connections-mobile-dark.png`
- Connections list (mobile light): `screenshots/08-connections-mobile-light.png`
- Browse (light): `screenshots/08-connections-browse-desktop-light.png`
- Browse (dark): `screenshots/08-connections-browse-desktop-dark.png`
- Browse (mobile): `screenshots/08-connections-browse-mobile-dark.png`
- Connect-googlecalendar (light): `screenshots/08-connections-connect-googlecal-desktop-light.png`
- Connect-googlecalendar (dark): `screenshots/08-connections-connect-googlecal-desktop-dark.png`

**P0 (broken):**
- **`/connections/connect/googlecalendar` light mode: the primary CTA "Connect to Google Calendar" renders as a featureless black bar with NO visible text.** Light-mode button uses `--color-foreground` (dark) as background but apparently the same token (or close to it) as label colour — net effect is black-on-black. This is the click target that authorizes 1,043 integrations in your catalog. **Hotfix immediately.**
- **The Google Calendar app logo to the right of the Floom logo on the connect-to header renders as a blank/empty white square in light mode.** It looks like an image-load failure, but the catalogue endpoint clearly has the logo (it shows correctly on `/connections/browse`). Either the consent page is not piping the logo URL, or it's using a different image source that's failing. Either way, looks broken.

**P1 (uncomfortable):**
- **Duplicate Google Calendar rows on /connections.** Two entries: `federico (…849fe7)` and `federico (…829218)`. Both Expired, both showing the same icon, same name, same status, same buttons. Only differentiator is a 6-char hex suffix in tiny grey monospace inside the parentheses. A user trying to pick which to Reconnect cannot tell them apart. Surface a meaningful difference: which Google account email, when it was first connected, which workers use which.
- The Connections list cards have 4 buttons each (Reconnect / Test / Disconnect / Refresh status icon-button). On 5 connections that's 20 click targets. The right side of every card has the same button rail. Consider folding Test + Refresh into a dropdown / overflow menu — the everyday actions are Reconnect (when expired) and Disconnect.
- "Default scopes" label appears on every card with no value. Either show the actual scopes, or remove the label (since "Default" is the implied baseline).
- "Last used: Never" appears on every single connection (5/5). Reads as "nothing has ever used these connections" — which contradicts the dashboard saying 7 workers are active. Either fix the tracking (probably "Last used" never updates) or remove the field until the data is real.
- **Browse integrations:** the catalog header says "1,043 integrations" + Pagination footer says "Page 1 of 35" with 30 per page = 1,050. Off by 7. Tiny consistency bug, but the lazy-eye reads "approximately 1000" anyway, so consider showing "1,000+ integrations" instead of a misleading precise count.
- Browse integrations: every app card has a Connect button. With 30 cards on a page, the page is dominated by a grid of identical blue buttons. Visual rhythm becomes "blue button blue button blue button" not "Gmail, GitHub, Notion." The CTA should appear on hover or be a single icon (`+`), not a full button on every card.
- Browse integrations: the category filter row ("All / Popular / Productivity / Email / CRM / Social / Marketing / Data / Collaboration") goes one level deep, but `Browse → Productivity` would yield 200+ results that need a sub-filter. Plan for a second-level filter or a search-first interaction.
- **Browse integrations on mobile:** cards render in 2-col grid on a 375px viewport. With the Connect button + description + 2 lines of category text + heading, each card is ~140px wide and 140px tall — the description "Composio enables AI Agents and LLMs to authenticate and integrate with various tools…" truncates to "Composio enables AI…" Useless preview. Either go 1-col on mobile (taller cards, full descriptions) or accept that mobile is browse-only and remove descriptions on mobile.

**P2 (polish):**
- The "Connections use OAuth. Workers that declare a connection in their `worker.yml` list it as part of their declared capabilities. Workers that read it will see an error from the upstream API if the connection isn't valid." footer note is RENDERED with bare `worker.yml` styled inline-code in mid-grey. Hard to read in light, harder in dark. Either give inline-code a clearer background block, or move this content to a tooltip on a "What's a connection?" link.
- The Active / Expired pills on connection cards are good — but the pill text is rendered as the **same colour as the label background**, just darker. So "Active" is dark-green text on light-green background; "Expired" is dark-red on light-red. At the small pill scale this is fine but it could be more confident.
- `/connections/connect/<provider>`: the consent card shows the Floom logo + the app logo with a "·" dot between them. Standard OAuth consent screens use a circular avatar with an arrow → between. The dot is unclear about which way the data flows.

---

### /cli-auth?code=ABCD-EFGH

- Light: `screenshots/09-cli-auth-desktop-light.png`
- Dark: `screenshots/09-cli-auth-desktop-dark.png`
- Mobile light: `screenshots/09-cli-auth-mobile-light.png`
- Mobile dark: `screenshots/09-cli-auth-mobile-dark.png`

**P0 (broken):** none — the page renders, Approve / Deny are reachable.

**P1 (uncomfortable):**
- This is a **security-relevant page** (authorizing a CLI to act on the user's behalf), but it's rendered inside the standard app chrome with the sidebar, "Workeros" footer, and theme toggle — same as every other page. OAuth/CLI-auth pages should feel distinct: removed sidebar, centred card, no other navigation. Currently a careless user sees the sidebar nav items and clicks away from the consent screen entirely.
- The card content is sparse: "A CLI is requesting access / Code: ABCD-EFGH / Client: floom-cli" then Approve / Deny. That's it. A CLI consent screen should show: *what scopes the CLI gets*, *the IP / device fingerprint of the requester*, *when this code expires*, and *what happens after Approve*. Currently the user can't make an informed decision.
- "Approve" and "Deny" buttons are equal weight — same size, same outline style. Approve is filled-blue in dark mode but in light mode it looks weak. Confirm-destructive convention: Approve should be the primary (filled) action, Deny should be secondary (ghost), but Approve should NOT auto-focus (avoid accidental hit-enter approvals).

**P2 (polish):**
- The H1 is "Authorize CLI" — fine but generic. "Authorize floom-cli to access your Floom account" is more honest.
- The `code: ABCD-EFGH` is rendered as inline code (monospace). Could be a confirmation prompt: "Confirm this is the code shown in your terminal."

---

### /secrets (encountered while walking; not in original brief but reachable from sidebar)

- Light: `screenshots/10-secrets-desktop-light.png`

Briefly: the empty state ("No secrets configured / Workers that call external APIs require secrets…") is the cleanest empty state in the app. The "Add a secret" CTA is a good ghost button. The card frame around the empty state has the same too-faint border as the rest of the app, but the content itself is well-structured. One nit: "Add secret" (top-right) and "Add a secret" (centred CTA) — same action, two different labels. Pick one.

---

## Cross-cutting findings (apply across all pages)

### Design system inconsistencies (P1)

1. **Card surface treatment is not standardized.** I count at least three card styles:
   - Workers list: white card, faint shadow, soft border (`/workers`).
   - Connections list: white card, no shadow, slightly thicker border (`/connections`).
   - Settings tabs: white card, even thinner border, no shadow (`/settings`).
   - Run detail Timeline: white inside-white sub-card with no border at all.
   Same primitive ("panel"), four different visual treatments. Pick one card token and apply it everywhere.

2. **Status / pill component duplicated.** Workers list uses a tiny coloured dot in the corner; Connections uses a labelled pill ("Active" / "Expired"); Runs uses a different pill style ("completed" / "failed"). All three communicate "current state of a thing" — and all three look different. Consolidate.

3. **Button colour conventions slip.** Primary blue is used for: "New worker" (CTA), "Run worker" inside a worker detail card (CTA), "Connect" on every browse-integrations card (probably should be ghost). Destructive red is used for: "Disconnect" link text (not a button), "Delete worker" filled button on /workers/research_brief Overview, "Clear runs" outlined-button on /settings/danger. Inconsistent — destructive actions should be ONE convention (filled red, or red text, or red outline — pick one).

4. **Iconography is inconsistent.** Some icons are line icons (sidebar nav, file picker icons), some are filled. Inside the worker detail sub-nav, "Run" has a filled-triangle play icon, the others have line icons. Pick a line set or a filled set and stick to it. (Recommend lucide line set used uniformly — looks like that's what most of the app already uses.)

5. **Typography weights.** Section headers ("Recent runs" on dashboard, "History" on /runs, "Environment secrets" on /secrets) all use different weights/sizes. Settle into a 3-tier hierarchy: H1 (page title), H2 (section), H3 (sub-section / card title).

### Dark mode (P1)

Dark mode mostly works (good — many products ship dark only as an afterthought). Specific issues:
- **Muted text contrast.** On `/workers` dark, the "Last run 2h ago · 3 runs in 7d · 33% success" footer line is `~#62646c` on `~#16171a` — that's below WCAG AA for non-essential text but it's *important* operational data. Bump to ~#9a9ca5.
- **Card backgrounds and page background are very close in luminance.** On the Workers dark page, the card-to-page contrast is maybe 2-3% lightness. Cards barely separate from the background. Either bump card lightness by ~5% or add a subtle border.
- **Theme button label is stale.** I clicked the theme button — it cycled to Dark — and the button's `aria-label` was still "Theme mode: Light" until I clicked again to System. State desync between the React component and the DOM accessibility tree. (See screenshots: `02-workers-desktop-dark.png` snapshot shows "Theme mode: Light" with the page clearly rendered dark.)

### Mobile (P1)

- **Sidebar correctly collapses to hamburger.** That's good.
- **Detail-page sub-navigation does NOT collapse to mobile-friendly form.** This is the worst mobile issue: the worker detail page's sub-nav still renders as a fixed-width vertical column on 375px viewport. Same problem on settings to a lesser degree.
- **Mobile content widths vary.** /workers cards are full-width on mobile (good). /runs rows are full-width (good). /workers/<id> Run form is squeezed into ~230px because the sub-nav steals 140px (bad). /connections cards have button rails that don't stack — the 3-button column on the right (Reconnect / Test / Disconnect) stacks vertically inside the card on mobile, but the card itself doesn't shrink, so the layout looks fine but the buttons are tiny.
- **Touch targets.** The sidebar footer Light/Dark pill is ~32px tall. Apple HIG says 44px minimum, Material says 48dp. Most tappable rows in the app are below 40px tall on mobile. The chat-like "Add to favourites" star button on worker cards is ~24px. Increase tap targets across the board.
- **Mobile cards have inconsistent padding.** /workers cards have ~16px padding; /connections cards have ~12px; /runs rows have ~8px vertical. Hard to spot in isolation; obvious when you scroll across pages.

### Empty / loading / error states (P1)

- **No skeleton states observed.** Pages either show content or show the empty/error state immediately. The worker-detail "Worker not found / Failed to fetch" toast IS the loading state, which is the bug. Add skeletons or `aria-busy` indicators for every async fetch.
- **Error toasts auto-dismiss in <5 seconds.** I missed the "Failed to fetch" toast on first navigation because it disappeared by the time I switched tabs. Errors should persist until dismissed.
- **No retry affordance.** When the worker-detail fetch failed, there was no "Retry" button on the not-found screen. User has to reload the whole page.

### Microcopy (P2)

- "Workeros" footer text is in every sidebar — every page. Once Floom hits v1, that string is stale. Replace with semantic version from the build (`v0.1.0` is already shown on /settings/system).
- "Connect a tool" (page CTA on /connections) vs "Connect" (button label on every catalogue card) vs "Connect to Google Calendar" (consent screen) — three slightly different labels for the same operation. Pick one verb pattern.
- "Run worker" vs "Run" — same gripe.
- "Edit worker" (on run detail) vs "Edit" (on worker detail header) — same gripe.

### Affordances (P2)

- Clickable rows on /runs are clickable but the row hover state is barely visible (light grey on light grey). Make hover obvious.
- The `>` chevron on the right of each /runs row is a clickability hint, which is good — but it's also faint grey. Bump contrast.
- The "Worker keeps failing" item under "Needs attention" on the dashboard is clickable (links to the worker detail) but doesn't look it. No chevron, no hover state shown. Apply the row-link styling from /runs to dashboard rows too.

### Surprise / delight (P2)

- Spark line on the dashboard RUNS 24H card. Nice. Now apply to the other 3 cards.
- Markdown rendering on run output is well done — headings, list items, paragraphs all look like a real document, not a wall of monospace.
- Empty state for Starred workers ("Nothing starred yet. Tap the star on any worker card to pin it here.") is friendly, points at the next action. More empty states like this please.

### No AI slop (good)

- No random emojis in UI. Good.
- No gratuitous gradients. Good.
- No fake user avatars or stock testimonials. Good.
- Brand uses a single colour family (blue accent + greys). Good.
- No "✨ Powered by AI" badges anywhere. Good.

---

## Closing note

This product is closer to a B than the headline grade suggests, but it loses points for:
- One P0 visual bug on the OAuth consent screen (the single most important page for a v0 product whose USP is "connect 1,043 apps").
- One P0 race condition on the worker detail page (the second-most important page).
- A pervasive mobile sub-nav design that breaks every detail page.
- A design system that hasn't decided on cards, pills, or buttons.

Fix those four classes and Floom looks like a B+/A− product. The bones are good.

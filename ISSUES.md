# ISSUES (Federico's 2026-05-26 morning walkthrough)

Status legend: OPEN / FIXING / FIXED / VERIFIED. Issues raised by Federico from a real browser walkthrough of workers.floom.dev after PRs #29-#33 landed.

---

## P0 — blocks the "useful B2C worker" claim

### #1 Generated worker is empty after create (no SKILL.md, no run.py)

**Where:** `POST /workers` (`apps/api/main.py:1506-1543`) + `apps/web/app/workers/new/page.tsx`

**Symptom:** Federico created `summarise-meetings` via prompt-to-worker. The draft LLM returned a `skill_md` body (per `_DRAFT_SYSTEM_PROMPT` in `main.py:1264`), but on the worker detail page nothing is shown. There is no SKILL.md viewer/editor, no run.py viewer, no code panel at all.

**Root cause:** Two bugs:
1. `POST /workers` writes a hardcoded placeholder SKILL.md (`main.py:1522-1526`) — it ignores any `skill_md` field on the payload. The LLM-generated body is discarded.
2. The `/workers/new` UI does not POST the generated `skill_md` to `POST /workers` even if the endpoint accepted it.
3. The worker detail page (`/workers/[id]`) does not render SKILL.md / run.py source.

**Fix scope:**
- Extend `WorkerCreateRequest` to accept optional `skill_md`; if present, write it to `SKILL.md` instead of the placeholder.
- Frontend: in `/workers/new` Step 2 "Create worker", include the `skill_md` from the draft response in the POST body.
- Frontend: on `/workers/[id]`, show a "Code" tab/section with SKILL.md (and run.py if pure-script) rendered + editable. Tied to #2.

**Status:** OPEN

---

### #2 Worker detail page uses cards; should be tabs

**Where:** `apps/web/app/workers/[id]/page.tsx`

**Symptom (Image #9):** Long vertical stack of cards: Description → Inputs → Outputs → Connections → Trigger → Enriched CSV preview → How it works → Run worker → Recent runs. Card layout makes navigation tedious and pushes "Run worker" below the fold.

**Federico:** "the card based logic is not good? should be tabs on a worker page or so?"

**Fix scope:** Replace card stack with tabs (suggested: `Overview / Run / Code / Connections / Runs`). Tab content swaps in place. "Run worker" becomes the first/default tab so the primary action is one click from page load.

**Status:** OPEN

---

### #3 Sidebar layout breaks on scroll (BOTH /workers and /workers/[id])

**Where:**
- `apps/web/app/workers/page.tsx:72` (inner folders+tags `<aside>` on the worker list page, sits in `grid-cols-[240px_minmax(0,1fr)]` with no sticky/overflow styles)
- `apps/web/app/workers/[id]/page.tsx` (worker detail page sidebar)

**Federico:** "the sidebar on https://workers.floom.dev/workers is still broken" (raised twice; PR E was originally scoped to /workers/[id], broaden to cover /workers list too)

**Symptom:** When the worker list grows past the viewport, the folders+tags aside scrolls with the page content and ends up off-screen above the fold while the user is still scrolling through workers. The aside has no `position: sticky` / `top` / `max-height` / `overflow-y` styles.

**Fix scope:** Both asides need `position: sticky; top: <header-height>; max-height: calc(100vh - <header-height>); overflow-y: auto;` so they pin while main content scrolls and the inner content is independently scrollable.

**Status:** OPEN — covered by PR E.

---

### #4 Connections logic on /workers/new is wrong (Image #11)

**Where:** `apps/web/app/workers/new/page.tsx` Step 2 + `/workers/draft-from-prompt` connection inference in `apps/api/main.py:1296-1302`

**Symptom (Image #11):** For the meeting-summary worker, "Set up requirements" shows:
- API KEYS: GRANOLA_API_KEY, HUBSPOT_API_KEY
- OAUTH CONNECTIONS: HubSpot, Granola, Google Calendar

Federico: "It should be either OAuth or Secrets for HubSpot and Granola here, so it should not be both." Plus Google Calendar shouldn't be present at all if the prompt was meetings + HubSpot. The connection list is bleed-over from `_COMPOSIO_APP_KEYWORDS` keyword detection (meeting → google-calendar).

**Fix scope:**
- For each integration the worker needs, present ONE choice: OAuth (preferred) OR API key, not both. Decide based on whether Composio supports OAuth for that app.
- Tighten connection inference: don't include apps that weren't explicitly mentioned in the prompt. "Granola meetings" doesn't imply Google Calendar.
- Better: let the LLM return a structured `requirements` array with `{app, method: oauth|api_key}` per item, and trust that over keyword inference.

**Status:** OPEN

---

### #5 No file upload when running a CSV worker (Image #8)

**Where:** `apps/web/app/workers/[id]/page.tsx` Run worker form

**Symptom (Image #8):** The csv_enricher Run form has a single-line `CSV rows` text input that says "name,companyAlice,AcmeBob,Stark" as placeholder. Federico has to paste CSV inline. He expects a real file upload.

**Federico:** "have real csv uploads etc if csv?"

**Fix scope:**
- For `kind: file` worker inputs, render `<input type="file">` with appropriate `accept` (text/csv, application/pdf, image/*, etc.) per the input's `media_type`.
- POST the file via the existing `/uploads` endpoint, then pass the upload reference to `/workers/{id}/runs`.
- The csv_enricher worker's `csv_rows` input should declare `kind: file, media_type: text/csv` instead of `kind: scalar, type: string`.

**Status:** OPEN

---

### #6 No way to upload your own SKILL.md when creating a worker

**Where:** `apps/web/app/workers/new/page.tsx`

**Symptom:** /workers/new only offers a prompt textarea. Federico originally expected "you write your own skill MD" (paste or upload .md file). The prompt-to-worker flow is good, but he wants the option to upload a SKILL.md too.

**Federico:** "when creating a worker, I should also be able to upload files and not just insert text. I actually thought we will just do 'you write your own skill MD'... It's also fine. I think it's even better, but yeah."

**Fix scope:** Add an "Upload SKILL.md" tab/button on /workers/new. Drop file in → parse content → skip Step 1 (prompt) and jump straight to Step 2 (Review + Create), prefilling SKILL.md and letting the user fill `name`, `title`, requirements manually OR re-run the draft-from-prompt against the uploaded SKILL.md to back-fill metadata.

**Status:** OPEN

---

### #7 "Connect a tool" modal is a fixed list, not searchable, not scrollable (Image #14)

**Where:** `apps/web/app/connections/page.tsx` + the modal component

**Symptom (Image #14):** Modal shows ~11 connect options (Gmail, Google Calendar, Google Drive, Slack, Notion, Linear, GitHub, HubSpot, Salesforce, LinkedIn, Apollo). The list is fixed — no search box, doesn't scroll past Apollo, and there's no way to reach the other ~1030 integrations from /connections/browse.

**Federico:** "The connected tool is not a list, which I cannot even scroll right now. Obviously it should be something I can search through, like a proper marketplace list for all the tools I can connect to."

**Fix scope:** Replace the fixed modal with a searchable marketplace inline (or inside the modal):
- Search box at top
- Category filter chips
- Paginated/virtualised list of all 1043 catalog integrations
- Reuses `GET /integrations/catalog?search=&category=&page=&limit=` which already exists and works.

This is essentially merging `/connections/browse` into the connections page or linking to it from the modal.

**Status:** OPEN

---

### #8 "Scopes unavailable" on every connection (Images #12, #13)

**Where:** `apps/web/components/connections/ConnectionCard.tsx:100` + API `GET /connections` projection (`apps/api/main.py:2205-2278`)

**Symptom:** Every connection card (Gmail, Google Drive, LinkedIn) shows "Scopes unavailable".

**Root cause:** The API `ConnectionItem` schema does not include `scopes`. The DB stores `composio_connection_id` but never queries Composio for the connection's scope list. Frontend's `connection.scopes` is always `[]` → falls into the "Scopes unavailable" branch.

**Fix scope:**
- Extend `ConnectionItem` to include `scopes: List[str]`.
- On `GET /connections` (or `GET /connections/{id}/status`), call Composio's connected-account info endpoint and project the scope list.
- Cache scopes in the DB row (denormalize) so we don't hit Composio for every list call. Refresh on reconnect.

**Status:** OPEN

---

### #9 "Connected as unknown account" on every connection (Image #12)

**Where:** Same as #8

**Symptom:** Every connection card shows "Connected as unknown account" instead of the actual signed-in identity (e.g. `depontefede@gmail.com`).

**Root cause:** `ConnectionItem` has no `accountLabel`/`account_label` field. Frontend reads `connection.accountLabel` (`ConnectionCard.tsx:79`) which is undefined; some upstream code likely substitutes "unknown account".

**Fix scope:**
- Extend `ConnectionItem` to include `account_label: Optional[str]`.
- Project the Composio connected-account email/handle when listing.
- Cache in DB.

**Status:** OPEN — same backend touchpoint as #8; ship them together.

---

### #10 "Connections backend not configured on this server" toast on every action (Image #15)

**Where:** `apps/web/app/connections/connected-accounts/[id]/route.ts:27-33`, `apps/web/app/connections/auth-configs/[id]/route.ts:33`

**Symptom:** Clicking Reconnect / Disconnect / opening a connection detail surfaces a red toast "Connections backend not configured on this server". The frontend cannot fetch account info or scopes for any connection.

**Root cause:** Both Next.js server-side routes read `process.env.COMPOSIO_API_KEY`. The variable IS set on the API service (`/root/.config/workeros/api.env`) but NOT on the Vercel web project — the Next route returns 503 immediately.

**Fix scope (two options):**
- **Quick:** Add `COMPOSIO_API_KEY` to the Vercel `workeros-web` project env vars (requires Federico's approval per CLAUDE.md env-var rule).
- **Cleaner (recommended):** Proxy these calls through the FastAPI service. Move the logic from `connections/connected-accounts/[id]/route.ts` + `connections/auth-configs/[id]/route.ts` into new endpoints on `apps/api/main.py` (`GET /connections/{id}/account-info`, `GET /connections/{id}/auth-config`), so the Composio key only lives on the API. The Next routes become thin proxies. This also removes the duplicate `fetchLocalComposioConnectionIds` ownership check that already exists upstream.

**Status:** OPEN — recommend the cleaner option since it shrinks the secret blast radius.

---

### #11 No "Test connection" button (Image #16)

**Where:** `apps/web/components/connections/ConnectionCard.tsx:109-130` — only Reconnect + Disconnect render. Compare with `/secrets` which already exposes a Test button (`apps/api/main.py` has `POST /secrets/{name}/test`).

**Federico:** "Why can't I test my connections?... I should see when it was last checked. It's super important, same as secrets."

**Fix scope:**
- Backend: add `POST /connections/{id}/test` that calls a lightweight Composio endpoint (e.g. fetch the connected account; success means the token is still valid).
- Frontend: add Test button next to Reconnect/Disconnect on the connection card; show inline result (`Tested OK 2 min ago` / `Failed: token expired`).

**Status:** OPEN

---

### #12 No "last checked at" timestamp; need daily health check for connections AND secrets

**Where:** Connection cards show `Active` / `Expired` badges with no timestamp context. Same gap exists on `/secrets`.

**Federico:** "It's checked every day to see if the secrets or connections still work. If they expire, I have to know. They show active and expired, but they should explain that it was last checked when."

**Fix scope:**
- Backend: extend `composio_connections` and `secrets` tables with `last_checked_at TIMESTAMP NULL` + `last_check_status TEXT NULL` + `last_check_error TEXT NULL`.
- Add a daily cron (systemd timer or in-process scheduler) that iterates every connection + secret, calls the test endpoint, and updates the columns.
- Surface `last_checked_at` + `last_check_status` on `GET /connections` and `GET /secrets`.
- Frontend: render `Last checked 2 hours ago · valid` / `Last checked 1 day ago · failed` under each badge.

**Status:** OPEN — ties together with #11 (test endpoint is the per-call primitive used by the daily sweep).

---

### #13 /settings has a duplicate "Secrets summary" card

**Where:** `apps/web/app/settings/page.tsx:174-204`

**Symptom:** /settings has 5 cards: System Info, Platform configuration, Workers, **Secrets summary** (duplicate), Danger Zone. The "Secrets summary" card shows the same `secrets.list()` data as the dedicated `/secrets` page in the sidebar. Two surfaces for the same data, divergent over time.

**Federico:** "why does it have secrets?"

**Fix scope:** Delete the "Secrets summary" card from `/settings`. Sidebar already exposes `/secrets`.

**Status:** OPEN — trivial.

---

### #14 FLOOM_RUN_TIMEOUT shown as red "missing" but is optional with a default

**Where:** `apps/api/main.py:2122-2132` (PLATFORM_SECRETS set) + `/system/platform-config` endpoint + `apps/web/app/settings/page.tsx:130-158`

**Symptom (Image #17):** Platform configuration shows FLOOM_RUN_TIMEOUT with a red "missing" badge, same severity as a real infra secret being absent. Federico cannot edit it from the UI ("anything i can do for the platform config? some value seems missing but i cannot edit?").

**Reality:**
- `apps/api/runner_local.py:28` reads `FLOOM_RUN_TIMEOUT` with a 300s default. It is optional.
- All PLATFORM_SECRETS are systemd env vars in `/root/.config/workeros/api.env` — editing requires SSH, not UI. That's intentional ("Configure these on the server"), but red "missing" makes it look broken.

**Fix scope:**
- Tag PLATFORM_SECRETS entries with `required: bool` + `default: Optional[str]` metadata. Project `{name, status, required, default}` in `/system/platform-config`.
- UI: for `required:false, status:missing` render a neutral chip "optional · default 300s" instead of red.
- Optionally: drop FLOOM_RUN_TIMEOUT from the platform list since it's a tuning knob, not a secret.

**Status:** OPEN — trivial, ship with #13 as a small docs/settings PR.

---

### #15 No proper favicon

**Where:** `apps/web/app/favicon.ico` (currently a default Next.js placeholder)

**Federico:** "have no proper favicon"

**Symptom:** Browser tab shows the default Next.js favicon, not a Floom-branded one. The HTML head correctly links to `/favicon.ico` so the wiring is fine; only the file content needs to change.

**Fix scope:**
- Replace `apps/web/app/favicon.ico` with a proper Floom-branded icon (the "F" mark from the sidebar at `apps/web/components/Sidebar.tsx` — currently rendered as an HTML element `<div class="...bg-[var(--solid)] text-[var(--solid-fg)]">F</div>`, would translate to an icon).
- Add `apps/web/app/icon.tsx` (Next.js dynamic icon generation) OR drop a real `.ico` + 192/512 PNGs in `apps/web/app/` so Next.js auto-wires them.
- Verify mobile + apple-touch-icon variants.

**Status:** OPEN — small UI polish, ship in PR G.

---

## Sequencing

Suggested PR cuts (parallelizable):

1. **PR A — Worker code lifecycle** (#1 + #2 + #6): backend `POST/PUT /workers` accept `skill_md`; frontend `/workers/new` posts it; `/workers/[id]` becomes tabs with Overview/Run/Code/Connections/Runs; upload SKILL.md option on /workers/new.
2. **PR B — Connections backend + projection** (#8 + #9 + #10 + #11 + #12): move Composio account/scopes/test calls server-side into FastAPI so the key stops being a Vercel env. Add `POST /connections/{id}/test` + `last_checked_at` columns + daily sweep. Project `account_label` + `scopes` + `last_checked_at` on `GET /connections`. Same migration covers `secrets`.
3. **PR C — Connections marketplace UX** (#7): replace fixed "Connect a tool" modal with searchable paginated list backed by `GET /integrations/catalog`.
4. **PR D — Requirements UX** (#4): tighter connection inference + one-method-per-app (OAuth XOR API key).
5. **PR E — Run inputs + sidebar scroll** (#3 + #5): file inputs for `kind: file`; sticky sidebar.
6. **PR F — Settings cleanup** (#13 + #14): remove duplicate Secrets card from /settings; tag platform secrets with `required` + `default` so optional vars render neutrally.
7. **PR G — Favicon + /workers sidebar** (#3 partial + #15): proper Floom-branded favicon; sticky sidebar on `/workers` list page. Standalone, small.

**Parallel lanes:**
- **Lane 1 (connections):** PR B then PR C in sequence (small overlap on the modal).
- **Lane 2 (workers):** PR A then PR D then PR E in sequence (all touch /workers files). #3 sticky sidebar on /workers/[id] stays in PR E; PR G covers the /workers list aside which is independent.
- **Lane 3 (polish):** PR F and PR G standalone, independent of everything else.

PR B is the most launch-critical (connections are functionally broken right now). Four workstreams can run in parallel worktrees.

**Total estimated effort:** 12-16 hours of focused work split across the 7 PRs.

---

## Out of scope (Federico did not raise these)

- Multi-action skills (already deferred post-launch in ROADMAP.md)
- Rich JSON output preview (deferred post-launch)
- In-UI file preview for PDF/Excel/images (deferred post-launch)

---

# Round 2 — 2026-05-26 afternoon walkthrough

After PRs #34-#40 + the sticky-sidebar fix landed, Federico did another walkthrough. Twelve more items (#16-#27).

---

### #16 Worker cards have no View / Edit buttons, only Run

**Where:** `apps/web/app/workers/page.tsx` worker card grid

**Federico:** "I should not only be able to run them but also just look at them or edit them, right?"

**Fix scope:** Each worker card needs three actions: **View** (read-only detail page), **Edit** (open YAML/SKILL.md editor), **Run** (existing primary action). Could be a primary button + secondary icon buttons or a small action row. The detail page at `/workers/[id]` (now tabs) already supports both modes; just need links from the card.

**Status:** OPEN

---

### #17 Cards show "Trigger: manual · Runner: e2b" — runner is always e2b, triggers can be multiple

**Where:** `apps/web/app/workers/page.tsx` worker card metadata row

**Federico:** "Why does it say trigger manual and runner e2b? You can have multiple triggers for each worker, right, and the runner is always e2b."

**Two problems:**
1. **Runner: e2b** is hardcoded on every worker (since the local runner was removed). Showing it on every card is noise. Drop it.
2. **Trigger: manual** is shown as a single value but a worker can have multiple triggers (manual + cron + webhook + connection event). Show ALL configured triggers as chips.

**Fix scope:**
- Remove the runner label entirely from worker cards.
- Project all configured triggers (not just the first one) on `WorkerSummary` and render as chip row: `[Manual] [Cron · daily 9am] [Webhook] [On Slack message]`.

**Status:** OPEN

---

### #18 Worker cards missing usage telemetry (last run, recent invocations, success rate)

**Where:** `apps/web/app/workers/page.tsx` worker card

**Federico:** "we can make the workers' cards nicer by adding some data on when they were last run, like over the last days, how often they were invoked, stuff like that"

**Fix scope:**
- Backend: aggregate run stats per worker for the last 7d/30d. New endpoint `GET /workers/{id}/stats` OR include `recent_stats: {last_run_at, runs_7d, success_rate_7d}` directly on `WorkerSummary`.
- Frontend: render below the worker description as a small inline meta line: "Last run 2h ago · 14 runs in 7d · 92% success".

**Status:** OPEN

---

### #19 /workers/new upload only accepts SKILL.md; should accept .py, .zip, full folder

**Where:** `apps/web/app/workers/new/page.tsx` upload control (added in PR A)

**Federico:** "now I have the option to upload an md file or skillmd file, but I should be able to upload also something else, like a Python script or a zip or a folder with the whole skill."

**Fix scope:**
- Upload input accepts: `.md`, `.py`, `.zip`, OR a folder (via `webkitdirectory`).
- Backend `POST /workers` already accepts `worker_yml` + `run_py` + `skill_md`. Extend or add `POST /workers/from-bundle` that accepts a multipart zip/folder upload, unpacks it, validates `worker.yml`, and registers the worker.
- For `.py` upload: prefill `run_py`, generate a stub `worker.yml` + minimal `SKILL.md`.
- For `.zip` / folder: unpack, expect `worker.yml` + `SKILL.md` + `run.py`, validate all three.

**Status:** OPEN

---

### #20 /workers/new layout — better stacking order

**Where:** `apps/web/app/workers/new/page.tsx` Step 1

**Federico:** "Maybe also have me, I'm not sure, having the prompt box, and then below the upload and below the examples. I think this can be smoother, better layout."

**Current order:** Prompt textarea (with Generate + Cmd+Enter hint) → 5 example prompts → upload button somewhere. Federico wants: **prompt** → **upload area** → **examples** in that vertical order.

**Fix scope:** Reorder the Step 1 components on `/workers/new`. Trivial layout swap.

**Status:** OPEN

---

### #21 "Press Cmd+Enter to generate" hint is shown but the shortcut doesn't actually work

**Where:** `apps/web/app/workers/new/page.tsx`

**Federico:** "it says 'Command Enter', but this doesn't even work"

**Fix scope:** Wire the textarea's onKeyDown to detect `(e.metaKey || e.ctrlKey) && e.key === 'Enter'` → trigger Generate. Don't show the hint until the handler is wired.

**Status:** OPEN

---

### #22 Requirements UX should expose BOTH OAuth and API key per app when both exist

**Where:** `apps/web/app/workers/new/page.tsx` Step 2 "Set up requirements" + `apps/api/main.py` `_DRAFT_SYSTEM_PROMPT` / `requirements` projection

**Symptom:** PR D's fix has the LLM pick ONE method per app (OAuth XOR API key). Federico's prompt "Summarise Granola meetings, update HubSpot" now returns Granola=API-key + HubSpot=OAuth. Federico wants the USER to be able to choose between OAuth and API key for each app where both methods exist:
- Granola: both API key and Composio OAuth available
- HubSpot: both API key (MCP) and Composio OAuth available

**Federico:** "for both I should have both options, because they both offer API keys (MCP keys, whatever), and they also both have Composio connections."

**Fix scope:**
- Extend `RequirementItem` to: `{app, available_methods: ["oauth", "api_key"], preferred_method, reason}` instead of locking to one.
- Backend queries Composio catalog to discover which auth modes each app supports, AND uses a small static table for apps that have native API keys (Granola, etc.).
- Frontend renders each requirement as: `<app icon> <name> <toggle: OAuth | API key>`. Default selection = `preferred_method`. User can switch.

**Status:** OPEN — this REVERSES part of PR D's "one method per app" stance. Federico's intent is one method PER USER CHOICE, not one method enforced.

---

### #23 Cron trigger needs a visual scheduler, not a raw cron expression input

**Where:** `apps/web/app/workers/new/page.tsx` Step 2 trigger picker + `apps/web/app/workers/[id]/edit/`

**Federico:** "I should have a scheduler so I can actually just pick the cron instead of having to insert the cron code. Who knows this?"

**Fix scope:**
- Add a visual cron builder component. Common UX: dropdowns for `Every: [day, week, month, hour]` + `At: [time]` + `On: [days of week]`. Output the corresponding cron string under the hood.
- For power users: a "Custom cron expression" toggle that exposes the raw input.
- Library: probably easiest to write a small one from scratch since most cron-picker libs are heavy. Or use `react-js-cron`.

**Status:** OPEN

---

### #24 Connection event trigger picker is empty / unconfigured

**Where:** `apps/web/app/workers/new/page.tsx` Step 2 trigger picker

**Federico:** "For the connection event, I cannot choose anything. This is not proper yet."

**Fix scope:**
- Connection-event trigger needs: (a) pick a connected app, (b) pick a trigger type from that app's catalog (e.g. Gmail → "new message in label X", Slack → "new message in channel Y").
- Backend `composio_client.py` already has trigger catalog support via `GET /integrations/triggers`. Extend to filter by app slug.
- Frontend: when user picks "Connection event" as trigger type, render two dropdowns: app picker → event picker. Persist into `trigger.composio = {app, event_slug, config}`.

**Status:** OPEN — partially exists; needs UI polish to actually be usable.

---

### #25 Worker can be Python or Python+SKILL.md hybrid, not just agent skill

**Where:** `apps/web/app/workers/new/page.tsx` Step 2 worker mode picker

**Federico:** "Also, this worker could also be Python. It could have SkillMD plus Python or just Python with invocation of agent. I guess SkillMD plus Python is best, but yeah, way to go here."

**Fix scope:**
- Step 2 should expose `exec.mode` choices: `agent` (SKILL.md only), `pure-script` (run.py only), `hybrid` (run.py orchestrates + can call agent with SKILL.md when needed).
- Backend already supports the first two. "Hybrid" is conceptually `pure-script` + access to an agent helper. Probably needs a new helper in the E2B sandbox runtime.
- Frontend: radio group with explanation of each. Default = `agent`.

**Status:** OPEN — `hybrid` mode is a small new primitive in the runtime. Could ship the radio with `agent`/`pure-script` first, hybrid as a follow-up.

---

### #26 Platform secrets list is bloated; only OPENAI / E2B / COMPOSIO are mandatory

**Where:** `apps/api/main.py:2272` `PLATFORM_SECRETS` list

**Federico:** "for secrets like platform secrets, are OpenAI and E2B, right? Composio. I think these three are necessary, and the others are all for the workers themselves, right? These three are for the platform to actually work, right?"

**Current platform-config entries (after PR F):**
- COMPOSIO_API_KEY (required) ✓ platform
- COMPOSIO_WEBHOOK_SIGNING_KEY (required) ✓ platform
- E2B_API_KEY (required) ✓ platform
- FLOOM_SECRET (required) ✓ platform (it's the auth shared secret)
- WORKERS_FRONTEND_URL (required) → infra config, not really a secret
- FLOOM_DB / FLOOM_WORKERS_DIR / FLOOM_ARTIFACTS_DIR (optional) → infra paths, not secrets
- FLOOM_RUN_TIMEOUT (optional) → tuning knob

**MISSING:** OPENAI_API_KEY — currently treated as a worker secret because workers consume it, but it's also used by the platform itself for `draft-from-prompt`. Should appear on the platform list.

**Fix scope:**
- Reduce `PLATFORM_SECRETS` to truly platform-only: `OPENAI_API_KEY`, `E2B_API_KEY`, `COMPOSIO_API_KEY`, `COMPOSIO_WEBHOOK_SIGNING_KEY`, `FLOOM_SECRET`, `WORKERS_FRONTEND_URL`.
- Move FLOOM_DB / FLOOM_WORKERS_DIR / FLOOM_ARTIFACTS_DIR / FLOOM_RUN_TIMEOUT to a separate "Infrastructure paths" section (or drop them from the UI entirely since the user can never edit them).

**Status:** OPEN — also need to add OPENAI_API_KEY to the platform list (currently missing).

---

### #27 Real Floom logo, not generated "F" tile

**Where:** `apps/web/app/icon.tsx`, `apps/web/app/apple-icon.tsx`, `apps/web/components/Sidebar.tsx`

**Federico:** "let's use the real Floom logo and so on. You can get it from skills neo, for example."

**Fix scope:**
- Source: `~/skills-neo/` repo, look for the official logo (likely `apps/web/public/logo*` or `apps/web/components/Logo.tsx`).
- Replace the generated "F" `ImageResponse` in `icon.tsx` + `apple-icon.tsx` with the real SVG/PNG.
- Replace the sidebar's `<div>F</div>` brand mark in `apps/web/components/Sidebar.tsx` with the real logo (proper SVG component).

**Status:** OPEN — small UI polish.

---

## Round 2 Sequencing

12 new items, grouped into 5 PRs (mostly parallel-safe):

| PR | Scope | Issues |
|----|-------|--------|
| **PR H** | Worker card improvements: View/Edit buttons, drop runner label, show all triggers, last-run/usage stats | #16 #17 #18 |
| **PR I** | /workers/new layout + uploads: reorder Step 1, accept .py/.zip/folder, wire Cmd+Enter, mode picker (agent/pure-script/hybrid) | #19 #20 #21 #25 |
| **PR J** | Triggers UX: visual cron scheduler + connection-event picker actually works | #23 #24 |
| **PR K** | Requirements UX v2: per-app OAuth XOR API key TOGGLE (user choice, not LLM enforced) | #22 |
| **PR L** | Platform polish: real Floom logo (icon, apple-icon, sidebar) + reduce platform-secrets to mandatory three + add OPENAI_API_KEY | #26 #27 |

**Parallel lanes:**
- Lane 1 (worker UX): PR H → PR I (both touch /workers files, sequential)
- Lane 2 (creation flow): PR J → PR K (both touch /workers/new, sequential)
- Lane 3 (polish): PR L standalone

PR I and PR J have small overlap on `/workers/new` Step 1/Step 2 — handle in sequence, not parallel.

PR K is the most surprising one because it REVERSES PR D's stance: "one method per app" is wrong, the user wants to choose method per app.

**Total estimated effort:** 10-14 hours.

---

# Round 3 — 2026-05-26 evening walkthrough

After PRs #34-#45 landed and the sticky-sidebar/overflow fix shipped. Six more items (#28-#33).

---

### #28 Wrong Floom logo

**Where:** `apps/web/app/icon.png`, `apps/web/app/apple-icon.png`, `apps/web/public/floom-mark.png`, `apps/web/components/Sidebar.tsx`

**Federico:** "you chose the wrong old logo"

PR L pulled `floom-mark.png` from `/root/skills-neo/apps/web/public/`. Federico says it's not the right one. Need to identify the CORRECT current Floom logo source. Candidates:
- `/root/floom-minimal/` (canonical production Floom checkout)
- `~/floom-internal/` (private floom repo)

**Fix scope:** Find the right logo asset and replace icon.png + apple-icon.png + floom-mark.png + sidebar Image src.

**Status:** OPEN — needs Federico to point to the right asset, OR I find it via grep.

---

### #29 Move worker folders + tags from left sidebar to top filter bar

**Where:** `apps/web/app/workers/page.tsx`

**Federico:** "can the worker folders and tags pls be at top instead of sidebar"

Currently the /workers page has a 240px left aside with Folders + Tags (sticky, after the items-stretch fix). Federico wants this inline at the TOP of the page above the worker cards grid, freeing up the full width for the cards.

**Fix scope:**
- Drop the `lg:grid-cols-[240px_minmax(0,1fr)]` grid layout.
- Render Folders as a horizontal chip row at the top of the page below the h1.
- Render Tags as a wrapped chip row below the folders.
- The worker cards grid spans full width (`grid-cols-1 md:grid-cols-2 lg:grid-cols-3`).

**Status:** OPEN

---

### #30 One worker can have multiple files (not just SKILL.md + run.py)

**Where:** `apps/api/main.py` POST /workers, `apps/web/app/workers/[id]/page.tsx` Code tab, `apps/web/app/workers/[id]/edit/page.tsx`

**Federico:** "one worker can have multiple files, right?"

Worker dir on disk can already contain arbitrary files. PR I added `/workers/from-bundle` which accepts zip with multiple files. But the UI Code tab + Edit page only handle SKILL.md / worker.yml / run.py.

**Fix scope:**
- API: `GET /workers/{id}` includes `files: [{path, language, content}]` array listing ALL files in the worker dir.
- Frontend Code tab: render a file tree (left) + content viewer (right), or tabbed picker.
- Edit page: support adding/editing/deleting arbitrary files.

**Status:** OPEN

---

### #31 Webhook trigger doesn't show the webhook URL

**Where:** `apps/web/app/workers/new/page.tsx` Step 2 trigger picker + `apps/web/app/workers/[id]/edit/page.tsx`

**Federico:** "webhook option doesnt show a webhook url or so?"

When the user picks Webhook as trigger, the UI must surface:
- The webhook URL to POST to
- The HMAC signing secret
- A Copy URL button
- Optionally a Test webhook panel

**Fix scope:**
- Backend: generate / surface a unique URL + signing secret per worker. The DB already has `webhook_secret_hash` (`apps/api/db.py:110`).
- Frontend: render the URL + secret in a code box after worker creation, plus on the worker detail Run/Overview tab.

**Status:** OPEN

---

### #32 Connection-event UI feels broken / not polished

**Where:** `apps/web/components/ConnectionEventPicker.tsx` (PR J)

**Symptoms from screenshots (Images #20, #21):**
- Integration dropdown shows lowercase "gmail" not "Gmail"
- Event dropdown shows raw slugs `GMAIL_NEW_GMAIL_MESSAGE` in some views instead of human-readable "New Gmail Message Received Trigger"
- Technical metadata line `GMAIL_NEW_GMAIL_MESSAGE / ca_hl07t_hUuFjb...` leaks slug + connection_id to user
- Dropdown options visually overlap labels (z-index / overflow)
- Dropdown styling inconsistent between Integration and Event

**Federico:** "connection events feels broken on the ui?"

**Fix scope:**
- Use `appDisplayName(slug)` so "Gmail" appears in the Integration dropdown trigger (not "gmail").
- Use event `name` field for SelectItem label (e.g. "New Gmail Message Received"); hide raw slug.
- Drop the `GMAIL_NEW_... / ca_...` technical footer.
- Fix z-index / overflow so dropdowns don't visually clash.
- Make both Selects look identical (same component, same styles).

**Status:** OPEN

---

### #33 Multiple triggers per worker

**Where:** `apps/api/models.py` `WorkerContract.trigger`, `apps/web/app/workers/new/page.tsx`, `apps/web/app/workers/[id]/edit/page.tsx`

**Federico:** "why cant i have multiple triggers for one worker?"

Currently `trigger: {type, ...}` is a single object. A worker can only have one trigger.

**Fix scope:**
- Backend: change `trigger` to `triggers: List[WorkerTrigger]`. Accept both `trigger: ...` (single, legacy) AND `triggers: [...]` on input; canonicalize to list internally.
- Each trigger has its own config. Example:
  ```yaml
  triggers:
    - type: manual
    - type: schedule
      cron: "0 9 * * *"
    - type: webhook
    - type: composio
      composio:
        app: gmail
        event_slug: GMAIL_NEW_GMAIL_MESSAGE
        composio_connection_id: ca_...
  ```
- Frontend trigger picker becomes a list with "Add trigger" button. Each row has a type dropdown + type-specific config.
- Scheduler / webhook handler / composio-events handler iterate triggers to find matches.

**Status:** OPEN — biggest change in this round; probably its own PR.

---

## Round 3 Sequencing

6 new items, 4 PRs:

| PR | Scope | Issues |
|----|-------|--------|
| **PR M** | Right Floom logo + ConnectionEventPicker polish | #28 #32 |
| **PR N** | Top filter bar for /workers (drop left aside) | #29 |
| **PR O** | Multi-file worker support (file tree on detail + edit) | #30 |
| **PR P** | Webhook URL surfacing + multiple triggers (both touch trigger schema) | #31 #33 |

PR M, PR N, PR O are independent and can run in parallel. PR P is the heaviest because it changes the worker manifest schema.

**Total estimated effort:** 8-12 hours.

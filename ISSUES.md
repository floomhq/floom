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

---

# Round 3 follow-up — 2026-05-26 night

After PR C's marketplace modal shipped, Federico re-tested and found 4 more issues (#34-#37).

---

### #34 "Connect a tool" should be a full-screen page, not a popup

**Where:** `apps/web/app/connections/page.tsx` (PR C added a `Dialog`-based marketplace modal)

**Federico:** "should be able to see 'select a tool' pane full screen, not just pop up"

**Symptom (Image #23):** The "Connect a tool" modal is a small centered dialog. Browsing 1043 integrations in a small box is bad UX. With 35 pages of results, the user expects a proper marketplace screen.

**Fix scope:**
- Make the "Connect a tool" button navigate to `/connections/browse` (which already exists from earlier work as a full-page marketplace) instead of opening the modal.
- OR keep a modal but expand to `max-w-[90vw] max-h-[90vh]` so it visually fills the screen.
- Recommend the navigation approach (cleaner — `/connections/browse` already has the full-page marketplace UI).
- Make sure `/connections/browse` is reachable from `/connections` and has a Back link.

**Status:** OPEN — covered by PR Q.

---

### #35 Popular / Social / Data category filters return zero results

**Where:** `apps/web/app/connections/page.tsx` modal + `apps/web/app/connections/browse/page.tsx` + backend `/integrations/catalog?category=<x>`

**Symptom (Image #23):** Clicking "Popular" or "Social" or "Data" in the category chips shows "No integrations found".

**Root cause hypothesis:** The category labels (Popular, Productivity, Email, CRM, Social, Marketing, Data, Collaboration) are hardcoded in the frontend but Composio's catalog uses DIFFERENT category slugs (e.g. "ai-agents", "developer-tools", "team-chat", "scheduling-&-booking", "spreadsheets", "notes", etc., per the earlier `/integrations/catalog` smoke test).

When the user clicks "Social", the request becomes `?category=social` but no Composio app has category=social. Result: empty.

**Fix scope:**
- Either: (a) update the frontend tab labels to match Composio's actual category slugs (drop "Popular", use real ones).
- Or: (b) define a CLIENT-SIDE mapping: each top-tab maps to N Composio category slugs. E.g. "Email" → `["email", "messaging"]`, "Social" → `["social media accounts", "social"]`. Send to backend as comma-separated.
- Or: (c) just drop the category tabs entirely and rely on search (1043 apps is searchable by name).
- "Popular" is special — backend should expose a `?popular=true` flag that returns a curated list (top 20 by usage or hardcoded). For now, drop Popular and let users use search.

Recommend (b) for the existing labels + (c) for Popular.

**Status:** OPEN — covered by PR Q.

---

### #36 Multiple connections per app (different accounts)

**Where:** `apps/api/main.py` `initiate_connection` + `apps/web/app/connections/page.tsx`

**Federico:** "what if I want to add multiple gmail connections, different accounts?"

**Symptom:** Currently the system enforces one connection per `app_name`. Reconnecting an app overwrites the previous account. A user with two Gmail accounts (personal + work) cannot have both.

**Fix scope:**
- Allow multiple `composio_connections` rows with the same `app_name` (drop any unique constraint on app_name).
- UI on `/connections`: render multiple cards per app, each labeled with the account email/handle (already projected in `account_label`).
- "Connect another Gmail" button on each existing card OR within the marketplace modal.
- Trigger/worker config: when a worker references an integration that has multiple accounts, the user must pick WHICH account at trigger setup time. ConnectionEventPicker already has a Step 3 dropdown for this when `appConnections.length > 1` — verify it works.

**Status:** OPEN — covered by PR Q.

---

### #37 "Scopes unavailable" wording is still misleading

**Where:** `apps/web/components/connections/ConnectionCard.tsx`

**Federico (repeated):** "connections still say Scopes unavailable"

**PR B agent's earlier note:** Composio doesn't expose scopes for managed auth configs (this is the same as a Composio API limitation, NOT a workeros bug). But the wording "Scopes unavailable" is alarming and looks like an error.

**Fix scope:** Two options:
1. Try harder to get scopes — call the `GET /connections/auth-configs/{id}` endpoint (which PR B added) to fetch the auth_config's defined scopes. If the auth_config is "managed", it still has SOME scope definitions usually. Surface those.
2. If scopes truly can't be fetched, change the chip wording from red/alarming "Scopes unavailable" to neutral "Default scopes (managed by Floom)" or just hide the chip entirely.

Recommend trying #1 first (real fix) and falling back to #2 (better wording) when truly unavailable.

**Status:** OPEN — covered by PR Q.

---

## Round 3 follow-up sequencing

| PR | Scope | Issues |
|----|-------|--------|
| **PR Q** | Marketplace → full page (navigate to /connections/browse); fix category mappings; allow multiple connections per app; resolve scopes UX (real scope fetch + better wording) | #34 #35 #36 #37 |

PR Q overlaps with PR M (also touches connection UI). Land M first, then dispatch Q on top.

**Total estimated effort for PR Q:** 4-6 hours.

---

# ISSUES — Federico's 2026-05-27 walkthrough (post S18 design pass)

Raised verbally during a real browser walk of `workers.floom.dev` after merging S17 + S12-BE + S12-UI + S15 + S13 + S18. Status legend: OPEN / FIXING / FIXED / VERIFIED.

Screenshots referenced (need pulling from Mac): `~/Desktop/Screenshot 2026-05-26 at 22.19.14.png`, `22.22.35.png`, `22.39.21.png`.

## P0 — broken or seriously misleading

### I-1 — Generate hangs forever then empty error
- **Where:** `/workers/new`, after clicking "Granola → HubSpot daily" pill
- **What:** Click pill → textarea fills AND draft-and-create auto-fires → spinner forever → empty error toast → no worker created
- **Likely cause:** OpenAI timeout on the prompt OR an error path that swallows the message. Auto-submit on pill click compounds the bad UX (see I-9).

### I-2 — Worker detail page has no tabs (side-nav B not deployed)
- **Where:** `/workers/<id>`
- **What:** Spec is side-nav B (Run / Code / Triggers / Connections / Runs / Overview). Live page does not show this layout.
- **Action:** Inspect `apps/web/app/workers/[id]/page.tsx` vs the ASCII spec. Either S8 didn't refactor it or it regressed.

### I-3 — Settings "Appearance" tab lies about theme support
- **Where:** `/settings?tab=appearance`
- **What:** Body reads "Floom is light-only for now." FALSE — the sidebar already has a Light / Dark / System toggle (`ThemeModeButton.tsx`).
- **Fix:** Wire the actual theme toggle into the Appearance tab.

### I-4 — Settings API access design weird, no token shown, no way to get one
- **Where:** `/settings?tab=api`
- **What:** Current panel = `CliCommandPanel` with CLI/MCP/API sub-tabs. None expose the actual `x-floom-secret`. User has no idea how to obtain a token.
- **Fix:** "Your token" section at top with reveal / copy / rotate, THEN the setup snippets.

### I-5 — Cannot delete a worker
- **Where:** `/workers/<id>` and worker cards
- **What:** No delete affordance. API has `DELETE /workers/<id>`. UI doesn't expose it.
- **Fix:** Delete button on `/workers/<id>` (in a Danger zone of side-nav B), and a dropdown on worker cards.

### I-6 — Generate from prompt has no error diagnostic
- **Where:** `/workers/new`
- **What:** Same as I-1. Empty toast on failure. Surface the actual reason (rate limit / model error / etc.).

### I-7 — Overview "Connection expired" doesn't name the connection
- **Where:** `/`, "Needs attention" alerts
- **What:** Each alert reads "Connection has expired and needs re-authorization." No provider name, no logo. URL is right but the label is opaque.
- **Fix:** Backend `/system/overview` `needs_attention[]` already carries `connection_id`. Extend response to also include `provider_slug` + `provider_display_name`. UI renders name + logo.

### I-8 — Run detail page (`/runs/<id>`) not redesigned per spec
- **Where:** e.g. `https://workers.floom.dev/runs/run_4f661958b88e`
- **What:** Output-first layout, collapsibles, Edit / Re-run / Download top-bar — needs alignment with the ASCII spec.
- **Also:** Federico wants the ASCII spec REFRESHED before iterating.

### I-9 — Example pill click auto-submits Generate
- **Where:** `/workers/new`
- **What:** Pill click fills textarea AND fires draft-and-create. Should ONLY fill the prompt; user explicitly clicks Generate.
- **Fix:** `apps/web/app/workers/new/page.tsx` — remove the auto-call after setPrompt.

## P1 — quality / polish

### I-10 — Too many red error messages on Overview, panic-inducing
- **What:** 4 red Alert cards = the page reads as on fire. Most are "connection expired" which is recoverable.
- **Fix:** Use `default` Alert variant for connection-expired (informational). Reserve `destructive` for actual failures. Possibly collapse N connection-expired alerts into one summary row "3 connections need re-auth".

### I-11 — Worker card layout issues (Screenshot 22.19.14.png)
- **What:** Federico's screenshot flags a layout issue. Candidates: title truncation, "healthy" badge crowding the title, action icons crammed, sparkline mismatched with cards that have no runs.
- **Action:** Pull screenshot via `ssh mac` to know specifics.

### I-12 — Some connections still show "Federico" as account label
- **What:** `account_label` falls back to "federico" instead of `depontefede@gmail.com` for some rows. Sweep should refresh; some rows are missed OR the provider response shape doesn't include email reliably.
- **Fix:** Look at `_fetch_provider_email` for the affected providers; force a re-fetch.

### I-13 — Skeletons still too basic (S18 partial)
- **What:** After S18 shimmer, still too basic. Likely the shimmer is too subtle OR skeleton SHAPES don't match the content that lands, causing layout jump.
- **Fix:** Bump shimmer contrast. Audit each skeleton block to match its target card / row dimensions.

### I-14 — Edit worker looks different from View worker
- **What:** `/workers/<id>` and `/workers/<id>/edit` render differently. Either consolidate or align chrome.
- **Fix:** Per spec, side-nav B's Code tab IS the editable surface. Consolidate the two routes or align visual chrome.

### I-15 — Reload buttons everywhere — should auto-reload
- **What:** Manual "Reload workers" buttons in `/workers` and `/settings` System tab. Auto-reload already happens on mount.
- **Fix:** Remove manual buttons. Keep underlying `api.workers.reload()` calls for any cron auto-refresh.

### I-16 — Highlighted text on dark mode has white background
- **What:** Selecting text in dark mode shows a white selection background.
- **Fix:** Add `::selection { background: var(--accent-soft); color: var(--ink); }` to `globals.css`. Audit highlight.js usage.

### I-17 — `/workers/new` page needs more design polish
- **What:** Federico wants the hero card / upload / chips / typography reworked.
- **Action:** Discuss ASCII refresh, then iterate.

### I-18 — `/runs/<id>` ASCII spec needs refresh before iteration
- **What:** Update `docs/design/ascii-mockups-2026-05-27.md` with the run detail page spec. Get sign-off, then implement.

### I-19 — Some pages haven't been updated to match the ASCII spec yet
- **What:** Federico noted "the run page also has not been updated according to design changes." Need to audit each route against the locked spec.

## Order

Tackle order (small-to-impact, with bundling where it makes sense):

1. **I-9** (5 min): kill auto-submit on pill click.
2. **I-15** (10 min): remove manual reload buttons.
3. **I-3** (15 min): wire theme toggle into Appearance tab.
4. **I-4** (45 min): "Your token" section + reveal/copy/rotate in API access tab (need backend endpoint to fetch the secret hash or accept reveal via a separate authed call).
5. **I-7 + I-10** (30 min): overview alerts — name the connection, tone down to non-destructive.
6. **I-16** (5 min): selection styles in dark mode.
7. **I-2 + I-14** (1-2h): side-nav B on `/workers/<id>` (re-verify it's actually deployed) + consolidate view/edit.
8. **I-5** (30 min): delete affordance in side-nav B Danger zone.
9. **I-1 + I-6** (45 min): draft endpoint error path — surface real diagnostic; investigate why granola→hubspot hangs.
10. **I-11** (after viewing screenshot): worker card fix.
11. **I-12** (30 min): re-fetch account_label for connections still showing "federico".
12. **I-13** (20 min): bump shimmer contrast + audit skeleton shapes.
13. **I-17 + I-18**: refresh ASCII for `/workers/new` and `/runs/<id>`, then re-implement.
14. **I-19**: audit every route vs spec, fix gaps.

**Multi-agent audit waits until all P0 + the layout-eyes P1 items are addressed.**

---

# Round 5 production audit (2026-05-27, external auditor) — Score 52/100

## I-20 — CORS allows `http://localhost:3000` with credentials in prod (HIGH-4)
- **Status:** OPEN
- **Where:** every API endpoint preflight
- **What:** `Access-Control-Allow-Origin: http://localhost:3000` + `Access-Control-Allow-Credentials: true` + all HTTP methods including DELETE. Any malicious page running on `localhost:3000` (developer's machine) can make authenticated cross-origin requests with the user's `x-floom-secret` cookie/header.
- **Fix:** In `apps/api/main.py` CORSMiddleware allowed origins, drop `http://localhost:3000` for production deployments. Keep it for the dev environment only. Either gate by env var OR drop entirely (the frontend uses same-origin via `/api/proxy/...`).

## I-21 — `/uploads` accepts arbitrary files, no validation, no size limit (HIGH-5)
- **Status:** OPEN
- **Where:** `POST /uploads`
- **What:** Auditor uploaded `/etc/passwd`, a 20MB zero file, and an XSS HTML file. All accepted. Files aren't retrievable directly (good) but a malicious authed caller can exhaust disk.
- **Fix:** Backend MUST enforce:
  - Content-Type allowlist (csv, pdf, docx, txt, md, json, png, jpg, jpeg, webp)
  - Per-file size cap (e.g. 25 MB)
  - Total per-day upload cap per secret (e.g. 1 GB)
  - Reject obviously executable content (extensions: exe, sh, dll, js, php)

## Notes
- 28 vectors verified SAFE by Round 5: SQLi, command injection, path traversal, XXE, GraphQL, method override, response splitting, cache poisoning, host header bypass, TRACE, subdomain enumeration, ReDoS, prototype pollution, ZIP traversal, exposed config files, directory listing.
- Previous "SSRF via /connections/callback" + "Open redirect" + "/health unauth" are NOW verified SAFE (auditor reversed Round 4 findings — those endpoints are actually fixed-redirect / 403).
- Weekly_update worker has 100% failure rate today (2 runs, 0 completed). Not in audit scope but flagged.

---

# Federico 2026-05-27 round 2 walkthrough (after S19 batch 2 + line-clamp deploy)

## P0

### I-22 — Dark mode regressed. Bring back blue sidebar + sidebar DARKER than content
- **Status:** OPEN, urgent
- **What:** I read the S18 fix backwards. Federico explicitly wants:
  - **Sidebar = DARKER** than the main content area
  - **Sidebar keeps the blue accent tint** (he likes the blue, he said so explicitly during S18 review)
  - Main content brighter (use `--paper` not `--bg`)
- **Fix:** Revert `--sidebar-glass` in `html.dark` to include the accent tint AND drop the lightness. Pick a near-black for sidebar (e.g. mix `--bg` with a hint of `--accent`). Content uses `--paper` (#232323) which is brighter than `--bg` (#161616).

### I-23 — `/workers/new` Generate button doesn't work after example pill click
- **Status:** OPEN
- **What:** S19 I-9 changed the pill to ONLY set the prompt (not auto-submit). But now clicking Generate after that does nothing. Could be:
  - `isBusy` state is stuck
  - `getLivePrompt()` returns the textarea value but setPrompt doesn't propagate to it
  - Generate button is disabled by a wrong condition
- **Fix:** Inspect handleGenerate + setPrompt + the Generate button disabled prop. The pill should `setPrompt(ex.prompt)` AND the textarea should reflect the new value. Generate should fire on the updated value.

### I-24 — Worker detail `/workers/<id>` still has no tabs / no side-nav visible
- **Status:** OPEN, regression
- **What:** Federico: "I could not click on the worker cards. I can just click on run. They still don't have tabs at the top, like you didn't finish your work on the previous run."
- **Two things:**
  - **a)** Worker cards on `/workers` list — card body click does nothing. Only the "Run worker" button navigates. Card body should also navigate to `/workers/<id>`.
  - **b)** On `/workers/<id>`, the side-nav B rail is not visible OR the user reads it as "no tabs". Could be: side-nav uses hardcoded `bg-card` after the sweep but the rail collapses on narrow viewports, OR section-switching is broken.
- **Fix:** Make the worker card BODY a `<Link>` wrapper (with the Star + Run button as nested-but-isolated clicks). On `/workers/<id>`, double-check the side-nav rail renders at desktop width.

### I-25 — Workers page click → worker detail loads "super long"
- **Status:** OPEN
- **What:** Federico wants fast nav. /workers/<id> takes too long.
- **Fix:** Likely a slow API call on mount (probably `api.workers.get(id)` plus secondary calls). Either prefetch on hover OR cache the basic worker data from the list response so the page can render skeleton + then enrich. Or use Next.js `<Link prefetch>` if not already.

### I-26 — Hover / highlight feels "breaky" — too fast switching
- **Status:** OPEN
- **What:** Federico: "hovering above recent runs feels like everything is breaking, too fast switching between them".
- **Diagnosis:** Probably the hover background changes with no transition, OR the toast/refresh interval fires too often during hover, OR the row re-renders.
- **Fix:** Add `transition-colors duration-150` consistently. Don't refresh data while hovering (debounce or pause). Make sure hover doesn't trigger a layout shift.

## P1

### I-27 — Connections page needs search + active/explorer toggle
- **Status:** OPEN
- **What:** Federico wants ONE page that lists Active connections AND Available (explorer / catalog), with a toggle between them and a search box. Currently `/connections` and `/connections/browse` are two separate routes.
- **Fix:** Merge into `/connections` with a top tab row: `[Connected] [Explore]` + search input. Drop the separate `/browse` route or keep as alias.

### I-28 — Setup commands on /settings API access tab still look bad
- **Status:** OPEN
- **What:** Federico still calls it out as visually weak. The "Your token" reveal + the three CLI/MCP/API snippet tabs aren't compelling.
- **Action:** Need a redesign pass on CliCommandPanel — make the token block prominent (large mono), give the snippet boxes proper code-block styling with syntax highlighting, group the install + login commands into one combined `<pre>` block.

### I-29 — Appearance settings should match sidebar theme toggle visually
- **Status:** OPEN
- **What:** Federico: "appearance on settings has to align with what we have on the sidebar on the left side". Currently the Appearance tab shows the ThemeModeButton component as-is. He wants it to be the SAME visual as the sidebar toggle (or alternatively, make this the canonical control and remove the sidebar one).
- **Fix:** Either match style, or replace with a richer 3-option picker (System / Light / Dark cards).

### I-30 — `/runs` page didn't get any S12-UI updates
- **Status:** OPEN
- **What:** Federico: "the runs page just didn't change at all". The /runs list page still has the original layout, doesn't show the clickable rows + filter chips + sparkline header.
- **Fix:** Audit /runs page; align with the locked ASCII spec from `docs/design/ascii-mockups-2026-05-27.md`.

---

# Multi-agent UI roast findings (2026-05-27, fresh-context claude-virgin agents)

## Design + visual roast (grade C+)

### I-31 — `/connections/connect/<app>` Connect button INVISIBLE in light mode (P0)
- **What:** Primary Connect button renders as black bar with no visible label because the label colour token equals the button background. Provider logo also renders as a blank square.
- **Fix:** In `apps/web/app/connections/connect/[app]/page.tsx` the Button uses default variant. Inspect; the `--solid-fg` token might be miswired. Also BrandLogo for googlecalendar might be missing.

### I-32 — Worker detail "Worker not found" race condition (P0)
- **What:** First navigation to /workers/<id> from list flashes "Worker not found" + red "Failed to load worker: Failed to fetch" toast for ~500ms before API returns. First-time users see "deleted" and leave.
- **Fix:** Show a skeleton state while loading; never render the "not found" error UI unless the fetch ACTUALLY returns 404. Currently the "not found" renders during the loading state.

### I-33 — Mobile sub-nav crushes page on `/workers/<id>` (P0)
- **What:** At 375px, the secondary sub-nav (Run/Code/Triggers/Connections/Runs/Overview) takes a fixed 140px vertical column, crushing H1 to two lines and squeezing the run-form to 230px.
- **Note:** S19 batch 3 (PR #71) switched this to horizontal shadcn Tabs at the top — may already be addressed. Re-verify on mobile.

### I-34 — Connections list shows duplicate provider rows
- **What:** Two visually identical Google Calendar rows differentiated only by a 6-char hex suffix.
- **Fix:** Show the connected email/account_label as the primary distinguisher, hex suffix only as secondary.

### I-35 — Settings → Notifications placeholders in production
- **What:** Two toggles labelled "Soon" shipped to production users.
- **Fix:** Either remove the Notifications tab until email infra exists, or hide the toggles entirely behind a "Coming soon" message.

### I-36 — Token mask uses 60+ asterisks
- **What:** API token mask `••••••••••...` is much longer than the actual token, looks broken.
- **Fix:** Use the standard `XXXX...XXXX` pattern (first 4 + last 4 + 8 dots in middle). Already in `maskSecret()` — but the call site might pass the full secret unmasked then mask it weirdly.

### I-37 — Status / pill / card / button conventions inconsistent
- **What:** Same primitive rendered three different ways across `/workers`, `/runs`, `/connections`, `/settings`.
- **Fix:** Audit and unify. Use ONE shared `<StatusBadge>`, `<RunStatusGlyph>` (already exists in `components/RunStatus.tsx`); sweep callers to use them.

### I-38 — No skeleton/loading states anywhere
- **What:** Pages flip directly from empty to populated, creating the race condition in I-32.
- **Fix:** Add proper skeleton blocks on every page that fetches on mount. Sweep pages.

### I-39 — Cross-page label drift
- **What:** "Run worker" vs "Run". "Edit worker" vs "Edit". "Connect" vs "Connect a tool" vs "Connect to X".
- **Fix:** Pick one canonical phrase per verb. Document in a small style guide. Sweep.

### I-40 — Browse integrations grid: 30 identical Connect buttons
- **What:** Visual fatigue on `/connections/browse`. On mobile, description truncates to "Composio enables AI…" (also exposes the brand name we should be hiding).
- **Fix:** Reduce CTA visual weight in grid (use icon-only button or just border the card), expand on hover. Replace truncated copy.

### I-41 — Run-detail H1 uses slug, not display name
- **What:** /runs/<id> header shows `research_brief` (slug) while every other page uses "Research Brief".
- **Fix:** Use `run.worker_name` consistently. (S19 batch 3 may have already addressed via `worker.worker_name || worker.worker_id`.)

### I-42 — `/cli-auth` rendered inside full app chrome (security)
- **What:** OAuth/CLI consent surface shows the sidebar + nav. Should be a stripped-down centered card. Also shows no scopes, no expiry, no client fingerprint.
- **Fix:** Move /cli-auth out of the main layout (use a route group with its own layout), centre the consent card, show scopes/expiry/fingerprint.

## Functional + interaction roast (grade C+)

### I-43 — Settings Theme has TWO competing controls (P0)
- **What:** Sidebar footer Light/Dark button AND Settings → Appearance toggle. Both labelled with the current theme, NEITHER updates when the other is clicked. Federico's "align the appearance with sidebar" complaint exactly.
- **Fix:** Both must read + write the SAME state source (localStorage key `floom-theme` already used by ThemeModeButton). The Appearance tab embeds the same component now (after S19 batch 1) — verify they share state. The "doesn't update" bug means re-mount doesn't read localStorage, OR the click handler doesn't propagate.

### I-44 — `/settings → Danger zone → Clear runs` is single-click nuke (P0)
- **What:** Type-to-confirm exists for delete-worker but NOT for clear-all-runs. Click → all runs gone. Cannot undo.
- **Fix:** Add type-to-confirm "DELETE ALL RUNS" in the same pattern as the worker delete.

### I-45 — Every primary CTA renders as BOTH `<a>` and `<button>` (P1)
- **What:** `<Link><Button>...</Button></Link>` pattern creates doubled DOM and doubled screen-reader noise.
- **Fix:** Either:
  - Switch Button to use Radix Slot pattern + `asChild` prop (requires bumping the @base-ui/react/button to a version that supports it), OR
  - Render `<a className={buttonVariants({...})}>` via shadcn's `buttonVariants` helper directly.
- Sweep call sites.

### I-46 — Filter / search / pagination state not URL-synced
- **What:** /runs filter, /workers search/folder (partially synced post-S12), /connections/browse state — all component-local. Reload kills the view.
- **Fix:** URL-sync everything user-controlled.

### I-47 — Failed runs lose the Transcript tab
- **What:** The exact tab you need to debug a failure is hidden when there is a failure.
- **Note:** S19 batch 3 retired the Tabs in favour of collapsibles — transcript is a collapsible now. Verify it shows for failed runs.

### I-48 — Worker > Connections > Configure routes to wrong path
- **What:** "Configure" goes to `/settings` instead of `/secrets` or `/connections`.
- **Fix:** Find the link target on the worker detail Connections section and update.

### I-49 — `/connections/browse` Connect opens silent new tab
- **What:** No pre-confirm; already-connected providers aren't flagged → user has accidentally created two Google Calendar tokens.
- **Fix:** All Connect clicks route through `/connections/connect/<slug>` (already exists). Mark already-connected providers in the browse grid.

### I-50 — Stat cards on Overview look clickable but aren't
- **What:** Cards have hover styles + cursor changes but no destination.
- **Fix:** Either wire each card to drill-in (Runs 24h → /runs?since=24h, Active workers → /workers, Connections → /connections) OR remove the hover/cursor styles.

### I-51 — Tag click on Worker card dumps into search with no indicator
- **What:** Clicking a tag silently filters via search box but doesn't show "Filtered by tag: X" affordance.
- **Fix:** Show an active-tag chip above results with an `X` to clear.

---

# 2026-05-29 P0 fixes

## B1 — /contexts/<name> shows "Knowledge pack not found" (VERIFIED 2026-05-29)

**Reported:** 2026-05-29 by Federico. `/contexts/worker-author-style` showed "Knowledge pack not found." even though the pack existed.

**Root cause (from chrome-devtools + journalctl evidence):**
`GET /api/proxy/contexts/worker-author-style` returned HTTP 500. The browser's `fetchJson` threw, the `useEffect` caught it and toasted, `detail` stayed null, page showed "Knowledge pack not found."

The upstream 500 was NOT the proxy — it was the FastAPI `_context_detail()` in `apps/api/main.py` throwing:
```
TypeError: ContextDetail() got multiple values for keyword argument 'worker_count'
```
`ContextSummary` has `worker_count` and `description` fields. `_context_summary()` returns a `ContextSummary` with `worker_count=0`. `model_dump()` includes both fields. Then `_context_detail()` passed them AGAIN as explicit kwargs → Python duplicate-kwarg crash.

**Fix:** Set `summary.worker_count = len(used_by)` and `summary.description = description` before `model_dump()`, then remove the duplicate kwargs. PR #221.

**Status:** VERIFIED — PR #221 merged + deployed (SHA 75db6435). `/api/proxy/contexts/worker-author-style` returns HTTP 200 with 9 files + `used_by: [Worker Author]`. Page renders correctly, console clean.

## B2 — /workers/new cold navigation "This page couldn't load" (VERIFIED 2026-05-29)

**Reported:** 2026-05-29 by Federico. `/workers/new` showed "This page couldn't load" on first click from the sidebar (console: `net::ERR_NETWORK_CHANGED` / 404 on a JS chunk).

**Root cause:** `net::ERR_NETWORK_CHANGED` is a browser/OS-level event triggered when the machine's network interface changes (VPN connect/disconnect, interface swap) mid-request. It is NOT a code bug. The page loads cleanly in every fresh isolated browser context.

**Fix:** No code change required. The page loads correctly on every cold navigation. Verified in multiple fresh isolated browser contexts — all chunks return 200, console clean.

**Status:** VERIFIED — multiple cold navigations in isolated contexts confirmed. No code change shipped.

## B15 — /contexts pages render files flat instead of a navigable folder tree (VERIFIED 2026-05-29)

**Reported:** 2026-05-29 by Federico. "context needs nested folders ofc? not just root level." The backend already stores nested paths (e.g. `worker-author-style` has `EXAMPLES/csv-enricher.yml`, `EXAMPLES/github_digest.yml`, `SCHEMA.md`), but the contexts UI rendered every file as a flat list — no folders, no drill-in, no way to create a file in a subfolder.

**Root cause:** UI gap only. The pack-detail page (`apps/web/app/contexts/[name]/page.tsx`) mapped `detail.files` directly into a flat list. The backend (`main.py`) already supported nesting: `PUT /contexts/{name}/files/{file_path:path}` writes slash-separated paths, and `POST /contexts/{name}/upload` accepts an optional `path_prefix` form field.

**Fix (frontend only, PR #226):**
- Pack-detail page groups files by path prefix into folders. `EXAMPLES/` renders as a folder (file count + size + chevron); root files sit at top level. Breadcrumb folder navigation via `?path=EXAMPLES` — click a folder to drill in, click a breadcrumb segment to go back up. Deep nesting (`a/b/c.md`) handled; empty-folder state with a back-to-root link.
- "New file" dialog accepts a path with slashes (e.g. `SOP/onboarding.md`) and creates it nested via the existing `saveTextFile` (PUT) call; prefilled with the current folder; drills into the new folder after creation.
- Upload lands files in the current folder via `api.contexts.upload(..., pathPrefix)` → backend `path_prefix`.
- File-preview route (`files/[...path]/page.tsx`) breadcrumb splits the nested path into clickable folder segments linking back to the pack-detail folder view.
- `main.py` untouched. ChatGPT-simplicity bar: single blue accent, no emoji, monochrome icons, sentence case.

**Status:** VERIFIED on prod — PR #226 (squash 05b9fce) merged to main, Vercel production build SUCCESS, `workers.floom.dev` aliased to `workeros-mp6egsupd`. Browser-broker walk on `/contexts/worker-author-style`: (1) `EXAMPLES` renders as a folder ("6 files · 9.6 KB") with the 3 root `.md` files at top level — not flat. (2) Drill-in to `?path=EXAMPLES` shows exactly the 6 YAML files, breadcrumb "Files > EXAMPLES". (3) Breadcrumb "Files" click returns to root. (4) Created `SOP/onboarding/welcome.md` via the dialog (deep nesting) — persisted to disk at `contexts/worker-author-style/SOP/onboarding/welcome.md`, file count 9→10, UI drilled into `?path=SOP/onboarding`, download href `.../files/SOP/onboarding/welcome.md`. (5) File-preview breadcrumb shows "Contexts / worker-author-style / SOP / onboarding / welcome.md" with SOP+onboarding as clickable links. Test file cleaned up afterward (pack back to 9 files). Screenshots: `/tmp/b15-1-pack-detail.png`, `/tmp/b15-2-file-preview-breadcrumb.png`.

**Out of scope (noted, not a regression):** the file-preview LEFT sidebar remains a flat file list by design. B15 scoped tree nav to the pack-detail page + nested breadcrumbs on the preview route, both delivered.

## B5 — /approvals is a flat list; breaks down at scale (VERIFIED 2026-05-29)

**Reported:** 2026-05-29 by Federico. "approvals: what if i need multiple? this has to be organised?" `/approvals` rendered every pending approval as a flat stack of cards — fine for 1-2, a wall of cards at 20+.

**Root cause:** UI gap only. The page (`apps/web/app/approvals/page.tsx`) mapped the pending list straight into a flat `space-y-3` column. No grouping, no sort, no pagination, no per-card age. The backend `GET /approvals` already returns all pending rows (sorted oldest-first), so organisation is purely a frontend concern.

**Fix (frontend only, PR #227):**
- **Group by worker** — collapsible section headers with per-worker count (e.g. "Outbound approval demo (3)"). 20 pending across 3 workers reads as 3 groups.
- **Sort** — Newest (default), Most waiting (oldest-first; groups ordered by their oldest member, most-urgent first), By worker (alphabetical).
- **Pagination** — 20/page, "← Previous / Page N of M / Next →" matching the `/runs` pattern; same worker re-groups correctly across page boundaries.
- **Per-card age** — "pending Nm/Nh/Nd" on each card. Oldest pending + anything >6h emphasised in amber (sets up the future soft-deadline C5; no auto-expiry).
- **Light bulk** — per-group "Select all" → "N selected" bar with Approve/Reject; only appears on groups ≥2. Calls the existing per-run `approve`/`reject` endpoints in sequence (no backend change).
- Standalone page + "Go to platform" links + deep-link `?id=` (now jumps to the containing page + highlights) preserved.
- `main.py` and the approve/reject/count endpoints UNTOUCHED — zero conflict with the backend-correctness lane. ChatGPT-simplicity bar: single blue accent, sentence case, no emoji, no nested cards.

**Status:** VERIFIED on the PR preview deploy — PR #227 (squash 197f6ff) merged to main, Vercel build SUCCESS. Verified against the live prod backend using 6 synthetic pending approvals across 3 workers (staggered ages incl. 8h), then 16 more to cross the 20/page threshold (22 total). Confirmed grouping, all 3 sorts, pagination (Page 2 of 2, Next disabled on last), per-card age + amber stale emphasis, and per-group bulk select→approve/reject. All 22 synthetic rows cleaned up afterward (backup at `/tmp/floom-backup-apprvorg-*.db`); `/approvals` back to "No pending approvals" + badge gone. Typecheck + eslint clean on the changed file. Screenshots: `/tmp/apprv-default.png` (grouped newest), `/tmp/apprv-mostwaiting.png` (most-waiting + amber), `/tmp/apprv-bulk.png` (bulk bar), `/tmp/apprv-page2.png` (pagination).

## B7 — worker-card tool-icon strip rendered empty white boxes (VERIFIED 2026-05-29)

**Reported:** 2026-05-29 by Federico (screenshot). Worker cards on `/workers` showed empty white boxes top-left instead of tool logos. Reference target = Langdock workflow cards: a horizontal row of real colored app logos with a "+N" overflow chip. Two problems: (1) logos rendered empty, (2) the strip was a detached box floating above the avatar.

**Root cause:** `BrandLogo` (`apps/web/components/connections/BrandLogo.tsx`) resolves logos via an SVG sprite (`<use href="#brand-<slug>">`), but `IconSprite` — which registers the `#brand-*` / `#icon-*` symbols — was only mounted in `ConnectionsClient`. On `/workers` the symbols were absent in the DOM, so every `<use>` resolved to nothing → empty box. (Even slugs that HAD a symbol, like github, were blank because the sprite was simply not on the page.)

**Fix (frontend only, PR #229):**
- **Root cause** — mount `IconSprite` once in the root layout (`apps/web/app/layout.tsx`) so symbols resolve on every route; removed the redundant per-page mount in `ConnectionsClient` (avoids duplicate symbol IDs).
- **Robust logos** — `BrandLogo` now normalizes Composio slugs internally (single source of truth via exported `normalizeBrandSlug`), carries brand colors for slack/linkedin/whatsapp/openai/apify/apollo, routes the AI mark (anthropic/cursor/windsurf/continue) to `#icon-*`, and renders a clean lettered glyph for unknown slugs — never an empty box.
- **New sprite symbols** — added SimpleIcons `brand-whatsapp`, `brand-openai`, `brand-apify`, `brand-google-docs/sheets/meet`.
- **Placement** — moved the strip from the detached top position to a quiet Langdock-style logo row under the worker description (before tags); skeleton updated to match. `WorkerToolStrip` renders the AI mark via `BrandLogo` and uses the shared `normalizeBrandSlug` (dropped its duplicate alias map). "+N" overflow chip kept.

**Status:** VERIFIED on prod — PR #229 (squash 70fa75a) merged to main, Vercel production build SUCCESS, `workers.floom.dev` aliased to `workeros-21ksvgz6o`. Browser-broker walk of the live `/workers` grid: zero empty boxes anywhere; GitHub Digest Sender shows the GitHub logo + orange anthropic AI mark (was 2 empty boxes); Weekly Update shows the AI mark (was 1 empty box); Gmail Intake Brief shows the red Gmail logo; CSV Enricher / Research Brief show the AI mark; workers with no connections (Node Smoke Test, OpenBlog, Environment Variables) correctly render no strip. Static proof render confirmed slack/hubspot/notion/calendar/drive/linkedin/whatsapp/openai/apify logos + "+N" overflow + lettered "Z" fallback for an unknown slug. Typecheck (exit 0) + production build clean. Screenshots: `/tmp/prod-before.png` (empty boxes), `/tmp/prod-after.png` + `/tmp/prod-after-scrolled.png` (real logos), `/tmp/proof-after.png` (full coverage proof).

## Batch B — overview + workers-list defects (from `docs/audits/all-issues-discovery-2026-05-29.md`) (VERIFIED 2026-05-29)

PR #243 (merged to main). Worktree `/tmp/wk-batchB-overview` off `66d1fa5`, rebased onto `origin/main` pre-merge (no conflicts), `gh auth=federicodeponte`, `baseRefName=main`. Backend deployed via `ops/deploy-api.sh` (HEAD `b516b71` → SHA `57a1754`, health ok, migration v38, schema OK). Frontend aliased `workers.floom.dev` → `workeros-ofqrf9dtr` (custom alias is NOT auto-assigned by push). Screenshots in `docs/audits/shots-batchB-2026-05-29/`. Scope respected: did NOT touch `/workers/<id>`, `/runs`, `/connections`, `/contexts` (other batches).

### P1-5 — overview alert duplicated label "Missing secret: Missing secrets: …"
**Root cause:** `_overview_failure_cause` (`apps/api/main.py`) built `{humanized error_code}: {message}`. For `error_code="missing_secret"` (→ "Missing secret") the message already carried its own prefix ("Missing secrets: …"), producing the doubled label.
**Fix:** when the message already leads with the (loose alnum-matched) humanized code, return the message alone; otherwise keep the prefix. Targeted, not blanket.
**Status:** VERIFIED LIVE — `GET /api/proxy/system/overview` causes read `Missing secrets: SLACK_BOT_TOKEN, LINEAR_API_KEY, …` (single prefix) for kugelaudio-bug-intake + kugelaudio-meeting-pipeline; `Interrupted by restart: …` correctly KEEPS its prefix. Confirmed in the rendered AlertsBell dropdown. Screenshot: `docs/audits/shots-batchB-2026-05-29/02-overview-alerts-dropdown.png`.

### P1-6 — workers-list "+25 more" tag expander did nothing on click (carried regression)
**Root cause:** `apps/web/app/workers/WorkersClient.tsx` rendered "+N more" as a non-interactive `<span>`.
**Fix:** button toggling a `showAllTags` state ("+N more" ↔ "Show less"); the tag list expands inline.
**Status:** VERIFIED LIVE — broker pool-e click on `/workers` expanded the row from 16 → all 38 tags; button became "Show less". Screenshot: `docs/audits/shots-batchB-2026-05-29/03-workers-tags-expanded.png`.

### P1-10 — internal "Node Smoke Test" worker exposed in the operator Operations catalog
**Root cause:** `node-smoke-test` is a runtime-proof dev artifact (PUBLIC_STOCK_WORKER) but had no `system_worker` flag, so it appeared in `/workers` + overview.
**Fix:** `system_worker: true` in `workers/node-smoke-test/worker.yml` (same treatment as workspace-agent / worker-author; field already filtered by `_list_operator_workers` + `GET /workers`).
**Status:** VERIFIED LIVE — `GET /api/proxy/workers?shape=list` 15 → 14 workers, `node-smoke-test` ABSENT; still present with `?include_system=true`. `/workers` grid (broker) shows no Node Smoke Test card.

### P1-11 — "Coming up today" rendered scheduled worker names with strikethrough (reads as cancelled)
**Root cause:** `OverviewDashboard.tsx` applied `line-through` whenever `item.paused`; strikethrough on an upcoming item reads as cancelled/done.
**Fix:** removed the strikethrough; paused items now use muted text + a distinct "Paused" pill, normally-scheduled items render as plain primary text.
**Status:** VERIFIED LIVE — all upcoming items (Invoice Email Processor, GitHub Digest Sender, GitHub PR Summary, GitHub PR and Issue Digest) render with normal non-struck text. Screenshot: `docs/audits/shots-batchB-2026-05-29/01-overview-desktop.png`. (No currently-paused worker is in the upcoming feed to photograph the new pill; the strikethrough-on-normal defect is gone.)

### P2-13 — stale cross-view run status (Overview "Running" while /runs "Completed")
**Root cause:** `useOverview` skipped the client fetch whenever server-fetched `initialData` was present, so a run that finished after SSR stayed "Running" on `/overview` forever.
**Fix:** revalidate silently on mount even with `initialData` (no skeleton flash) + re-fetch on window focus, so cross-view status stays current.
**Status:** VERIFIED LIVE — `/overview` "Worker activity" shows all "Completed" (green) runs, consistent with `/runs`. Screenshot: `docs/audits/shots-batchB-2026-05-29/01-overview-desktop.png`.

### P2-14 — mobile (375) theme-toggle is an oversized outlined circle in the top bar
**Root cause:** `.theme-mode-button-compact` (mobile top bar) kept the base `.theme-mode-button` border, pill radius and drop shadow, so it rendered as an outlined circle next to the borderless 44×44 search/menu icons.
**Fix:** restyled the compact variant to a borderless 44×44 icon button with transparent bg and a 20px glyph, matching its siblings.
**Status:** VERIFIED LIVE — CDP 375px emulation on pool-e: top bar shows search + theme + hamburger at identical icon size, no outlined circle. Screenshot: `docs/audits/shots-batchB-2026-05-29/M01-overview-mobile.png`.

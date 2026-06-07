# ISSUES (Federico's 2026-05-26 morning walkthrough)

Status legend: OPEN / FIXING / FIXED / VERIFIED. Issues raised by Federico from a real browser walkthrough of workers.floom.dev after PRs #29-#33 landed.

---

## 2026-06-07 Live Test Issues

### FL1 — Federico private workers hidden by role-aware visibility

**Status:** VERIFIED

**Symptom:** Federico's workers appeared gone in the UI even though `/root/workeros/data/floom.db` still contained 100 worker rows, including 99 private rows owned by `federico`.

**Root cause:** The role-aware visibility path did not map Federico's real local login session back to the legacy engine owner id `federico`, and DB-owned private workers were suppressed when their IDs matched filesystem/internal worker filters.

**Fix:** Worker list/detail now resolve the local-default legacy owner for worker access while keeping the auth account identity unchanged. DB-owned workers are no longer hidden by filesystem fallback filters.

**Verification:** Focused backend tests passed (`46 passed`). Live FastAPI `GET /workers?include_system=true&include_archived=true` against `/root/workeros/data/floom.db` returned 100 workers, including 99 private `federico` workers with owner permissions, for both `x-floom-secret` and a Federico session-shaped auth context. Worker DB counts remained `100 total / 99 federico / 100 private / 88 local-default / 12 empty workspace`.

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

# Deep backend audit — 2026-06-05 (new untracked backend issues)

These are new backend findings from `docs/audits/deep-backend-audit-2026-06-05.md`. The existing file already had `I-50` and `I-51`, while the audit request referred to M1-M49; this section continues the requested M-series.

### M50 — P1: Non-first webhook triggers can bypass webhook authentication
- **Where:** `apps/api/main.py:7597`, `apps/api/main.py:7624`, `apps/api/main.py:7633`
- **What:** `_worker_has_webhook_trigger()` can accept a worker because `triggers_json` contains a webhook, but `webhook_trigger()` enforces signature only from `config.trigger.webhook`. For multi-trigger manifests, `config.trigger` is `triggers[0]`.
- **Impact:** If the webhook trigger is second after a schedule/manual trigger, POST `/webhooks/{worker_id}` without token/signature can create a run.
- **Status:** OPEN

### M51 — P1: Live `mode=draft` worker-author call persisted a worker
- **Where:** live prod behavior; local handoff route starts at `apps/api/main.py:3836`
- **What:** `POST /workers/new/from-prompt` with `mode:"draft"` completed run `run_a0836db867db` and returned output with `created_worker_id:"text-character-count"`. Logs said the drafted bundle was registered. Probe worker was deleted and verified gone.
- **Impact:** Draft/review mode mutates persistent worker state.
- **Status:** OPEN

### M52 — P1: `/workers/new/from-prompt` bypasses draft and run-create throttles
- **Where:** `apps/api/main.py:3836`, contrast `apps/api/main.py:3960` and `apps/api/main.py:4769`
- **What:** The worker-author route validates prompt/mode, then calls `create_run()` and `start_run()` directly. It does not call `_enforce_draft_rate_limit()` or `_enforce_run_create_quota()`.
- **Impact:** Expensive worker-author runs can be spammed; one simple live prompt took 88.136s and used OpenAI + multiple E2B sandboxes.
- **Status:** OPEN

### M53 — P2: Worker-author slow path is real and caused by full smoke/repair validation
- **Where:** live prod behavior; local worker output declared at `workers/worker-author/worker.yml:83`
- **What:** Live run `run_a0836db867db` completed, but only after LLM generation plus generated-worker smoke, repair, and second smoke. Poll observed terminal state at 90.0s.
- **Impact:** User-facing generate flow can sit near or above 90s even when healthy, conflicting with the quick draft UX.
- **Status:** OPEN

### M54 — P2: Worker-author references missing `RUN_PY_TEMPLATE.py`
- **Where:** `workers/worker-author/SKILL.md:42`, `workers/worker-author/run.py:353`
- **What:** The worker-author instructions and prompt builder reference `contexts/worker-author-style/RUN_PY_TEMPLATE.py`, but that file is absent from `contexts/worker-author-style/`.
- **Impact:** Script-mode generation silently loses a referenced run.py template guardrail.
- **Status:** OPEN

### M55 — P2: Run detail returns `input={}` while UI exports it as full-fidelity debug data
- **Where:** `apps/api/main.py:5113`, `apps/api/main.py:5175`; UI expectation at `apps/web/components/RunDetailSplitPane.tsx:474` and `apps/web/components/RunDetailSplitPane.tsx:556`
- **What:** `GET /runs/{run_id}` hardcodes `input={}` for every run, even though the UI raw/metadata views include `run.input` in their debug/export payload.
- **Impact:** Users cannot inspect the actual run inputs when debugging failures or exporting run evidence.
- **Status:** OPEN

### M56 — P2: `/workers/from-bundle` has no uncompressed zip limits
- **Where:** `apps/api/main.py:4345`
- **What:** The endpoint limits compressed request body size and blocks traversal/symlinks, but it does not cap uncompressed size, file count, per-file size, or cumulative extracted bytes before `zf.read(zip_name)` writes files to disk.
- **Impact:** A small auth-gated upload can expand into a large worker directory and consume disk/CPU.
- **Status:** OPEN

## [2026-06-05] Deep UI walk triage (N1–N27, doc: deep-ui-walk-2026-06-05.md)
- **N1 (P0) No Emily CHAT UI in the web app** — `/assistant` is config-only (Instructions + Final-prompt tabs); no message thread/input. Emily reachable only via API/Slack/MCP, not the dashboard. VERIFIED (no chat components in apps/web). Investigate: regression vs never-built; if regressed, restore; if scope question, flag Federico.
- **N2 (P1) Live persona polluted with Codex build-note** ("Source note... pass 2 brief... worktree") — readable by authed users. VERIFIED in GET /workspace. pass-3 (M31 persona→global) must write a CLEAN persona; verify after it lands and scrub if still present.
- **N4 — FALSE/INVALID:** walk claimed gpt-5.4-mini "isn't a real model"; it IS (verified live, Emily replies on it). Disregard.
- **N6 — DUPLICATE of M49** (junk/test workers in catalog; ~5 obvious: b12-live-worker-051059, bundle-test, test, emoji-test, outbound-approval-demo). Cleanup queued.
- **N3 (P1) High failure rate** (~290 failed/24h reported) — likely the pre-fix from-prompt temperature failures; re-measure after the from-prompt fix + pass-3 settle.
- **Real frontend N-issues → UI fix lane:** N5 (Overview→/ route), N7 (missing-secret quick-fix CTA), N8 (webhook placeholder looks real), N10/N11 (brain pack "0 attached" while 2 packs; pack w/ 0 files but 2 workers), N13 (Last-used blank pre-load), N17 (Cmd-K vs sidebar nav inconsistency), N23 (share modal clips under sidebar @1280), N25 (Save shown w/ no edits), N27 (run "Edit" misleads to source editor). N18/N7 (needs-attention has no reason shown).

## [2026-06-05] Federico live-test batch (M57–M67) — DOCUMENTED before changes
- **M57 (P1) Connection OAuth callback dumps to the Sign-in page.** After connecting a tool, `workers.floom.dev/api/proxy/connections/callback?status=success` renders the "Enter your access secret" sign-in screen instead of returning to /connections — session lost on the OAuth round-trip. [Image #123]
- **M58 (P1) Connected tool does not appear in connections.** Connected Outlook; it does not show up in the connections list (connection didn't persist or isn't rendered).
- **M59 (P2) Connection adding is slow.**
- **M60 (task) MCP list is EMPTY — add MCP server(s) for Federico and TEST that MCP adding actually works end-to-end.**
- **M61 (P2, UI) "Add MCP server" should DEFAULT to the JSON-config paste, not the "enter details" form.**
- **M62 (P1, UI) Visibility Share→Private switches instantly — must show a CONFIRM modal** before changing visibility (breaks shared links). Applies to visibility changes generally.
- **M63 (P1, UI) Version rollback uses the browser/device-native confirm dialog — must use the app's OWN designed modal**, not `window.confirm`.
- **M64 (P1, UI) Worker-detail SOURCE view must match the Brain view: preview on the left, raw on the right (same toggle/layout).** Current YAML preview "makes no sense", shows too much underlying info — wants a cleaner, prettier rendering. Must be consistent with Brain.
- **M65 (P1, UI) run.py and requirements.txt have NO preview on worker detail, but Brain files do.** Inconsistent — add preview, align everything (source views == brain views).
- **M66 (verify→answer) Persona location.** CONFIRMED: a global base persona EXISTS in engine code (`chat_service.py:38 EMILY_BASE_PERSONA`) — so M31 (global) is done at the code level. BUT the live `workspace.md` (user layer) STILL holds the full polluted v5 (incl the "Source note" build-note) = redundant + polluted (N2 still live). pass3-verify lane is scrubbing it; MUST ensure v5's substance is preserved in the global base before removing it from workspace.md (so v5 isn't lost). The "final prompt looks short" needs the lane to confirm the assembled prompt (global base + workspace.md + SKILL.md).
- **M67 (answer) Version roll-forward = YES.** 20 versions preserved in history; rollback is append-only (`rollback_workspace_instructions` main.py:17485 doesn't delete forward versions). So you CAN restore the version you were on (v24) after rolling back to v23. (Pairs with M63: needs the app's own modal, not browser dialog.)

## [2026-06-05] M68 — Persona = TWO separate layers (Federico refinement)
The persona/system-prompt must be TWO clearly-distinct, separately-editable things in UI + backend:
1. **Base system prompt** — Workeros ships a proper DEFAULT (our `EMILY_BASE_PERSONA`); the user can ADJUST/override it (edit the base). "Adjusting what we have right now."
2. **Workspace instructions** — ADDITIONAL rules the user layers ON TOP of the base. "Adding rules."
Assembled prompt = (base, default=ours, editable) + (additional workspace instructions) + SKILL.md. UI must show both as separate fields/editors with the distinction obvious (adjust-the-default vs add-on-top). Supersedes the single workspace.md model; pairs with M31/M66. Backend = split storage + assembly; UI = two editors. Versioning (M67) applies to both.

## [2026-06-05] Chat prototype — APPROVED direction (Vercel AI Elements), iterate:
Federico: "chat looks fine by me, make it more digestible, easy to digest, but it looks very native to shadcn/prompt-kit so stick to what I have 100%." + "file upload has to be possible" + "fully work on this on the branch." So: keep AI Elements 100% native, increase digestibility (lower density), ADD file upload, stay on the emily-chat-prototype branch.

## [2026-06-05] M69–M71 (Federico) — DOCUMENTED before changes
- **M69 (URGENT) Deploy loop blocks the app from deploying; Vivek pushed a fix to main.** Investigate the loop CAREFULLY (take time), verify Vivek's fix on main, THEN deploy — for the Cloud version. (Cloud + Workeros must stay in sync — the Cloud-sync lane is on this.)
- **M70 (feature) Brain items need shareable UNINDEXED links** (noindex), same mechanism as the per-approval shareable links (M12). A "generate link" / share action on brain files/packs that produces a non-search-indexed shareable URL.
- **M71 (P1, design) Emily chat prototype does NOT align with the app's design system.** It adds icons we don't need/use and doesn't use the designs we DO use. KEEP the AI Elements agentic STRUCTURE (Tool/Task/Approval composition) but RE-SKIN to the Workeros design system: our icons, our card styles, our tokens — drop AI Elements' default chrome/icons. (Refines the earlier "stick to AI Elements 100%" — structure yes, default look no.)

## [2026-06-05] M71 specifics (chat prototype design-system alignment) — Federico
- **Markdown NOT rendering:** assistant text shows raw `**bold**` and list syntax instead of rendered markdown [Image #125]. Wire the proper markdown renderer for message content.
- **Icons not ours:** AI Elements decorative icons (e.g. the blue sparkle on cards [Image #126]) don't match our design system. Replace with OUR icons (match the app's lucide/icon usage); drop AI Elements default chrome icons.
- **Brand logos for connections:** "Connect Gmail" must use the real Gmail logo (and Slack→Slack, Stripe→Stripe, GitHub→GitHub) sourced as real SVGs (SimpleIcons/svgl/gilbarbara per logos rule) — NOT generic icons or text-in-circles.
- **Em dashes** in the mock conversation text — remove (Emily = zero em dashes), even in mock data.

## [2026-06-05] M72 + audit Rounds 5-20 reconcile (Federico, 600+ probes)
- **M50 trigger-reconciliation: CLOSED** — Vivek fixed `update_worker` (now calls reconcile_triggers_conn). Also closes webhook-rotate-after-PATCH (same root cause). Auth trailing-space: now strict-compared (closed, belt-and-suspenders).
- **M72 (P0, SECURITY) 64 dependency vulns in 18 packages** — CRITICAL: authlib JWT forgery (CVE-2026-27962)→≥1.6.12, pyjwt algo-bypass+SSRF→≥2.13.0, python-multipart DoS→≥0.0.27, cryptography buffer-overflow→≥46.0.7, lxml XXE→≥6.1.0, +13 more. JWT-forgery/algo-bypass = auth-bypass class = HARD launch blocker. Upgrade engine apps/api deps (Cloud picks up via engine bump). CAREFUL: auth/crypto-critical deps — test auth/JWT after.
- **Remaining P1s:** Composio-crash-without-key 502→needs graceful 503 (fold into bug-pass); draft-and-create 422 (improved from 500, acceptable); approval-system "by design"→needs DOCS (not a bug — document the approval model).

## [2026-06-05] CLOUD launch-readiness: 35/100 BLOCKED (5 P0s) — docs/CLOUD_LAUNCH_READINESS_2026-06-05.md
- **C-P0-1 (SECURITY, live tenant-data leak) Anonymous Supabase/PostgREST reads expose Cloud tenant data** — `asset_versions` + `workspace_agent_settings` readable by anon (an RLS policy `USING(true)` grants public roles, not service-role-scoped). Multi-tenant data exposure. Fix RLS (service-role-scope / force RLS). URGENT.
- **C-P0-2 Dashboard 508 NOT actually fixed** — apex AND dashboard alias both still HTTP 508 INFINITE_LOOP (the earlier CLI-deploy fix did not hold / alias didn't move to the fixed build).
- **C-P0-3 Vercel TEAM_ACCESS still blocks the git deploy** (Vivek not a team member) — the fix must ship via CLI (token-authored) and the alias reassigned.
- **C-P0-4 Engine sync stale** (Cloud pins b30c53f, OS is 06cf0a9) + the unsafe cloud-engine-sync branch reintroduces web/vercel.json — must rebase on the 508 fix.
- **C-P0-5 Cloud API deps unresolvable** — supabase==2.15.3 conflicts with openai-agents==0.17.4; can't even audit the Cloud API's 64-vuln set until resolved.

## [2026-06-05] Federico live-walk batch (workeros.floom.dev) — DOCUMENTED before changes
- **Emily v5 — CONFIRMED CORRECT (not a bug):** design-doc v5 (emily-persona-research-2026-06-04 §3) IS canonical (no richer version hidden in past sessions — verified via transcript grep). PR #443 (merged) wired it faithfully: `EMILY_BASE_PERSONA` = v5 generic (tenant-safe, first-person "I'm Emily"), `workspace.md` = Federico context incl "Workers are your swarm", `SKILL.md` double-identity line trimmed. Live OS API serves v5 behavior (bare greeting leads with workspace state, no "Let me check"). Reaches live Cloud via the convergence engine bump.
- **M73 (P0) Worker creation times out — FIXED/DEPLOYED (engine PR #447, squash `e4df683`):** root cause was the `/workers/new` prompt UI falling back from async `POST /workers/new/from-prompt` into legacy sync `POST /workers/draft-and-create`, where `gpt-5.5` codegen plus smoke/gate work can exceed the 60s Next/Vercel proxy `maxDuration`. The page also hardcoded `/api/proxy` for SSE instead of the configured proxy base. Fix: prompt creation is async-only after `newFromPrompt`; SSE paths use the configured API proxy and preserve workspace query state. OS API deployed via `/opt/workeros-api-deploy/ops/deploy-api.sh`, then `systemctl restart workeros-api`; active process cwd `/opt/workeros-api-deploy/apps/api`, repo SHA `e4df683`, health ok. Live verification: `POST https://workers-api.floom.dev/workers/new/from-prompt` returned run ids in `0.253s` and `0.285s`; the background codegen runs took `92.555s` and `177.564s`, proving the timeout-prone work is no longer on the HTTP request path. Both generated workers were deleted after verification. Separate follow-up: worker-author smoke quality still produced disabled workers in those probes, unrelated to the HTTP timeout root cause.
- **M74 (P0) Worker detail infinite loop — FIXED/DEPLOYED (Cloud PR #87 `403cfd5`, PR #88 `9df73dd`; engine submodule `e4df683`):** two root causes. First, exact Cloud worker lookups were scoped to the active workspace cookie; with stale/default workspace `ws_aac663b43cb542`, the owned worker in `ws_b79e570aad8349` missed and surfaced as a not-found/bad-state detail. Second, Cloud middleware hardcoded `/app/login` while the dashboard runs under Next `basePath=/app`, producing Vercel `508 INFINITE_LOOP` in the authenticated browser path. Fix: `SupabaseWorkerRepository.get()` now retries exact id + owner on an active-workspace miss, and Cloud middleware strips/adds `/app` once while redirecting to internal `/login`. Cloud dashboard prod deploy `dpl_DRXeHuz6PQbqSaHzqdk2VFbZCXsz`; Cloud API restarted on `/opt/workeros-cloud-deploy` at `9df73dd`. Live route check now redirects once to `/app/login?next=...` and returns HTTP 200, no `x-vercel-error: INFINITE_LOOP`. Deployed repo probe with stale workspace found `granola-hubspot-meeting-actions`; public Cloud API detail request with a temporary token returned the worker detail, and the token was deleted.
- **M75 (P0) "Run not found" — FIXED/DEPLOYED (Cloud PR #87 `403cfd5`, PR #88 `9df73dd`; engine submodule `e4df683`):** root cause was the same exact-detail workspace scoping bug for runs. The real run exists in Cloud Supabase as `run_8290101e249b`, worker `granola-hubspot-meeting-sync`, status `failed`, duration `4436ms`, workspace `ws_b79e570aad8349`; stale/default workspace context made `runs.get()` return not found. Fix: `SupabaseRunRepository.get()` now retries exact run id + owner after an active-workspace miss. Cloud API deployed and restarted; deployed repo probe with stale workspace found `run_8290101e249b` with status `failed`. Public Cloud API detail request with a temporary token returned the run detail (`failed`, `4436ms`) and the token was deleted. Public deep link now redirects once to login and returns HTTP 200 instead of looping. Authenticated browser screenshot is pending Federico completing the broker login handoff.
- **M76 (P1, UI) Tool/app logos missing — FIXED (PR #446, merged 947bb0f):** worker cards + popular-workflow cards + overview activity/coming-up lists showed generic trigger glyphs not app logos. Now: real brand logos derived from `WorkerSummary.connections` (data-driven), real Granola SVG added (granola.ai official marque, not fabricated). Reaches live Cloud via convergence bump.
- **Inline prompt-text tool highlight — DONE (PR #442, merged d700d1f):** known tool names in prompt text get an inline brand icon + faint badge; Granola now shows its real logo (via #446).
- **M77 (cleanup) Duplicate junk workers** — 3 near-identical "Granola to HubSpot Daily Meeting" workers (Emily created dupes). M49-class cleanup; fold into a dedupe pass after the P0s.

## [2026-06-05] Federico live-walk batch 2 (connections/channels) — DOCUMENTED before changes
- **Emily v5 — CONFIRMED LIVE on Cloud (not just merged):** Cloud API restarted 22:39 CEST, after engine bumped to e4df683 (v5) at 21:36; deployed chat_service.py has the v5 "I'm Emily" persona. The assistant#prompt tab serves v5 live. (Definitive yes.)
- **M78 (P1, FEATURE — main complaint) No proper Slack/WhatsApp onboarding.** assistant#channels has only a barebones Slack form (paste Channel ID manually); WhatsApp absent entirely from the codebase. Wants guided Slack + WhatsApp onboarding, reachable from the landing directly. Build: Slack OAuth -> live channel-picker (no manual ID); WhatsApp mechanism TBD (Composio? Twilio? OpenClaw gateway — scope first, flag if it needs a Federico decision). Lane dispatched.
- **M79 (bug) apex /connections/* 404.** workeros.floom.dev/connections/browse = 404, /connections = 404 (apex, no /app); /app/connections/browse = 307 works. Bare links don't resolve into the dashboard. Fix: apex redirect /connections,/connections/* -> /app/<same>. Lane dispatched.
- **M80 (perf) "Redirecting to Composio" slow.** Root cause CONFIRMED: apps/web/app/connections/redirect/page.tsx hardcodes setTimeout(redirect, 3000) — a 3-second artificial delay. Fix: redirect as soon as the auth URL is ready. Lane dispatched.

## [2026-06-05] Federico live-walk batch 3 (account / mcp / brain / sharing) — DOCUMENTED before changes
NOTE: 4 screenshots referenced (Mac Desktop paths) could NOT be retrieved (ssh mac down). M82/M84 are screenshot-only — working from descriptions; M82 needs Federico to name the control.
- **M81 (bug) Account does not show my email.** The account section/footer does not display the signed-in user's email. (Screenshot 13.38.03)
- **M82 (P1 bug) "these dont do anything" — VIEWED:** the connections-table row "⋯" Actions menu items **Test connection / Refresh status / Disconnect** are all dead on click. Lane dispatched (connections-detail).
- **VIEWED-PRECISION (2026-06-05, screenshots now readable via sshfs):** M81 = the connection ROW shows "account …ea71f1" (internal id) not the email + stuck "Connecting" (separate from the now-fixed sidebar footer email). M84 = the worker "Add tool" app picker is a plain TEXT dropdown, no brand logos (separate from the now-fixed MCP-server-add JSON). M86 = worker Share is a cramped modal with a raw hash token, not a Floom-style standalone page (standalone-share lane covers it).
- **M83 (UX, REPEATED feedback) MCP connections should default to JSON, not a form** — https://workeros.floom.dev/app/connections/mcp — MCP servers are configured via JSON; the add UI must default to a JSON config input. Federico gave this before; not delivered. OWN IT.
- **M84 (UX) "add a tool" UI sucks** (Screenshot 13.39.23) — likely the MCP/tool add form; make it JSON-based + clean. (Could not view screenshot.)
- **M85 BRAIN / CONTEXT cluster:**
  - M85a (P0 bug) **brain attach throws HTTP 500 on Cloud.**
  - M85b (bug) download a brain file -> {"detail":"Context not found"} (confusing/broken). Source: apps/api/main.py + workeros-cloud/apps/api/routes/context_previews.py.
  - M85c (UX) drag-drop a file into the brain should JUST WORK and auto-create a pack if none exists (auto-name it). Currently can't just drop a file.
  - M85d (feature) **standalone noindex share links for individual FILES** (like the approvals shareable links / M12) — currently can only share a pack, not a file standalone; and even pack sharing "links to the platform" rather than being a true standalone page. Wants standalone noindex pages. (Expands M70.)
  - M85e (feature) brain/context is **read-only — wants WRITE** (add/edit files).
- **M86 (UX, REPEATED feedback) Worker-card share page is weird; must match the Floom share reference** — target design: https://floom.dev/s/fls_A7lOwwSGOct63FCNC_-4CWlryYf8VddxfTCRxsmVk10 . Federico gave this reference BEFORE; I did not pick it up. The worker share + all standalone share pages (worker/brain-file/pack) should look like that Floom standalone share page. OWN IT — build against the reference this time.

## [2026-06-07] Federico live-test FL3 + FL5 — DOCUMENTED before changes
- **FL3 (P1 auth/cloud) Cloud login returns to home after sign-in.** Root cause in this checkout: the Next proxy forwarded proxied `/auth/login` responses without preserving upstream `Set-Cookie`, so the `wos_session` cookie created by FastAPI could be lost at the browser boundary. Also no OSS `/auth/login` page existed in `apps/web/app`, leaving the expected post-login copy/redirect implicit. Fix in progress: proxy forwards cookies both ways, successful `/auth/login` returns `redirect_to: "/overview"`, and the web login page copy is "Sign in to your Workeros workspace" with successful sign-in navigating to `/overview` or a safe local `return_to`.
- **FL5 (P1 brain upload) 1.4 MB image returned raw "Request body too large"; first upload flaky without a folder.** Root cause in this checkout: the Next proxy streamed only exact `/uploads`, so `/contexts/{name}/upload` was buffered; the backend had a 25 MB generic `/uploads` cap but no Brain-specific friendly limit, and missing Brain folders only auto-created when the client sent `create_if_missing=true`. Fix in progress: context uploads stream through the proxy, Brain upload limit defaults to 25 MB with friendly 413 copy, missing folders auto-create by default, and the Brain UI creates a new user folder when only system/read-only packs exist.

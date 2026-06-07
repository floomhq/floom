Issues are tracked in GitHub Issues: https://github.com/floomhq/workeros/issues

---

# Historical ISSUES.md Content

# ISSUES (Federico's 2026-05-26 morning walkthrough)

Status legend: OPEN / FIXING / FIXED / VERIFIED. Issues raised by Federico from a real browser walkthrough of workers.floom.dev after PRs #29-#33 landed.

---

## P0 bug pass M73/M74/M75 (2026-06-05)

**Scope:** live Workeros product paths on `workeros.floom.dev` (Cloud wrapper) and `workers.floom.dev` (open-source surface), both backed by the Workeros engine.

**Status:** FIXING

### M73 — worker creation times out

**Root cause:** the prompt create UI already had an async engine endpoint, `POST /workers/new/from-prompt`, that starts the `worker-author` run and returns a `run_id`. The page still fell back to the legacy synchronous `POST /workers/draft-and-create` path whenever the async start failed before a run id. That synchronous path performs LLM codegen and smoke/gate work inside the HTTP request. The binding limit on the frontend proxy path is 60 seconds (`apps/web/app/api/proxy/[...path]/route.ts`, `maxDuration = 60`; Cloud overlay has the same value), while uvicorn has no shorter request cap in the service unit and only a graceful shutdown timeout of 85 seconds. A slow `gpt-5.5` codegen attempt can therefore exceed the proxy budget and surface `Request timed out. The server took too long to respond.` The same create page also hardcoded `/api/proxy` for SSE, bypassing Cloud's configured `/app/api/proxy` base path.

**Fix:** the prompt create flow is now async-only after `newFromPrompt`; it no longer re-enters `draft-and-create` for prompt generation. Run SSE URLs now use the configured API proxy base and include the active workspace query parameter for EventSource clients.

**Evidence:** local web verification passed: `npm test` (`27 passed`), `npm run lint` (`0 errors`, existing warnings only), and `npm run build` (`Compiled successfully`, TypeScript complete). Live verification will be appended after merge/deploy.

### M74 — worker detail infinite loop / stale workspace detail miss

**Root cause:** unauthenticated `curl -I` to the reported Cloud URL returned a login redirect, not Vercel `x-vercel-error: INFINITE_LOOP`. The worker id `granola-hubspot-meeting-actions` exists in Cloud Supabase as an exact `workers.id`, owned by Federico's user in workspace `ws_b79e570aad8349` (`fede-production`). Federico also has an older/default workspace `ws_aac663b43cb542`. The Cloud Supabase repository scoped exact `workers.get()` by the active workspace context first. When a stale/default workspace cookie was active, the exact slug deep link missed the row and returned `Worker not found` even though the user owned the worker.

**Fix:** Cloud-only repository patch: on a workspace-scoped miss, `SupabaseWorkerRepository.get()` retries by exact worker id plus owner `user_id`. This does not widen cross-user access and leaves list queries workspace-scoped.

**Evidence:** targeted Cloud tests passed (`python3 -m pytest tests/test_supabase_repos.py -q`, `4 passed`). Patched local Cloud repository lookup with active workspace forced to `ws_aac663b43cb542` returned `worker_found=True` for `granola-hubspot-meeting-actions`. Live verification will be appended after merge/deploy.

### M75 — run detail says Run not found

**Root cause:** the failed run exists in Cloud Supabase: `run_8290101e249b`, worker `granola-hubspot-meeting-sync`, workspace `ws_b79e570aad8349`, status `failed`, duration `4436ms`, error `Server disconnected`. The run appears in workspace-scoped activity lists when the browser sends the active workspace header, but an exact run detail lookup scoped to a stale/default workspace cookie misses the row and returns `Run not found`.

**Fix:** Cloud-only repository patch: on a workspace-scoped miss, `SupabaseRunRepository.get()` retries by exact run id plus owner `user_id`. This mirrors the worker deep-link fix and does not expose other users' runs.

**Evidence:** targeted Cloud tests passed (`python3 -m pytest tests/test_supabase_repos.py -q`, `4 passed`). Patched local Cloud repository lookup with active workspace forced to `ws_aac663b43cb542` returned `run_found=True`, `run_id=run_8290101e249b`, `run_status=failed`. Live verification will be appended after merge/deploy.

**Audit:** `docs/P0_BUGPASS_2026-06-05.md`

---

## Backend pass 3 - multi-tenant, capabilities, codegen self-check (2026-06-05)

**Scope:** M31 persona-global, M32/M33 brain and connection write permissions, M39 WhatsApp per-sender routing, #E2 generated-worker example self-check, and M41 Slack greeting copy.

**Status:** VERIFIED

**Fix:** commit `be7ff47a1df176e1e97e06d3a4999da90f6900eb` moves Emily's immutable base persona into engine code, keeps editable workspace instructions custom-only, adds `workspace_agent_settings` capability gates, adds `whatsapp_sender_bindings` with claim flow, enforces manifest `example_input`/`example_output` in worker smoke gates, and updates Slack Chief-of-Staff greeting copy.

**Verification:**
- Local verification: API py_compile passed, `git diff --check` passed, full API suite passed twice after the final patch/rebase (`561 passed, 185 warnings`), frontend build passed, frontend lint passed with 0 errors and 21 existing warnings.
- Codex review found and the commit fixed five issues: WhatsApp claim UI wiring, numeric sample type, Emily direct worker manifest smoke bundle, settings base-path preservation, and manifest `example_input` use with `example_output`.
- Deployed once with `ops/deploy-api.sh`; service restarted. The script's `/health` gate passed, then its `/healthz` assertion exited with `got 000000`; direct post-deploy `/healthz` returned 200 and the script was not rerun.
- Public `/health` returned HTTP 200 with DB/disk/E2B/OpenAI/Composio all `ok`; systemd service `workeros-api` was active.
- Active production working directory `/opt/workeros-api-deploy/apps/api` verified at SHA `be7ff47a1df176e1e97e06d3a4999da90f6900eb`; deployed tracked paths matched `origin/main`.
- M31 prod: after replacing `/workspace` with custom-only `PASS3_CUSTOM_TOKEN`, `/system/workspace-agent` still contained `You are Emily` and `Chief-of-Staff`; `/chat` streamed `p3test-pass3-chat-ok`; original workspace content restored.
- M32/M33 prod: live tool list changed with settings flags; read-only mode exposed brain/connection reads and hid writes/adds; write/add mode exposed `brain__write`, `contexts__write`, `connections__add_mcp` and hid read tools as configured; original settings restored.
- M39 prod: unbound WhatsApp sender got a claim link and zero workspace route; two bound sender IDs routed to distinct `p3test-user-a` / `p3test-user-b`; all test rows deleted.
- #E2 prod: logically wrong `p3test-median-wrong` and `p3test-sum-wrong` workers smoke-failed; correct `p3test-median-ok` smoke-passed; all test workers deleted and follow-up GETs returned 404.
- M41 prod: monkeypatched deployed Slack handler emitted exact greeting: `I'm Emily, your personal Chief-of-Staff. I route tasks to a swarm of always-on agents and workers. DM me or @mention me.`

**Audit:** `docs/audits/backend-pass3-2026-06-05.md`

---

## P0 — from-prompt new-worker flow failed on gpt-5.x temperature (2026-06-05)

**Scope:** `POST /workers/new/from-prompt` → worker-author meta-worker in E2B; gpt-5.x model compatibility.

**Status:** VERIFIED

**Root cause:** the from-prompt path sent non-default `temperature` values to gpt-5.x models from two places: `workers/worker-author/run.py` (`temperature=0.2`) and `apps/api/runner_sandbox/skill_driver.py` (`temperature=0.5`). gpt-5.x models reject those values with HTTP 400. The draft-and-create path already had retry-without-temperature protection; from-prompt did not.

**Fix:** commit `093e9c3e166f8cb8c52e58041e2d69b9d3abae43` adds retry-without-temperature handling to worker-author and skill-driver, adds focused regression tests, removes the unused `WORKER_AUTHOR_DEFAULT_MODEL` env override, and updates stale codegen docs to reference `WORKEROS_CODEGEN_MODEL`.

**Verification:**
- Deployed via `ops/deploy-api.sh`; active systemd working directory `/opt/workeros-api-deploy/apps/api` verified at SHA `093e9c3e166f8cb8c52e58041e2d69b9d3abae43`.
- External `/health` returned HTTP 200, `status: ok`.
- Prod from-prompt runs completed and produced workers:
  - `run_f7c47c53541d` → `fp-temp-word-char-0605030601`, smoke `passed`.
  - `run_69c82681681f` → `fp-temp-number-stats-0605030601`, smoke `passed`.
  - `run_bcb6743ec0c0` → `fp-temp-granola-hubspot-0605030601`, connection prompt, smoke `skipped` because it was not script-mode, creation did not hard-fail.
- Draft-and-create regression returned HTTP 200: `fp-temp-draft-create-0605031004`, smoke `passed`.
- All `fp-temp-*` test workers were deleted; follow-up GETs returned 404 and final list scan found none.

**Audit:** `docs/audits/fromprompt-temperature-fix-2026-06-05.md`

---

## Backend pass 2 - model split, Emily v5, sharing, Phase G (2026-06-05)

**Scope:** model split, full conversation storage, persona v5, worker short links, MCP tool creation, per-approval public read links, and control-character rejection for secret values.

**Status:** VERIFIED

**Verification:**
- Final deployed SHA `25b29603d8adc23963ae2f255f3a9bb21987f133`; deploy health `ok`, migration version 55.
- Production process env verified `WORKEROS_CHAT_MODEL=gpt-5.4-mini` and `WORKEROS_CODEGEN_MODEL=gpt-5.5`.
- `/system/workspace-agent` returned 200 with model `gpt-5.4-mini`, 31 tools, and `mcp_tools__list/register/update/delete`.
- `/chat` verified Emily identity and proactive bare greeting behavior with no em/en dash in final text.
- Production codegen on `gpt-5.5` drafted and created `p2test-codegen-temp-fix`; runs `run_9a614b0db803` and `run_b1545a385c08` completed with expected scalar reverse outputs.
- Conversation storage probe kept 55 production rows while prompt history returned 50.
- Short-link probe minted `fls_hosacSIW5y`; public resolver and `/s` alias returned only allow-listed worker fields.
- `/mcp/tools` create/list/delete worked, and MCP JSON-RPC `tools/list` included the created tool.
- Signed public approval GET returned a single pending approval with no `owner_id` or `public_link`; bad token returned 401.
- Secret values containing newline, tab, and NUL returned 400.
- `p2test-codegen-temp-fix` was deleted; follow-up GET returned 404; DB counts for p2test workers, short links, MCP tools, approvals, and runs were 0.

**Audit:** `docs/audits/backend-pass2-2026-06-05.md`

---

## P0 — wedge flow (G5-confirm #269, 78/100): "describe a job → get a worker" did NOT create a worker

### #W1 Prompt-to-worker dead-ended on a drafted bundle (2026-05-29)

**Where:** `/workers/new` → `newFromPrompt({mode:"draft"})` → worker-author meta-worker → `out/bundle.json`; `apps/web/app/workers/new/page.tsx`, `apps/api/run_service.py`, `apps/api/main.py`, `workers/worker-author/run.py`.

**Symptom:** Typing a plain-English job + Generate ran the worker-author meta-worker, which drafted `out/bundle.json` inside its E2B sandbox but never registered a worker (`run.py` always set `created_worker_id=None`). The catalog count never incremented; the UI landed on `/runs/<id>` (a run with a bundle, Back/Replay/Download only) — no editable, runnable worker. The only path that created a real worker was the error fallback.

**Fix (PRs #271, #272, #273 — chosen approach A, backend post-completion registration; preserves the live drafting stream):**
1. Backend hook on worker-author run completion (`run_service._register_authored_worker`) reads the drafted bundle and registers it via the SAME path `/workers/draft-and-create` uses (shared `main._register_worker_from_files`); stores `created_worker_id` on the run output + broadcasts via SSE. Idempotent; dedupes colliding ids; skips broken bundles.
2. Frontend navigates to `/workers/<id>?edit=1` on completion; on mid-flight SSE drop it polls the run to terminal (bounded) instead of stranding the operator on `/runs/<id>`.
3. Backend safety-net `_normalize_authored_worker_yml` strips optional metadata (use_cases/tags) that violates the canonical `WorkerContract` schema, so a functionally-valid drafted worker always registers (live-found: LLM emitted <3 use_cases → 400).
4. Backfilled `run.py` stub now satisfies the E2B pure-script contract (writes `result.json`) so a created worker is RUNNABLE (live-found: old stub used legacy `run(inputs,context)` with no `__main__` → `missing_result`).

**Live verification (workers.floom.dev, fresh browser, deployed `b3e97bd`):**
- Catalog incremented 13 → 14 → 15 → 16 across 3 prompts ("GitHub PR summary", "email deduplicator", "daily motivational quote") — no duplicate workers.
- Editor opened at `/workers/<id>?edit=1` for every prompt (worker.yml + run.py/SKILL.md present).
- Worker RAN: `run_eaa068a9f95b` (daily-motivational-quote) completed in 6.7s, 1 output item + 1 file.
- Screenshots: `docs/audits/shots-wedge-P0-2026-05-29/` (01-prompt-typed, 02-drafting-stream, 03-editor-opened, 04-editor-second-prompt, 05-worker-ran-completed).
- New worker ids: `github-pr-summary-2`, `email-deduplicator`, `daily-motivational-quote`.

**Status:** VERIFIED (2026-05-29)

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

## Batch D — /contexts file viewer + /workers/new drag-drop (from `docs/audits/all-issues-discovery-2026-05-29.md`) (VERIFIED 2026-05-29)

PR #242 (merged to main `57a1754`, rolled up under `8b0a674`). Worktree `/tmp/wk-batchD-contexts` off `66d1fa5`, rebased onto `origin/main` pre-merge, `gh auth=federicodeponte`, `baseRefName=main`. No backend touched (all frontend) → no `ops/deploy-api.sh`. Frontend aliased `workers.floom.dev` → `workeros-hnnypgguw` (custom alias is NOT auto-assigned by push). Screenshots in `docs/audits/shots-2026-05-29/batchD-verified/`. Scope respected: did NOT touch `/workers/<id>`, `/runs`, `/connections`, `/overview` (other batches); only `/contexts` + `/workers/new`.

### P0-2 — context file viewer rendered NO content on direct nav / refresh / shared "Copy link"
**Root cause:** in `apps/web/app/contexts/[name]/files/[...path]/page.tsx`, the file-text `useEffect` depended on the `selectedFile` OBJECT, which `detail?.files.find(...)` rebuilds with a NEW reference every render. On a URL-seeded load `detail` is null on first paint → `selectedFile` null → effect early-returned; once `detail` resolved, the unstable reference re-ran the body with `setText("")` racing the resolved fetch → blank pane (a race; sometimes content won, hence intermittent).
**Fix:** key the effect on a STABLE primitive (`loadableTextPath` = the resolved path when it is a previewable text file) + an abort guard, so it fires exactly once per file and loads the URL-seeded file on first load.
**Status:** VERIFIED LIVE — 3 fresh direct loads in a clean broker context (`/contexts/worker-author-style/files/SCHEMA.md`, `ANTI-PATTERNS.md?v=2`, `?v=3`) all render full content immediately. Screenshot: `docs/audits/shots-2026-05-29/batchD-verified/P0-2-FIXED-schema-direct-load.png`.

### P2-11 — context-file Preview code blocks faint grey (low contrast)
**Root cause:** prose's default `--tw-prose-pre-code` / inline-code colour rendered as faint grey on the light `bg-muted` block in `MarkdownRenderer`.
**Fix:** force fenced-code (`prose-pre:text-foreground prose-pre:[&_code]:text-foreground`) and inline-code (`prose-code:text-foreground`) to full-contrast foreground in both themes.
**Status:** VERIFIED LIVE — `# BAD`, `client = OpenAI(...)`, `exec: secrets:` render as dark high-contrast text on light bg-muted; inline `run.py` / `SKILL.md` / `exec.secrets` readable. Screenshot: `docs/audits/shots-2026-05-29/batchD-verified/P2-11-code-contrast-desktop.png`.

### USED BY → top metrics row (Federico Image #17)
**Ask:** on the pack-detail page, "Used by: <worker>" should sit in the top metrics row (Files / Workers / Size), not as a separate section below.
**Fix:** in `apps/web/app/contexts/[name]/page.tsx`, render the used-by worker names as an inline chip in the top metrics row; removed the standalone section (kept only the empty-state hint).
**Status:** VERIFIED LIVE — top row reads `Files 9 · Workers 1 · Size 20.9 KB · Used by Worker Author` (clickable); no separate section below. Screenshot: `docs/audits/shots-2026-05-29/batchD-verified/usedby-top-row-pack-detail.png`.

### /workers/new drag-and-drop files (Federico)
**Ask:** the `/workers/new` prompt box should accept dropped files (bundle zip / worker folder / .md / .py).
**Fix:** made the hero card a dropzone (`onDragOver`/`onDragLeave`/`onDrop` + `dragActive` overlay) routing through the existing `handleFiles` path. Additive — the textarea + Upload button are unchanged.
**Status:** VERIFIED LIVE — synthetic `dragover` (zip in dataTransfer) shows the dashed accent border + "Drop a .md / .py / .zip or a worker folder to import" overlay; a real `drop` of a `.md` fires `handleFiles` → page enters Processing (test worker created via the real path, then deleted to keep prod clean, HTTP 204). Screenshot: `docs/audits/shots-2026-05-29/batchD-verified/workers-new-dropzone-overlay.png`.

### Regression check — file-switch-via-tree must stay in-place (no full-page skeleton)
**Status:** VERIFIED (no regression) — CDP click on the SCHEMA.md tree button: 0 skeletons immediately after click, content swapped in place and settled.

## Batch C — connections + secrets + settings + approvals defects (from `docs/audits/all-issues-discovery-2026-05-29.md`) (VERIFIED 2026-05-29)

PR #245 (squash `9965187`, merged to main). Worktree `/tmp/wk-batchC-connections` off `66d1fa5`, rebased onto `origin/main` pre-merge (no conflicts), `gh auth=federicodeponte`, `baseRefName=main`. Backend deployed via `ops/deploy-api.sh` (HEAD `b516b71` → SHA `8e5920f`, health ok, all endpoint asserts 200, migration v38, schema OK). Frontend: Vercel prod deploy aliased to `workers.floom.dev` (verified `created 47s ago`). Live verification via AX41 Browser Broker pool-e + `curl` against `workers-api.floom.dev` (public API reachable, not CF-blocked). Screenshots in `docs/audits/shots-batchC-2026-05-29/`. Scope respected: did NOT touch `/workers`, `/runs`, `/overview`, `/contexts` (other batches).

### P1-8 (DANGER) — infrastructure env vars listed as deletable user Secrets
**Root cause:** `apps/api/main.py` `PLATFORM_SECRETS` (the denylist that filters `GET /secrets` and guards upsert/delete/test) was built from `PLATFORM_SECRET_SPECS` only. The infra/path vars in `INFRA_PATH_SPECS` (`FLOOM_DB`, `FLOOM_WORKERS_DIR`, `FLOOM_ARTIFACTS_DIR`, `FLOOM_CONTEXTS_DIR`, `FLOOM_RUN_TIMEOUT`) were therefore NOT excluded, so they appeared in the operator Secrets list with Test/Update/**Delete** — deleting `FLOOM_DB` could break the running system.
**Fix:** `PLATFORM_SECRETS` now unions `PLATFORM_SECRET_SPECS + INFRA_PATH_SPECS`. The infra vars are excluded from the list and refused (HTTP 400) for upsert/delete/test. They remain visible (read-only) in Settings → System → Platform configuration. New regression test `tests/test_p1_8_infra_vars_not_user_secrets.py` (4 tests, all pass).
**Status:** VERIFIED LIVE — deployed backend `GET /secrets` returns 6 names, all real API keys (`APIFY_API_KEY`, `GEMINI_API_KEY`, `GITHUB_PAT`, `GOOGLE_API_KEY`, `GRANOLA_API_KEY`, `TEST_SECRET`); zero infra vars present. `DELETE /secrets/FLOOM_DB` → HTTP 400 (refused). Public `workers-api.floom.dev/secrets` → 200.

### P1-7 — Connections Status column had no positive state for active connections
**Root cause:** `StatusPill` in `apps/web/components/connections/ConnectionRow.tsx` returned `null` for `status==="active"` (an earlier "no decoration" call), so active rows showed a blank Status cell while only Expired/Failed got a pill — read as missing data.
**Fix:** added an "Active" pill (uses `--positive`) so every row shows its actual state.
**Status:** VERIFIED LIVE — `/connections` (broker pool-e): GitHub, Gmail, LinkedIn all show green "Active" pills. Screenshot: `docs/audits/shots-batchC-2026-05-29/16-connections-connected.png`.

### P2-6 — expired rows showed "— ↻" dangling refresh glyph (looked like a stuck loader)
**Root cause:** the Scopes column rendered a dash + inline refresh button whenever `scopes.length===0`, including expired/failed rows — where a scope re-check can never succeed.
**Fix:** for expired/failed connections show a clean dash only; the inline refresh affordance is reserved for healthy-but-unloaded rows. The path back for a dead connection is Reconnect.
**Status:** VERIFIED LIVE — expired Google Calendar/Drive/Notion rows show "— —" with no refresh glyph. Same screenshot.

### P2-7 — opaque "account …849fe7" hash for expired Google/Notion connections
**Root cause:** `getConnectionAccountLabel` (`connection-data.ts`) fell back to an ID-suffix hash when no human-readable account metadata existed — which is the case for expired connections (Composio returns no account info until reconnect).
**Fix:** for expired/failed connections with no account label, show "Expired — reconnect to see account" instead of a hash. The per-row ID-suffix disambiguator in `ConnectionsClient.tsx` now skips this placeholder so two expired rows don't reintroduce hash noise.
**Status:** VERIFIED LIVE — both Google Calendars, Google Drive and Notion show "Expired — reconnect to see account". Same screenshot.

### P2-8 — Browse cards showed a redundant dev-facing slug + truncated title
**Root cause:** `apps/web/app/connections/browse/page.tsx` rendered the Composio toolkit slug under the human name ("Gmail / gmail") and `truncate`d the title ("Google Calen…").
**Fix:** dropped the slug line; the name now uses `line-clamp-2` so it shows in full.
**Status:** VERIFIED LIVE — `/connections/browse` (broker) cards show name + description only, no slug; "Google Calendar" renders in full.

### P2-9 — inconsistent Connections tab routing (`/secrets` outside the `/connections/*` namespace)
**Root cause:** Connected/Browse/MCP lived under `/connections/*` but Secrets was at `/secrets`.
**Fix:** moved the secrets page to `/connections/secrets` (`git mv`); the old `/secrets` is now a redirect that preserves `?prefill=`. Updated the tab, command palette, and browse/redirect prefill links.
**Status:** VERIFIED LIVE — Secrets tab href = `/connections/secrets` (HTTP 200); `/secrets` 301-redirects to `/connections/secrets` (final URL confirmed). Same connections screenshot shows the tab row.

### P1-9 — Approvals "Go to platform" link near-invisible + ambiguous
**Root cause:** two `Go to platform` links in `apps/web/app/approvals/page.tsx` used `--ink-mute` (low contrast); "platform" is confusing in the single-tenant OS (implies the separate Cloud product).
**Fix:** both now read "Back to dashboard" (→ `/overview`) with readable `--ink-soft` + hover underline.
**Status:** VERIFIED LIVE — `/approvals` shows two "Back to dashboard" links, both `href=/overview`, clearly legible. Screenshot: `docs/audits/shots-batchC-2026-05-29/20-approvals.png`.

### P2-12 — Approvals empty-state card half-width while page is full-width
**Root cause:** the page wrapper was `max-w-2xl` while Runs/Connections fill the layout container.
**Fix:** outer wrapper is now full-width (`space-y-6`) with the larger 2xl H1; header + empty-state span full width; the populated approval card list keeps a `max-w-2xl` reading column.
**Status:** VERIFIED LIVE — the "No pending approvals" card spans the full content width, matching Runs/Connections. Same approvals screenshot.

### P2-10 — Settings CLI showed `floom login` but the npm package installs the `workeros` binary
**Root cause:** `apps/web/components/CliCommandPanel.tsx` printed `npm i -g @floomhq/workeros` then `floom login`. Per `apps/mcp/package.json` the package's `bin` entries are `workeros` and `workeros-mcp` — there is no `floom` binary, so the displayed command does not exist after install. (The CLI brands its help text as `floom`, but that is not an installed executable.)
**Fix:** the CLI snippet now reads `workeros login` (the real installed binary, matching the package name).
**Status:** VERIFIED LIVE — `/settings` → API access → CLI tab shows `npm i -g @floomhq/workeros` then `workeros login`.

## Batch A — worker-detail + runs defects (from `docs/audits/all-issues-discovery-2026-05-29.md`) (VERIFIED 2026-05-29)

PR #244 (squash `8b0a674`, merged to main) + follow-up PR #249 (squash `4c5b859`). Worktrees `/tmp/wk-batchA-workerdetail` and `/tmp/wk-batchA-followup` off `66d1fa5`/`origin/main`, rebased pre-merge, `gh auth=federicodeponte`, `baseRefName=main`. No backend touched (all frontend; P0-1 backend was already deployed via sweep #239) → no `ops/deploy-api.sh`. Frontend auto-aliased `workers.floom.dev` → latest prod deploy (`workeros-1z9e9x83u`, verified). Live verification via AX41 Browser Broker pool-e + `curl` against `workers-api.floom.dev` (reachable, not CF-blocked). Screenshots in `docs/audits/shots-batchA-2026-05-29/`. Scope respected: did NOT touch `/connections`, `/contexts`, `/overview`, `/workers` (list) (other batches).

### P0-1 — Worker Source/Code tab showed "No files found" for every worker
**Root cause / status:** backend already fixed + deployed (sweep #239): `GET /workers/<id>` returns `files[]` populated WITH content (curl: `csv_enricher`=4 files, `opendraft`=88, each `content` non-null). Frontend already reads `worker.files` (+ a `deriveSourceFiles` fallback that synthesises files from `manifest_yaml`/`run_py_content`/`skill_md_content` when `files[]` is empty). No further code change needed.
**Status:** VERIFIED LIVE — `/workers/csv_enricher#source` (broker pool-e) renders the Files list (worker.yml / SKILL.md / run.py / requirements.txt) with SKILL.md content shown — not "No files found". Screenshot: `docs/audits/shots-batchA-2026-05-29/P0-1-source-csv_enricher.png`. Curl: `csv_enricher` files len 4 all `content` populated.

### P1-1 — Worker detail flaky deep-link "Couldn't load worker — Retry"
**Root cause:** the load effect surfaced the error state on any non-404 fetch failure, including a transient cold-proxy/network blip; "Retry" recovered it (proving it was a race, not a 404).
**Fix:** `fetchWorkerWithRetry` retries the worker fetch up to 3 attempts with 250ms·n backoff before surfacing the error; a real 404 short-circuits straight to the not-found state.
**Status:** FIXED (verified by build + code; transient race not deterministically reproducible live). Typecheck + `next build` clean.

### P1-2 — run "completed" but PDF/DOCX export shown as bare `false`
**Root cause:** `OutputSummary` rendered scalar `run.output` entries (incl. `pdf_export_success`/`docx_export_success`) via `String(value)` → literal "false". Ground truth from the run's `export_report.json`: `requested:false` — so `false` means "not requested", NOT a failure.
**Fix:** `*_export_success` keys are pulled out of the scalar grid and rendered as a clear human pill (`PDF export: not generated` / `: generated` when true), never bare `false`. A real failure surfaces via `run.error`/logs, not a silent boolean.
**Status:** VERIFIED LIVE — `/runs/run_192471d3a456` Result tab shows muted pills "PDF export: not generated" / "DOCX export: not generated". Screenshot: `docs/audits/shots-batchA-2026-05-29/P1-2-P2-1-P1-3-run-result-tab.png`.

### P1-3 — internal infra telemetry leaked into the operator Logs view
**Root cause:** the Logs tab + Result-tab Recent-logs preview rendered `run.logs` raw, exposing `[e2b] Spawning sandbox`, `[redacted-metadata]`/`[redacted-id]` placeholders, and per-file `[e2b] Uploaded …` chatter.
**Fix:** `lib/run-format.ts` `operatorLogs()` filters sandbox-provider lines (`[e2b]`/`[firecracker]`/…), `[redacted-*]` placeholders, and low-level lifecycle noise out of BOTH the Logs tab and the Result-tab preview. The full unfiltered stream stays in the Raw tab; the Logs tab shows a "N internal log lines hidden" note.
**Status:** VERIFIED LIVE — Logs tab shows only `Run started` / `Output generated` / `Run completed` + "1065 internal log lines hidden. See the Raw tab"; Result-tab Recent logs likewise clean (no `[e2b]`/`[redacted]`). Screenshots: `docs/audits/shots-batchA-2026-05-29/P1-3-logs-tab-filtered.png`, `P1-2-P2-1-P1-3-run-result-tab.png`.

### P1-4 — raw internal error codes leaked into operator views
**Root cause:** machine error prefixes (`missing_connection: github`, `output_validation_failed: …`) rendered verbatim on `/runs` rows + worker History.
**Fix:** `lib/run-format.ts` `humanizeRunError()` maps coded prefixes to operator language (`Missing connection: GitHub`, `Output validation failed: …`) and title-cases known service slugs; both `/runs` (`summarizeError`) and the History tab route through it.
**Status:** VERIFIED LIVE — `/runs` failed GitHub Digest rows show "Missing connection: GitHub"; `/workers/csv_enricher#history` failed run shows "Output validation failed: enriched_csv file is too small (82 bytes, minimum 100)". Screenshots: `docs/audits/shots-batchA-2026-05-29/P1-4-runs-list-humanized-errors.png`, `P2-4-history-completed-pill.png`.

### P2-1 — run-detail Output stat labels were raw uppercased JSON keys
**Root cause:** `humanizeKey` only replaced underscores; the CSS `uppercase` then produced `WORD_COUNT` → `WORD COUNT` with no real humanisation, and `duration_seconds` showed the raw float (`1802.58`).
**Fix:** `lib/run-format.ts` `humanizeKey` produces sentence-case with acronym preservation (PDF/DOCX/CSV/JSON/…); `formatScalarValue` renders `*_seconds` as a compact duration and booleans as Yes/No.
**Status:** VERIFIED LIVE — Result tab shows "WORD COUNT 24735", "DURATION SECONDS 30m" (was 1802.58s). Same Result-tab screenshot.

### P2-2 — Run tab "Enrichment instruction" was a single-line input
**Root cause:** the worker manifest marks free-form fields as `type:"text"`, which the Run form rendered as a single-line `<Input>` that truncated.
**Fix:** a name/label heuristic (`instruction|brief|notes|summary|prompt|message|context|description|details|jd|paste|body|content`) renders `text`/`string` free-form fields as a wrapping `<Textarea>` spanning both columns; short text fields (location, search query) stay single-line.
**Status:** VERIFIED LIVE — `/workers/csv_enricher#run` shows "Enrichment instruction" as a full-width multi-line textarea. Screenshot: `docs/audits/shots-batchA-2026-05-29/P2-2-run-tab-textarea.png`.

### P2-3 — worker-detail tab hashes did not match labels
**Root cause:** NAV ids `runs`/`connections`/`code` were written to the URL hash while the labels read History/Apps/Source.
**Fix:** `SECTION_TO_HASH`/`HASH_TO_SECTION` maps the visible label to the hash (`#history`/`#apps`/`#source`); legacy hashes (`#runs`/`#connections`/`#code`/`#overview`) still resolve so old deep-links keep working.
**Status:** VERIFIED LIVE — `#source`→Source, `#history`→History, `#run`→Run, `#triggers`→Triggers all resolve to the correct active tab (broker walk). Screenshots above.

### P2-4 — History tab: completed runs had no status pill, only failed ones
**Root cause:** `RunStatusBadge` returns `null` for success (intentional "quiet" default, S29l), so History completed rows showed no pill while failed rows did.
**Fix:** `RunStatusBadge` gains an opt-in `showSuccess` prop; History passes it to show a "Completed" pill for parity. Default stays quiet everywhere else.
**Status:** VERIFIED LIVE — `/workers/csv_enricher#history` completed run shows a "Completed" pill alongside the failed run's "failed". Screenshot: `docs/audits/shots-batchA-2026-05-29/P2-4-history-completed-pill.png`.

### P2-5 — Triggers tab showed Save/Discard chrome even with no unsaved change
**Root cause:** the `TriggersEditor` action bar rendered whenever `onSave` was provided (just disabled when clean).
**Fix:** the action bar now only renders when `dirty || saving`.
**Status:** VERIFIED LIVE — `/workers/csv_enricher#triggers` shows only Add/Edit/Remove trigger controls, no Save/Discard buttons on a clean tab.

---

# Operator-Surface Hygiene (G5 88→≥95) — 2026-05-29

Driver: `docs/audits/final-gate-G5-rescore-2026-05-29.md` (88/100, Trust 6/10). One rule: nothing internal is ever visible on an operator surface. PR #253 (merged `9693f5d`). Full per-item before/after evidence: `docs/audits/operator-hygiene-2026-05-29.md`.

### H1 — P0: `invoice-email-processor` broken on schedule (SyntaxError, 0% success, front-page)
**Root cause:** `run.py:22` nested same-quote f-string `f'Bearer {os.getenv('GOOGLE_SHEETS_TOKEN')}'` → SyntaxError every tick; also needs an unavailable Gmail+Sheets connection.
**Fix:** fixed the SyntaxError; archived (needs connections) with a clean operator reason. Removed from scheduler.
**Status:** VERIFIED LIVE — see audit doc.

### H2 — P1: `Environment Variables Worker` (debug) exposed in catalog
**Fix:** `system_worker: true` on its worker.yml + removed from `PUBLIC_STOCK_WORKER_IDS`. Hidden from `/workers` + scheduler.
**Status:** VERIFIED LIVE — see audit doc.

### H3 — P1: archive_reason leaked env-var names, "KeyError guard", git branch name
**Fix:** rewrote linkedin + 2 kugelaudio reasons to plain operator language; added `_sanitize_operator_text` guard at the WorkerSummary/Detail serialization boundary.
**Status:** VERIFIED LIVE — see audit doc.

### H4 — P1: raw Python tracebacks + sandbox paths shown as operator error
**Fix:** `_operator_error_message` maps tracebacks/paths/env-var names to calm headlines (clean errors pass through); raw trace kept in `RunDetail.error_raw` for the Raw tab only. Applied to /runs, /runs/<id>, overview alerts.
**Status:** VERIFIED LIVE — see audit doc + unit tests (`tests/test_operator_hygiene.py`).

### H5 — P1: `/contexts` showed only the engine pack `worker-author-style`
**Fix:** `_is_system_context_pack` hides system/engine packs from the operator /contexts list/detail/file endpoints; honest empty-state. Runtime mounting unaffected.
**Status:** VERIFIED LIVE — see audit doc.

### H6 — P1: approval trigger gap (no operator-reachable HITL worker)
**Root cause:** `outbound-approval-demo` was tracked but not in `PUBLIC_STOCK_WORKER_IDS` → hidden, "Worker not found".
**Fix:** added to `PUBLIC_STOCK_WORKER_IDS`; `is_example: true` already set. Operator-reachable.
**Status:** VERIFIED LIVE — full approve round-trip run_ids in audit doc.

### H7 — Sweep
`github-pr-summary` + `github-pr-issue-digest` (broken/stub scheduled DB-only artifacts) archived with clean reasons. `TEST_SECRET` deleted. Expired connections / count drift left (real dogfood state, not leaks).
**Status:** VERIFIED LIVE — see audit doc.

---

# G3 — Concurrency `Event loop is closed` (2026-05-29)

Driver: `docs/audits/full-audit-2026-05-29-0841.md` (G3 FAIL, single open blocker). PR #258 (merged `e210094`, deployed `ops/deploy-api.sh`).

### G3-1 — P1: intermittent `RuntimeError: Event loop is closed` whenever 2+ worker runs overlap
**Symptom:** solo runs always pass; under burst/scheduled-fanout (queue allows 18 concurrent) a subset of runs fail with `error_code: agent_runtime_error`, `error: "Event loop is closed"`, `retryable: true`. 7 such failures on 2026-05-29.
**Root cause:** the OpenAI Agents SDK default `MultiProvider` builds `AsyncOpenAI` over a process-wide `httpx.AsyncClient` (`OpenAIProvider.shared_http_client`). `AgentDriver._run_coro_sync` runs each worker in its OWN fresh `asyncio.run` loop (in a thread); `chat_service.stream_chat` runs on the persistent uvicorn loop. The httpx client binds its connection pool to the first loop that does I/O on it, so when one run's loop closes a concurrent run streaming on the shared client hits the closed loop.
**Fix (Option A — per-run isolation):** new `apps/api/runner_sandbox/loop_local_provider.py` `LoopLocalModelProvider` builds a fresh `AsyncOpenAI` + `httpx.AsyncClient` inside the run's own loop (lazily on first `get_model`), passed via `RunConfig.model_provider`, closed in `finally`. No loop-bound async resource is shared across runs. Applied to `agent_driver.py` + `chat_service.py`. Regression test `tests/test_agent_driver_concurrency.py` reproduces the bug and asserts zero closed-loop errors across 16 overlapping runs (FAILS without fix, PASSES with it).
**Status:** VERIFIED LIVE — post-deploy stress on prod: 8×2 concurrent `research_brief` (16 overlapping) + 6 concurrent `/chat` streams + 5+5 interleaved worker/chat + 1 solo = **33 runs, ZERO `Event loop is closed`** and zero errors of any class on post-deploy runs (24 completed + 1 pending_approval). Global closed-loop count held at the pre-fix baseline of 7. Solo run `run_5c41d68f8292` completed. Wave run_ids in `WORKPLAN-2026-05-28-overnight.md` G3 section.

---

## G5 RE-SCORE #2 (2026-05-29) — final gate-blocking P1 + 3 UX items

### P1 — Raw runtime/sandbox error jargon leaked verbatim to the operator run list
**Root cause:** `_operator_error_message()` (`apps/api/main.py`) only rewrote an error when `_has_internal_artifact()` detected a traceback/path/env-var/branch. Two confirmed live leaks carry NONE of those, so they short-circuited to the raw string: `"Event loop is closed"` (`agent_runtime_error`) and the E2B `"context deadline exceeded … process or directory watch … use '0' to disable"` (`e2b_sandbox_error`). The `_OPERATOR_ERROR_RULES` deadline rule was dead code (ran after the artifact gate).
**Fix:** key the operator headline off the structured `error_code` taxonomy FIRST (before the artifact gate), with a calm headline for every code + generic fallback. Added a runtime-jargon guard (incl. CamelCase exception names, asyncio/E2B boilerplate, `/uploads` SHA-256 message) so codeless jargon never passes through. Raw kept in `error_raw` for the debug tab. Same sanitizer applied to the overview failure cause. Tests for the 2 strings + unknown-code generic + taxonomy + clean passthrough.
**Status:** VERIFIED LIVE — PR #256 (squash 609cff5), backend deployed (SHA e210094). `GET /runs/run_12f326066d87` `.error` = "This worker hit an internal error and stopped…" (raw only in `.error_raw`); `GET /runs/run_279270f792f5` `.error` = "This worker took too long and was stopped…". Swept ALL 200 failed-run list `.error` fields + overview surface on prod → ZERO raw jargon. Screenshot: `docs/audits/shots-G5-finalP1-2026-05-29/p2-failed-result-tab.png`.

### P2 — Approvals nav badge vs list staleness (badge "1" while list empty; stayed "1" after approve)
**Root cause:** sidebar badge and `/approvals` list read from independent fetches with different lifetimes; no invalidation on mutation.
**Fix:** new `apps/web/lib/useApprovalsSync.ts` — single shared source. Badge (`useApprovalsCount`) + list (`useApprovalsListSync`) both revalidate on mount, slow poll, window focus/visibility, and via `notifyApprovalsChanged()` fired after any approve/reject/bulk.
**Status:** VERIFIED LIVE — approved run_21122fd0bbfe in the broker; Approvals nav badge dropped from "1" to gone WITHOUT reload; API `/approvals/count` → `{"pending":0}`; follow-up run_53e88df4c66e completed (PHASE run-2-execute, SENT true). Screenshots: `docs/audits/shots-G5-finalP1-2026-05-29/p2-badge-before.png`, `p2-badge-after.png`.

### P2 — Failed run-detail Result tab showed no error headline
**Root cause:** a failed run with a readable transcript but no explicit `finish` part rendered only a red step with no error sentence on the default Result tab.
**Fix:** `TranscriptView` appends the humanized error headline (`StackTrace`) when the run failed and no finish part carried it.
**Status:** VERIFIED LIVE — `/runs/run_12f326066d87` Result tab now shows an "Error" headline: "This worker hit an internal error and stopped. Check the run logs, then edit or re-run the worker." Screenshot: `docs/audits/shots-G5-finalP1-2026-05-29/p2-failed-result-tab.png`.

### P3 — HITL run awaiting approval rendered as red "Failed"
**Root cause (two code paths):** the backend emits a `finish` SSE part with `status:"pending_approval"`. The frontend (1) `latestStatus()` coerced any non-completed finish to "failed" (red header badge), (2) `TranscriptView` rendered a red `StackTrace` for it, and (3) `buildTimeline()` labelled it "Failed" in the timeline. The `RunPart` finish type union was also missing `"pending_approval"`.
**Fix:** preserve `pending_approval` in `latestStatus()`; render a neutral "Awaiting approval" task in `TranscriptView`; render an "Awaiting approval" timeline row in `buildTimeline()`; add `"pending_approval"` to the finish status union. (`RunStatus.tsx`/`RunStatusCell` already mapped it to a neutral "Awaiting approval" badge in the run list.)
**Status:** VERIFIED LIVE — PR #256 + follow-up PR #259 (timeline path caught on the live run-detail after the first pass). run_21122fd0bbfe (outbound-approval-demo, pending_approval): run list shows neutral grey "Awaiting approval" badge + "—" duration (not red Failed); run detail header badge + STATUS "pending approval"; timeline row "Awaiting approval — Waiting for your decision" (neutral Pause glyph). Screenshots: `docs/audits/shots-G5-finalP1-2026-05-29/p3-runs-list.png`, `p3-run-detail-fixed.png`.

---

## G5 RE-SCORE #3 (2026-05-29) — 2 frontend P1s blocking ≥95

Driver: `docs/audits/final-gate-G5-rescore3-2026-05-29.md` (92/100, gate NOT passed). Both frontend-only. PR #263 (squash `2e6cd79`), deployed (Vercel prod `workeros-ebjrxdlxm`, aliased `workers.floom.dev`).

### P1-1 (gate-critical) — Hero create flow silently resets after a successful generation
**Symptom (reproduced twice in the audit):** `/workers/new` → type prompt → Generate → worker-author ran ~24-40s → page RESET to the empty form (no nav, no toast); the worker WAS created server-side, and sometimes a DUPLICATE worker was created.
**Root cause:** `apps/web/app/workers/new/page.tsx` — on an SSE drop before `onmessage` saw the terminal status, `onerror` fired a SECOND synchronous `draftAndCreate` (a fresh ~30s LLM run) → duplicate worker; if that second call raced/failed it hit the catch → `setGenerating(false)` → silent empty-form reset. The run id was also read from a stale `streamRunId` state closure.
**Fix:** keep the run id in `runIdRef` (handlers never read a stale null); once a run id EXISTS, an SSE drop navigates to `/runs/<id>` + toasts (NO duplicate-creating fallback — the run page streams the rest). Terminal status (completed OR failed) navigates to the run with a toast (success → "Worker drafted"). `navigatedRef` guards double-nav. Fallback only fires when no run was ever started (endpoint 404/503).
**Status:** VERIFIED LIVE — drove `/workers/new` on prod with a real prompt → Generate → URL changed to `https://workers.floom.dev/runs/run_d7e0f257eb23`, "Worker drafted" toast shown, NO reset to empty form; the single worker-author run completed cleanly (`GET .../runs/run_d7e0f257eb23` → `status: completed`, `error: null`); exactly ONE run created (no duplicate). Screenshot: `docs/audits/shots-G5-rescore3-fix-2026-05-29/p1-1-create-flow-navigated.png`.

### P1-2 — Raw "Event loop is closed" still on run-DETAIL (timeline subtitle + StackTrace headline)
**Symptom:** the run-detail Error banner was humanized (`run.error`) but the left-column timeline subtitle (6px from the calm banner) and the failed-run `StackTrace` in the Result transcript still echoed the raw `part.error` ("Event loop is closed").
**Root cause:** `apps/web/components/RunDetailSplitPane.tsx` — `buildTimeline()` set `detail: part.error` (raw) and the finish-part `StackTrace` used `part.error || run.error` (raw first).
**Fix:** both operator-facing failure surfaces now render the backend-humanized `run.error`, falling back to `humanizeRunError(part.error)` only when `run.error` is empty. Raw `part.error` stays in the Raw tab. Completed timeline rows drop the stray error subtitle.
**Status:** VERIFIED LIVE — `/runs/run_12f326066d87` (`agent_runtime_error`, raw "Event loop is closed"): timeline subtitle now reads "This worker hit an internal error and stopped…" (calm headline), Error banner calm. Raw "Event loop is closed" appears ONLY as individual Recent-logs ERROR rows (legitimate engineer escape hatch per the audit), never as a headline. Screenshot: `docs/audits/shots-G5-rescore3-fix-2026-05-29/p1-2-run-detail-clean.png`.

---

## G5 RE-SCORE #4 (2026-05-29) — 3 non-blocking P2 polish items (96/100 gate)

Source: `docs/audits/final-gate-G5-rescore4-2026-05-29.md`. All three closed and VERIFIED LIVE on `https://workers.floom.dev` after deploy. PRs #267 (initial) + #268 (citation-regex correction).

### P2-1 — Raw `citeturn0search9…` citation tokens leaked into worker markdown output
**Symptom:** Research Brief Output tab rendered OpenAI web_search citation markers inline (`citeturn0search9turn0news12`), visible garbage in the operator-facing artifact.
**Root cause:** OpenAI Responses-API web_search wraps citations in Unicode Private-Use-Area delimiters (`<U+E200>cite<U+E202>turn0search3<U+E201>`); the PUA chars render zero-width so the visible text collapses to `citeturn…`. The renderer passed the raw string straight to ReactMarkdown.
**Fix:** new `apps/web/lib/strip-citations.ts` strips the full citation block (PUA-wrapped + bare variants) with a `(?:…turn…)+` guard so words like "cite"/"excited" survive. Applied in `OutputRenderer` (markdown + plain-text render AND the `.md`/`.txt` downloads) and the run-detail transcript text + raw-output fallback — covers every worker's output without re-running historical runs. Contract test `apps/web/tests/strip-citations.test.ts` (10 cases). (Initial #267 regex left `turn…` behind; #268 corrected it.)
**Status:** VERIFIED LIVE — `/runs/run_e7562889962c` (research_brief; stored output had **62** citation blocks): Output tab renders the full brief with **ZERO** `citeturn`/`turn0search`/PUA tokens anywhere in the body (confirmed via DOM bodyText + visual). Screenshot: `docs/audits/shots-G5-p2polish-2026-05-29/01-after-research-brief-output-no-citation-tokens.png`.

### P2-2 — Raw error string in failed-run Result-tab "Recent logs" preview
**Symptom:** the failure headline was humanized, but the Result-tab "Recent logs" preview still showed raw `ERROR Agent runtime error: Event loop is closed`.
**Root cause:** `RecentLogsPreview` rendered `log.message` verbatim; the weak JS `humanizeRunError` only matched snake_case codes, not free-text runtime jargon.
**Fix:** new `humanizeLogMessage()` in `apps/web/lib/run-format.ts` — error/critical lines matching runtime/infra patterns (Event loop is closed, asyncio, RuntimeError, tracebacks, Python exception names, "Agent runtime error") collapse to the calm runtime headline the failure banner shows. Non-error/clean lines pass through. Full raw stays in the Logs/Raw tabs.
**Status:** VERIFIED LIVE — `/runs/run_12f326066d87` Result-tab Recent logs now reads `ERROR This worker hit an internal error and stopped. Check the logs, then edit or re-run the worker.` — no raw `Event loop is closed` in the preview. Screenshot: `docs/audits/shots-G5-p2polish-2026-05-29/02-after-recent-logs-humanized-run_12f326066d87.png`.

### P2-3a — Connections: duplicate "Google Calendar (Expired)" rows
**Symptom:** two expired Google Calendar grants rendered as two identical "Expired — reconnect to see account" rows the operator can't act on differently.
**Root cause:** `connectionViews` memo (`apps/web/app/connections/ConnectionsClient.tsx`) kept both placeholder rows (a prior pass had decided "two identical is fine").
**Fix:** collapse duplicate placeholder rows per app to a single entry; real, distinctly-labelled accounts (different emails) are still kept and disambiguated with an id suffix.
**Status:** VERIFIED LIVE — DB has **2** expired `googlecalendar` grants (both placeholder); the live Connected list shows **ONE** Google Calendar (Expired) row. Screenshot: `docs/audits/shots-G5-p2polish-2026-05-29/03a-after-connections-deduped-google-calendar.png`.

### P2-3b — HITL run-1 duration counted approval-wait time (28m)
**Symptom:** a HITL run-1 that parked at `pending_approval` then completed on approval showed a 28m "duration" (`run_9d4650ac7f22` = 1,710,425ms) that was mostly operator approval-wait.
**Root cause:** the approve→COMPLETED transition (`update_status`, `apps/api/db/sqlite.py`) recomputed `duration_ms = completed_at - started_at` = wall-clock including the wait. Execution actually ended when the run parked for approval.
**Fix:** capture the real execution `duration_ms` at the `PENDING_APPROVAL` park transition; preserve an already-set `duration_ms` on the terminal COMPLETED/FAILED transition instead of recomputing. Normal (non-HITL) runs still compute duration at completion (no regression). Backend tests `test_hitl_duration_excludes_approval_wait` + `test_normal_run_duration_unaffected`.
**Status:** VERIFIED LIVE — fresh prod HITL run `run_e249f54a1e04`: parked at pending_approval with `duration_ms=3047` (~3s execution), then a 45s approval wait (`started 12:30:47 → completed 12:31:48`, ~61s wall-clock), approved → run-detail shows DURATION **3.0s**, NOT ~61s. Old-logic run `run_9d4650ac7f22` (28.5m) confirms the prior bug. Screenshot: `docs/audits/shots-G5-p2polish-2026-05-29/03b-after-hitl-run-duration-3s-not-wallclock.png`.

---

## P0 — wedge: generated workers CRASHED on first run (G5 scorer B 84/100, 0/2 ran)

### #W2 Worker-author generated run.py against the wrong contract (2026-05-29)

**Where:** `workers/worker-author/run.py` + `SKILL.md`, `contexts/worker-author-style/`, `apps/api/run_service.py` (smoke/repair), `apps/api/main.py` (humanizer).

**Symptom:** Prompt-to-worker created a well-formed worker, but the generated worker code crashed on first run (FileNotFoundError on scalar inputs, NameError on missing imports, ModuleNotFoundError on `dotenv`, missing_result on `out/result.json`, FileNotFoundError on `os.path.join("inputs", path)`). The G5 scorer found 0/2 generated workers ran.

**Root cause:** SKILL.md taught the agent-mode tool API (`run(inputs, context)`, `context.write_output`, `context.secrets`) not the E2B pure-script contract; the generator fed the LLM no run.py contract at all; no canonical template existed.

**Fix (PRs #277, #278, #279):** (1) rewrote SKILL.md run.py rules + added canonical `RUN_PY_TEMPLATE.py` single source of truth, injected into the generation prompt; (2) post-generation E2B smoke + bounded repair (max 2) so a worker is proven to run before it's presented as ready, outcome on the author run `smoke` field; (3) humanizer maps worker-code tracebacks to the CODE headline (not "internal error"/"took too long"); (4) template is stdlib-only (no dotenv) and writes result.json to the working dir; (5) file-input value is the path — `open(inputs["x"])` directly, never re-prepend `inputs/`.

**Status:** VERIFIED LIVE (deployed SHA `8f4196c`) — drove the real prompt-to-worker flow for 5 diverse script prompts; **smoke passed 5/5** (authoritative "does the generated code run" using each worker's own sample). The CSV worker (the original file-input crash) now opens the path directly and a fresh run with an uploaded CSV completed with real output (`run_f052949ea3c8`). Humanizer confirmed: a ModuleNotFoundError crash (`run_762191e94729`) surfaced as the CODE headline, not "took too long". Two residual fresh-run misses are NOT worker bugs (wrong-shaped harness input; platform 100-byte min-output gate on a valid 67-byte JSON). Full evidence: `docs/audits/genquality-fix-2026-05-29.md`.

---

## P1 — generated-worker quality follow-ups (the two residuals from #277-280, now closed)

### #W3 Valid small JSON output false-failed + null-run_code silent no-op stub (2026-05-29)

**Where:** `apps/api/run_service.py` (`_validate_run_outputs`, `_register_authored_worker`, `_smoke_and_repair_generated_worker`); generator: `workers/worker-author/run.py` prompt + `contexts/worker-author-style/SCHEMA.md`.

**Symptom (both surfaced by the #277-280 self-audit, both would be hit by a launch scorer):**
1. A worker that correctly wrote a small valid JSON result (e.g. `{"min":2,"max":9,"mean":5.71,"median":7}`, ~80 B) was marked `output_validation_failed: file too small` because the `MIN_OUTPUT_BYTES=100` prose floor ran before the JSON parse check. A correct worker looked broken.
2. A generated SCRIPT-mode worker whose generator emitted `run_code: null` was backfilled with `_DEFAULT_RUN_PY_STUB`, which writes `{status:success, outputs:{}}` — i.e. it "runs green" and does nothing. The worst failure for the wedge: the operator believes it works.

**Fix (PR #281, building on local commit `7e47b3e`):** (1) `_validate_run_outputs` — `application/json` outputs are gated on `json.loads` parseability (any non-zero size), never the byte floor; unknown media_type tries a JSON parse then falls back to the floor; size==0 still fails; text/* floor + placeholder-warning unchanged. Generator now declares `application/json` media_type for structured outputs. (2) `_register_authored_worker` returns None (drafted bundle stays viewable) for a bundle with NEITHER SKILL.md NOR run.py — never registers a no-op worker. (3) `_smoke_and_repair_generated_worker` detects a placeholder-stub run.py (marker match) and returns smoke=failed BEFORE running it (caught ahead of the secret/connection skip gates), instead of passing the green-but-empty stub. Tests +2 (41 pass): empty-bundle→None & writes nothing; stub marker is a substring of `main._DEFAULT_RUN_PY_STUB` (coupling guard).

**Status:** VERIFIED LIVE (deployed SHA `ce41e68`). Drove the real prompt-to-worker flow: "min/max/mean/median" → worker `number-stats` created, smoke passed (0 repairs), fresh run `run_936a610130f2` **completed, error=None**, small JSON `{min:2.0,max:9.0,mean:5.71,median:7.0}` ACCEPTED (the exact pre-fix failure). Regression check: "word/char count" → `text-word-character-counter-4` smoke passed (1 self-repair). Both live generations produced REAL code (0 stub markers), not the no-op stub. Two fix agents 500'd mid-task (transient platform); Gap 1 was preserved as a reviewed local commit and Gap 2 was finished + shipped by hand. Full evidence: `docs/audits/genquality-fix-2026-05-29.md`.

---

## P1 — wedge-reliability ENGINE defects (G5 scorers A=84 + B=58 both NOT launch-ready, converged) (2026-05-29)

### #W4 Byte-floor false-fail + non-gating smoke + green-but-empty + draft-and-create no-smoke + error_raw path leak

**Where:** `apps/api/run_service.py` (`_validate_run_outputs`, `_smoke_and_repair_generated_worker`, new `smoke_and_gate_generated_worker`, new `_smoke_empty_output_error`), `apps/api/main.py` (`draft_and_create_worker`, `_run_error_raw`).

**Symptoms (independently found by BOTH G5 scorers):**
1. **FIX 1** — the `MIN_OUTPUT_BYTES=100` hard floor false-failed correct small NON-JSON outputs. The prior #W3 fix only exempted JSON; a valid 36-53 byte CSV/text result was still marked `output_validation_failed: file too small` (A's P1-A `run_7e95aef5a611`, B's P1-1 `csv-sorter` 53B). The floor is fundamentally wrong — a valid non-empty result of ANY size is legitimate.
2. **FIX 2** — the post-generation smoke was ADVISORY, not GATING. A worker whose smoke FAILED ("list index out of range") still shipped as a normal ready worker; the result lived only on `outputs["smoke"]` and the author run completed regardless (B's P1-3 `run_099f9801e134`).
3. **FIX 3** — the smoke did not validate output SUBSTANCE. A worker returning `status:success` with an empty declared output (`[]`/`{}`) passed green (B's P0-2 `usd-to-euro-converter` `run_f4028545fe90`, `[]` 2 bytes marked completed).
4. **FIX 4** — `/workers/draft-and-create` had NO smoke+repair; broken workers shipped silently via the raw API (A's P1-B: median wrong result.json schema, uppercase `FileNotFoundError`).
5. **FIX 5** — API JSON `error_raw` carried sandbox/server paths (`/home/user/worker/`, `/root/workeros/...`) (A's P2-C, B's P2-1).

**Fix (PRs #283 + #284):** (1) removed the byte-floor FAILURE entirely — only empty/whitespace-only content fails, placeholder prose stays a WARNING, JSON parse + scalar checks unchanged, dropped `MIN_OUTPUT_BYTES`. (2) new `smoke_and_gate_generated_worker()` disables (`enabled=0`, stays editable, never deleted) any generated script worker whose smoke ends `failed`; the overview then counts it paused, runs are gated `worker_disabled`; the author SSE event + draft-and-create response carry `smoke_status`/`smoke_reason`. (3) the smoke now runs `_validate_run_outputs` + `_smoke_empty_output_error` (catches required output == `[]`/`{}`/`""`/null) against the smoke result → empty/missing routes into the bounded repair loop → gated if still empty. (4) `draft-and-create` (BOTH the LLM-prompt path AND the pre-supplied-files upload path) now runs the SAME `smoke_and_gate_generated_worker` via `asyncio.to_thread` + the same gating. (5) `_run_error_raw` strips `_SANDBOX_PATH_RE` → `[worker file]`; operator headline unchanged.

**Status:** VERIFIED LIVE (deployed SHA `7c86e0f`).
- FIX 1: `verify-good-upper` fresh run `run_f170b9f5ed6a` **completed** with a 2-byte output ACCEPTED (pre-fix: "too small, minimum 100"). UI-path `csv-sorter-2` run `run_dbf65623a9b1` completed with a 40-byte sorted CSV, `extract-email-addresses` run `run_a948ab39e954` completed with a 34-byte real result `{"emails":["a@b.com","c@d.org"]}` (rejected `bad@`).
- FIX 2 + FIX 4: buggy script worker via `/workers/draft-and-create` (Path A) → response `smoke_status:failed`, DB `enabled=0`, overview `paused_workers_count:1` / not in `active_workers_count:43`, worker stays editable. Good worker `verify-good-upper` via draft-and-create → `smoke_status:passed`, `enabled=1`.
- FIX 3: unit-verified (`tests/test_wedge_smoke_gating.py`: `[]` JSON / missing / whitespace-only required output → smoke=failed; small valid output → passed). Live: green-but-empty worker gated (`enabled=0`).
- FIX 5: historical path-leaking run `run_89b6d0e0b94b` served via API → `error_raw` shows `File "[worker file]"` (was `/home/user/worker/run.py`); no `/home/user` or `/root/workeros` in `error_raw`. Operator `error` is the clean CODE headline.
- 5 UI-path prompts: 3/5 created green workers with real output (uppercase, sort, email); 2/5 (word-count, reverse) did NOT register a worker — a PRE-EXISTING author-bundle schema gap (`scalar field 'word_count' must declare type`), NOT a regression and NOT in these 5 fixes; they ship the drafted bundle, never a fake-ready or green-empty worker. So the gate holds: 0/5 silently shipped broken/green-empty.

**Residual gaps (honest):** (a) the `logs[].message` engineer-debug surface still contains raw sandbox paths (intentionally — `_redact_public_log_message` keeps them for engineers); only `error_raw` was in scope for FIX 5. `artifacts[].path` (B's P2-1) is also still absolute and out of these 5 fixes. (b) the author-bundle SCALAR-output-without-`type` schema rejection (2/5 above) drops the worker to a no-registration dead-end; worth a follow-up to either coerce or surface it, but it does not ship a broken worker. Full evidence: `docs/audits/genquality-fix-2026-05-29.md`.

---

## P0/P1/P2 — Batch J: smoke-repair persistence + half-wired gate + path leaks (G5 rescore A=62 / B=74 / probe=95) (2026-05-29)

### #W5 Smoke-disable silently reverted; bare-exception leak; run-gate not enforced; disabled worker invisible; logs/artifacts path leak

**Where:** `apps/api/run_service.py` (`smoke_and_gate_generated_worker`, `_smoke_and_repair_generated_worker` repair block, new `_mark_worker_paused_on_disk`, `_build_smoke_inputs`), `apps/api/main.py` (`create_worker_run`, `_build_worker_detail`, `system_overview`, `_operator_error_message`/`_looks_like_*`, `_redact_public_log_message`, new `_public_artifact_path` + `persist_worker_run_py`), `apps/api/models.py` (`WorkerContract.paused`, `Artifact.relative_path`).

**Symptoms (3 independent audits):**
1. **P0-1 (scorer A) — smoke-repaired/disabled workers ship enabled-but-broken; real runs fail 100% silently.** ROOT CAUSE (found by reproduction): the smoke gate set `workers.enabled=0` in the DB, but `_persist_discovered_workers` recomputes `enabled` from the MANIFEST on every re-discover (cache invalidation, file save, repair persist), and the generated manifest carried no paused flag — so each re-discover flipped a smoke-disabled worker back to `enabled=1`. `WorkerContract` also had no `paused` field, so `model_dump()` dropped any paused flag during discovery. The repair loop additionally only wrote run.py to disk + a dead local-dict mutation + a swallowed cache-invalidate, never re-persisting through the canonical editor path.
2. **P0-2 (scorer A) — bare Python-exception messages with no class name leak verbatim to the operator `error`** (`unsupported operand type(s) for /: 'str' and 'float'`, error_code=None).
3. **B-P1-1 — `POST /workers/{id}/runs` never checked `enabled`**, so a smoke-disabled worker still ran on demand.
4. **B-P1-2 — a disabled worker was invisible**: detail `status=healthy`, not in `needs_attention`.
5. **P2/PATH-1 (scorer B + probe) — `logs[].message` leaked sandbox paths and `artifacts[].path` leaked the absolute host path** (`/root/workeros/...`).

**Fix (PR #TBD):**
- P0-1: added `WorkerContract.paused`; smoke gate writes `paused: true` to worker.yml (durable across re-discovery) + `enabled=0`; repair loop now persists the fixed run.py through the canonical `persist_worker_run_py` (write disk + invalidate cache + re-discover + re-persist recipe) and FAILS the smoke (disable) if persistence fails, instead of silently shipping unverified disk state. Also fixed `_build_smoke_inputs` to give list/array inputs a real `[3,1,2]` (number/string unchanged) so legit list workers (median/std-dev) are not false-disabled.
- P0-2: `_BARE_PYTHON_EXC_MSG_RE` routes bare-exc messages to `_CODE_HEADLINE` and blocks verbatim pass-through; clean structured messages still pass through.
- B-P1-1: `create_worker_run` returns 409 `worker_disabled` (taxonomy headline) before creating a run.
- B-P1-2: `_build_worker_detail` reports `needs_attention` for a disabled non-archived worker; `system_overview` adds a `worker_disabled` needs_attention item.
- P2: `_redact_public_log_message` runs `_SANDBOX_PATH_RE`; new `_public_artifact_path` relativises `artifacts[].path` (+ `Artifact.relative_path`). Download resolves the real path server-side from the artifact id (unchanged).

**Status:** VERIFIED LIVE on a worktree API instance (worktree `/tmp/wk-batchJ`, isolated DB/workers/artifacts, same OPENAI/E2B/Composio keys).
- **P0-1 (make-or-break):** 7 plain-English prompts via `/workers/draft-and-create`. After the smoke-input fix, list workers recovered: `median-calculator-6` smoke=passed → real run `completed` `{"median":3}`; `compute-standard-deviation-2` → `completed` `{"standard_deviation":2.138...}`; `usd-to-euro-converter-4` → `completed`, artifact `9.2/18.4/27.6` (0.92 rate, correct); `remove-duplicate-strings-2` → `completed`. Genuinely-broken LLM output (`string-reverser-4`, `sort-numbers`, path-leak; `extract-email-addresses-4`, empty file) → smoke=failed, `enabled=0`, **stay disabled across a full `/workers/reload`**, and **every real run returns 409 worker_disabled**. Tally: real-run-green + correctly-gated, **0 silently-broken**.
- **P1-1:** `compute-standard-deviation` (disabled) `POST .../runs` → **409** `{"detail":"This worker is paused. Turn it on to run it again."}`.
- **P1-2:** `/system/overview` `paused_workers_count=7`, all 7 disabled workers in `needs_attention` as `type=worker_disabled`; worker detail `status=needs_attention`.
- **P0-2:** `divide-numbers` 10/0 → operator `error` = `"This worker's code has an error and couldn't run..."`, `error_raw` keeps the traceback with `[worker file]` (no host/sandbox path). Bare-message cases unit-verified.
- **P2:** real-run JSON → `artifacts[].path="run_xxx/out/converted_prices.csv"` (relative) + `relative_path` set, logs scrubbed (`[redacted-id]`/`[redacted-metadata]`), **ZERO** `/home/user` or `/root/workeros` in the full run JSON. Artifact download still returns the real file.
- Tests: 19 new (run-endpoint 409 on disabled, repair-persists-to-recipe, humanizer bare-exc→CODE, log/artifact path scrub, smoke list-input). All pass. Pre-existing 6 failures (`test_pr_s8.py`, `test_db_factory.py`) are stale signatures, untouched by this change.

**Deferred (honest, out of scope):** NEW-7 `composio_connection_id` in `/connections` (longstanding P2); aggregate 54.5% legacy reliability (no fresh-worker-rate surfacing — nice-to-have). A smoke-disabled worker's worker.yml now permanently carries `paused: true`; the operator must edit/re-save (which drops it) or explicitly re-enable to turn it back on — intentional (a broken worker stays off until reviewed), but worth a UI "turn on" affordance that clears it. The scalar-output-without-`type` author-bundle gap is unchanged. Full evidence: `docs/audits/genquality-fix-2026-05-29.md`.

---

## P1/P2 — Batch K: launch-polish leaks + catalog churn + honest metric + samples (G5 final A=88 / B=91, both 0 P0) (2026-05-29)

### #W6 smoke_reason/log-panel jargon leaks; wall-of-red catalog; polluted success metric; file-input workers lacked samples

**Where:** `apps/api/main.py` (`humanize_smoke_reason`, `_redact_public_log_message`, `_DRAFT_SYSTEM_PROMPT`, `system_overview`, draft-and-create), `apps/api/run_service.py` (run-failed log line, `_backfill_example_input`, `_synthesize_example_input_from_schema`), `apps/web/app/workers/[id]/page.tsx` (sample-fill synthesize-upload), `apps/web/app/contexts/page.tsx` (transient toast), `workers/worker-author/run.py` + `contexts/worker-author-style/SCHEMA.md` (example_input rule).

**Fixes (PRs #287, #288, #289, #290 — deployed `2cc8dd2`):**
1. **FIX 1 (P1, both scorers) — last-mile jargon/path leaks.** `smoke_reason` (draft-and-create response + worker-author SSE) routed through new `humanize_smoke_reason()` (strips `(error_code=…)`, maps to calm headline; bare quoted-token KeyError args → CODE headline); the run "Recent logs" panel `Run failed: <raw>` line routed through `_operator_error_message`; AND the e2b raw-stderr traceback lines in the same panel collapsed to one calm note via `_redact_public_log_message` (the single log-read chokepoint). Widened `_BARE_PYTHON_EXC_MSG_RE` (e.g. `can't multiply sequence by non-int`).
2. **FIX 2 (P1, both scorers) — catalog cleanup (live DATA op).** DELETED 30 audit test-churn workers (numbered `-2/-3/-4/-5` duplicates + one-off wedge tests created during today's audits) via API; PAUSED 9 base-name 0%-success non-example workers (wrote `paused: true` to manifest + `/workers/reload` → durable `enabled=0`, 409, surfaced as `worker_disabled` in overview — reversible). Catalog 68 → 38 (11 examples + 27 non-example); no 0%-success non-example worker presented as green-ready.
3. **FIX 3 (P1, scorer A) — honest success metric.** `success_rate_7d` scoped to ACTIVE, real (non-example/system/paused) workers + `success_rate_scope="active_workers"` label. Live: **85.7%** (was 54.6% legacy aggregate).
4. **FIX 4 (P1, scorer A) — file-input workers ship runnable samples.** Generator prompt + SCHEMA.md now require `example_input` for every input (inline text for files); registration backfills `example_input` from `sample_input_json`; final fallback synthesizes from the input SCHEMA so EVERY generated worker is one-click runnable regardless of LLM compliance; UI synthesizes a real upload from the inline content. `_DRAFT_SYSTEM_PROMPT` now requests `sample_input_json`.
5. **FIX 5 (P2-A, scorer B) — /contexts transient toast.** Retry once on transient fetch error; never surface raw "Failed to fetch". (P2-B disabled-worker sample-fill no-op + P2-C approvals badge flicker: deferred — intentionally non-runnable / non-blocking cosmetic.)

**Live verification (deployed `2cc8dd2`, local prod backend 8011 = `workeros-api` systemd, the backend `workers-api.floom.dev` proxies):**
- **FIX 1:** fresh BOOM-input runtime failure → `error` = calm headline; logs panel = every traceback/exception line collapsed to "Worker code raised an error (see the Error card)"; `error_raw` (debug tab) path-scrubbed + jargon-collapsed; draft-and-create `smoke_reason` = calm headline. Full operator-visible surface (error + all logs) grep-CLEAN for `/home/user`, `/root/workeros`, `Traceback`, `unsupported operand`, `TypeError`.
- **FIX 2:** 30 deleted (HTTP 204), 9 paused (all 409 + `worker_disabled` in overview, durable across 2 reloads). Catalog 68 → 38.
- **FIX 3:** overview `success_rate_7d=0.857`, `scope=active_workers`, active=27 / paused=11.
- **FIX 4:** fresh file-input worker `line-counter` shipped `example_input={"text_file":"line 1\nline 2\nline 3\n"}` — one-click runnable.
- **Regression:** broken generations still smoke-fail → durably 409 (never green); a passing generation runs healthy. **0 silently-broken** holds.

**Tests:** +6 smoke_reason scrub/humanize, +5 e2b-log traceback collapse, +1 bare-key, +9 example_input backfill/synthesis, +2 overview success-scope. 38 client-fixture + hygiene + backfill tests pass together. Pre-existing 2 `test_db_factory.py` failures (missing `approvals` arg) untouched by this change.

**Deferred (honest residual):** Generator first-pass quality remains the ceiling (scorer A 72/100): many fresh script-mode generations smoke-FAIL on `output_validation_failed: <field> scalar output leaked a path string` (run.py writes a file path into a scalar output) — the wedge gate correctly catches these (durable 409, never green), but first-pass reliability is mediocre. This is a generator-engine quality watch-item, not a launch blocker for a hand-held design partner. Paused-worker list cards still show the historical `0% success` stat alongside the Needs-attention badge (honest, not green). The `paused: true`-on-disk re-enable affordance (W5 deferred) is unchanged.

**Status:** VERIFIED LIVE (deployed `2cc8dd2`, 2026-05-29 PM). Full evidence: `docs/audits/genquality-fix-2026-05-29.md`.

---

## P1/P2 — Batch L: stderr code-echo leak (the ≥95 unlock) + operator honesty + gen-quality engine (G5 final-2 A=91 / B=92, both 0 P0, both SAME single P1) (2026-05-29 PM)

### #W7 worker raw-stderr code-echo still leaked to operator surfaces; bundle_path/paused/never-run honesty; generator declaration mistakes dead-ended registration

**Where:** `apps/api/main.py` (`_collapse_stderr_code_echo_rows`, `_public_error_field`, `_build_worker_detail`, run-detail logs + `GET /runs/{id}/logs` + SSE replay), `apps/api/models.py` (`WorkerStatus.READY`, `WorkerDetail.enabled`), `apps/api/run_service.py` (`_normalize_authored_worker_yml` field normalization, `_SMOKE_CODE_FAILURE_CODES`, `_SMOKE_REPAIR_SYSTEM_PROMPT`), `apps/web/app/workers/[id]/page.tsx` + `WorkersClient.tsx` + `lib/types.ts` (paused Run gate, READY pill), `contexts/worker-author-style/{RUN_PY_TEMPLATE.py,SCHEMA.md}` + `workers/worker-author/SKILL.md` (scalar-vs-file output contract).

**Fixes (PRs #292 #293 #294 #295 #296 — deployed `340d99d`):**
1. **P1 (both scorers, the ≥95 unlock) — stderr code-echo.** Paths/traceback/exception already scrubbed (#288); the residual was the worker's OWN raw stderr: the echoed source line (`quotient = number1 / number2`), caret marker (`~~~^~~~`), and `Command exited with code N`. Each e2b stderr line is a SEPARATE log row, so the multiline-collapse never saw the block. `_collapse_stderr_code_echo_rows` drops these on the ORDERED RAW rows (frame + caret anchors) then per-row redaction calms the rest into ONE note; applied to run-detail logs, `GET /runs/{id}/logs`, SSE replay. SSE finish `error` routed through `_operator_error_message` (calm headline like the Error card).
2. **P2 — operator honesty.** `bundle_path` relativised to basename on GET /workers/{id}; paused worker exposes `enabled` + UI disables Run ("Paused — turn on to run"); never-run worker reports neutral `ready` (rendered like healthy) not unearned `healthy`.
3. **Gen-quality — toward 100.** Scalar-vs-file OUTPUT value contract taught in template/SKILL/repair-prompt; `output_validation_failed` routed into the bounded repair loop. Engine-side: `_normalize_authored_worker_yml` losslessly fixes the recurring LLM worker.yml declaration mistakes that DEAD-ENDED registration ((a) type-in-kind-slot `kind: textarea` → kind:scalar+type, (b) contradictory scalar+file-markers → clean scalar, (c) scalar missing type → default string), for inputs+outputs, top-level + exec.

**Live verification (deployed `340d99d`, local prod backend 8011):**
- **P1:** div-by-zero worker `batchl-dz-probe` run `run_6e4531fbed97` → logs[] + GET /runs/{id}/logs + SSE error/stream ALL calm, ONE "Worker code raised an error" note, error = calm headline. Operator-default surfaces grep-CLEAN: `~~~`/`^~`/`quotient`/`Command exited`/`number1`/`ZeroDivision`/`Traceback`/`division by zero`/`/home/user`/`/root/workeros` = 0. `error_raw` (verbatim, engineer-only, not rendered in `apps/web`) keeps the trace = opt-in Raw condition.
- **P2:** `batchl-dz-probe` GET /workers/{id}: `bundle_path=batchl-dz-probe` (basename), `status=ready`, `enabled=true`; detail 0× `/root/workeros/workers`. Paused `median-calculator-4` → `enabled=false`, 409.
- **Gen-quality (6-prompt live walk):** USABLE FIRST-PASS **5/6** (reverse `"dlrow olleh"`, csv-sort by col2, title-case, sum=15.0, dedupe) — up from ~1/6. GATED **1/6** (median smoke-failed → enabled=false, 409, never green). **0 silently-broken.**

**Tests:** +14 (stderr-echo collapse, caret/Command-exit drop, clean passthrough, SSE error calm headline; P2 ready/bundle_path/enabled; scalar-output validation + repair-routing; worker.yml field normalization). `test_batchj_hygiene` 38/38, `test_batchj_gate` 10/10. Pre-existing 2 `test_db_factory.py` failures (missing `approvals` arg) untouched.

**Honest residual (the remaining ceiling toward 100):** `median` smoke-FAILED because its generated run.py hardcoded `open('inputs/numbers.txt')` instead of reading the relative path from `inputs.json` (real file path `inputs/numbers`, no `.txt`) — a run.py CODE mistake, a DIFFERENT class from the declaration mistakes fixed here, which the bounded max-2 repair didn't self-heal this run (LLM non-determinism). The durable gate caught it (enabled=false, 409, never green). Generator run.py code quality (hardcoded input paths) is the watch-item; the wedge gate is the backstop and holds. This clears the agreed ≥95 (P1 closed live + gen-quality majority-usable + 0-silently-broken intact); the path to a true 100 is the run.py code-generation quality (input-path contract self-repair), not a first-partner blocker.

**Status:** VERIFIED LIVE (deployed `340d99d`, 2026-05-29 PM). Full evidence: `docs/audits/genquality-fix-2026-05-29.md` (Batch L section).

---

## P2 — Batch M: the two trust/honesty P2s capping G5 scorer B at 93 (0 P0/P1) (2026-05-29 PM)

### #W8 /workers LIST reported broken workers as "healthy"; draft-and-create silently rewrote USER-supplied run.py; orphan sample-input 404; ambiguous overview copy

**Where:** `apps/api/main.py` (`_resolve_worker_status` new shared resolver, `list_workers`, `_build_worker_detail`, removed dead `_db_worker_from_row`, `get_worker_sample_input`, `draft_and_create_worker._smoke_gate_and_respond`), `apps/api/run_service.py` (`smoke_and_gate_generated_worker` + `_smoke_and_repair_generated_worker` `allow_code_repair` gate), `apps/web/components/overview/OverviewDashboard.tsx` (hero copy).

**Fixes (PR #298 — deployed `9f30c198`):**
1. **P2-A (the main cap) — LIST status honesty.** The DETAIL path applied the full downgrade ladder (missing_secret → failed-run → disabled → never-run→ready → earned-healthy); the LIST path applied only a partial one, and a dead helper carried a hardcoded `status:healthy`. A gated / never-run / disabled worker could show **healthy** in the list API. Extracted ONE shared `_resolve_worker_status(worker, config, available_secret_names, last_run_status, has_run)` with the full ladder and call it from BOTH `list_workers` AND `_build_worker_detail` — they can no longer disagree. Removed dead `_db_worker_from_row` (hardcoded healthy). `enabled` read from the worker dict (same `w.enabled` column `get_recipe` read) so the detail path drops its redundant recipe fetch.
2. **P2-C — never rewrite USER-supplied run.py.** The smoke+repair loop (built for LLM-generated workers) also ran on user-UPLOADED files, silently rewriting them (e.g. `x/0` → `x/1`) and returning success. Threaded `allow_code_repair` through `smoke_and_gate_generated_worker`/`_smoke_and_repair_generated_worker`: **False** for user-supplied uploads (Path A) — still smoked + gated (disable + calm reason on failure) but run.py is NEVER rewritten; **True** (default) for LLM-generated (worker-author + draft-from-prompt) — bounded auto-repair preserved (the wedge). 0-silently-broken intact.
3. **P2-B — orphan sample-input.** `GET /workers/{id}/sample-input` 404'd for non-stock workers. Now falls back to the worker's manifest `example_input` (resolution order: static `docs/workers/inputs/<id>.json` → manifest `example_input` → 404 only when neither exists). Consistent for API consumers + the UI.
4. **P2-D — overview copy.** Hero read "{N} outcomes this week" beside a "Runs completed" tile for the SAME 7-day value (and N could be a 24h fallback). Now one honest line: "N runs completed in the last 7 days", matching the tile.

**Live verification (deployed `9f30c198`, local prod backend 8011):**
- **P2-A list==detail:** ai-news-summary `ready`==`ready`; opendraft `needs_attention`==`needs_attention`; github-pull-request-summary `missing_secret`==`missing_secret`; word-count `healthy`==`healthy`; divide-numbers `needs_attention`==`needs_attention`; csv_enricher `healthy`==`healthy`. LIST no longer all-"healthy" (47 workers span ready/needs_attention/missing_secret/healthy). No hardcoded "healthy" remains (dead `_db_worker_from_row` removed).
- **P2-C byte-identical:** uploaded `p2c-user-divzero-test` run.py with `x / 0` → created, `smoke_status=failed` (calm reason), `enabled=false`, **stored run.py sha256 == uploaded sha256** (still contains `/ 0`, NOT rewritten), run attempt → **HTTP 409** "This worker is paused…", LIST status==DETAIL status==`needs_attention`. No-regression: 2 LLM draft prompts → `text-word-frequency` smoke **passed** (ran green), `celsius-temperature-converter` smoke-failed → DISABLED → 409 → list==detail `needs_attention` (wedge auto-repair ran, gate held, 0 silently-broken).
- **P2-B:** sample-input returns the sample (HTTP 200) for csv_enricher / opendraft / research_brief (matching detail `example_input`), no longer an orphan 404.

**Tests:** +4 (`tests/test_wedge_smoke_gating.py`): shared resolver list==detail across ready/disabled/failed/healthy; user-supplied run.py NOT repaired (byte-identical, `_repair_run_py` never called); generated worker STILL self-repairs (wedge no-regression). `test_wedge_smoke_gating` 10/10, `test_batchj_gate` 10/10 (isolated, fresh DB). Pre-existing cross-file test-isolation failures (`test_pr_h_worker_cards`, `test_round8_worker_authz`, `test_workers_draft_from_prompt`) reproduce identically on the base SHA `e0aaa41` — not introduced by this change.

**Honest residual:** generator first-pass run.py quality remains the ceiling (LLM non-determinism gates some fresh generations — caught durably, never green), unchanged from W7. The `enabled` resolver default-True for stock/filesystem workers (no recipe row) matches prior behavior. No env-var / FLOOM_SECRET changes; G4 security, the wedge gate, durable-disable+409, and 0-silently-broken all intact.

**Status:** VERIFIED LIVE (deployed `9f30c198`, 2026-05-29 PM). Full evidence: `docs/audits/genquality-fix-2026-05-29.md` (Batch M section).

---

## P2 — Batch N: the last two trivial P2s toward a clean 100 (G5 A=96/B=95, 0 P0/P1) (2026-05-29 PM)

### #W9 smoke_reason leaked a leading `output_validation_failed:` prefix; test_db_factory.py 2 red (missing `approvals`)

**Where:** `apps/api/main.py` (`humanize_smoke_reason` + new `_SMOKE_REASON_LEADING_CODE_RE`), `apps/api/tests/test_batchj_hygiene.py` (+1 test), `apps/api/tests/db/test_db_factory.py` (`_fake_repos`).

**Fixes (PR #300 — merged squash, deployed `8211c29`):**
1. **FIX 1 (P2, G5-B) — leading error_code prefix leak.** `humanize_smoke_reason` stripped the TRAILING `(error_code=…)` the smoke pipeline appends, but NOT a LEADING `<code>:` prefix. `run_service.py` builds the empty-output reason as `output_validation_failed: <name> produced an empty result …` (no trailing code), so the raw `output_validation_failed:` code prefix + raw text reached the operator verbatim on the draft-and-create response / worker-author SSE. Fix: when no trailing code is found, detect a leading `^([a-z][a-z0-9_]+):\s*` prefix, treat it as the code, strip it from the text, then route through the SAME existing `_operator_error_message(text, code)` path (so `output_validation_failed` maps to the calm `_OUTPUT_HEADLINE`). All prior behavior preserved (trailing-code strip, bare-quoted-token → CODE_HEADLINE, defensive redaction).
2. **FIX 2 (P2, test-only) — test_db_factory red.** `_fake_repos()` built `Repositories(...)` without the now-required `approvals` field (added after the test's last edit #117) → TypeError, 2 red tests. Added the missing `approvals=_FakeWorkerRepo()` arg, mirroring prod's `Repositories(...)`. Production approvals untouched.

**Live verification (deployed `8211c29`, local prod backend 8011):**
- **FIX 1 empty-output:** `POST /workers/draft-and-create` with a user-supplied SCRIPT worker that reports `status:success` but emits an empty required output → `smoke_status:failed`, `smoke_reason` = the calm `_OUTPUT_HEADLINE` ("This worker finished but its result didn't pass validation. Check the run logs, then re-run."). Grep of the live reason: 0 `output_validation_failed`, 0 raw text ("produced an empty result"/"no real output"), 0 leading-`code:` prefix.
- **FIX 1 normal failure:** a div-by-zero worker → `smoke_status:failed`, `smoke_reason` = the calm `_CODE_HEADLINE` (trailing-code path intact, no regression).
- **No regression:** a worker producing a real output → `smoke_status:passed`, `smoke_reason:null` (0-silently-broken intact). `/health` 200 after all probes. All 3 probe workers deleted (HTTP 204, none left on disk).
- **FIX 2:** `tests/db/test_db_factory.py` 5/5 pass (the 2 previously red now green); `tests/test_batchj_hygiene.py` 39/39 pass incl. the new leading-prefix test. Confirmed origin/main's `_fake_repos` was missing `approvals`.

**Scope:** ONLY these two fixes. No wedge-gate / security / env-var / FLOOM_SECRET changes.

**Status:** VERIFIED LIVE (deployed `8211c29`, 2026-05-29 PM). PR #300.

---

## R17 referee — two genuinely-real security residuals (2026-05-29)

Branch `fix/composio-execute-auth-and-csp-2026-05-29`. Detail: `docs/audits/round17-fix-followup-2026-05-29.md`.

### #SEC1 composio-execute proxy connection fallback not owner-scoped (MEDIUM multi-tenant / LOW single-tenant) — FIXED + TESTED

**Where:** `apps/api/main.py` `composio_execute_proxy` (~L7238), `apps/api/db/sqlite.py` `SqliteRunRepository.get_any`.

**Symptom:** Connection fallback picked "first active connection for the app" with no owner scoping, and read the owner from `run_row['user_id']` (a column the `runs` table does not have — owner lives on `workers.owner_id`). Multi-tenant Cloud: owner A's running worker could drive owner B's connected account.

**Fix:** Derive owner from the run's worker; scope the connection lookup to that owner via `repos.connections.list(user_id=owner_id)`; reject when worker/owner unresolved. Documented `runs.get_any()` as unscoped/capability-only and confirmed it is off all authed read paths.

**Proof:** `tests/test_composio_execute_owner_scope.py` 3/3 (owner-scoping picks owner's conn over a sibling owner's; garbage run_id → 404; non-running run → 403). Single-tenant unchanged.

**Status:** FIXED. (live proof appended after deploy)

### #SEC2 CSP `script-src 'unsafe-inline'` (LOW) — DOCUMENTED + LEFT

**Where:** `apps/web/next.config.ts`.

**Decision:** Nonce CSP in Next 16 app-router needs middleware + forced dynamic rendering, risking hydration regressions — not worth breaking a working app for a LOW finding. Left `'unsafe-inline'` with rationale + `TODO(cloud-ga)` to nonce before the multi-tenant Cloud serves untrusted-tenant content. Live site verified loading.

**Status:** DOCUMENTED-AND-LEFT (residual acknowledged).

### #FEAT-WSDUP Workspace duplicate (Notion-template style) — SHIPPED + TESTED (2026-05-29)

**What:** Duplicate/remix a WHOLE WORKSPACE as a downloadable `.zip` template.
`GET /workspace/export` bundles every non-example/non-system operator worker +
operator knowledge pack + `workspace.md` + a `workspace.json` manifest;
`POST /workspace/import` unpacks one into the caller's workspace.

**Security:** export carries NO secret VALUES — only required-secret/connection
NAMES (in the manifest). Defense-in-depth drops any secret-bearing file
(`.env`, `*.pem`, `credentials*`, …) from worker dirs AND knowledge packs.
Verified: grep of the whole zip for the secret value / `FLOOM_SECRET` → 0 hits.

**Import safety:** zip member paths sanitized (traversal + symlink → 400);
workers registered via `_register_worker_from_files(dedupe_id=True)` (id-deduped,
never clobbers); existing packs skipped (never clobbered). Reuses from-bundle
rate limit + a 50 MiB body cap.

**Where:** `apps/api/main.py` (`/workspace/export`, `/workspace/import`,
`_iter_worker_dir_files`, `_is_secret_bearing_export_path`,
`_is_exportable_operator_worker`). UI: `apps/web/app/settings/page.tsx`
(Workspace agent tab → "Duplicate workspace"). `apps/web/lib/api.ts` +
`lib/types.ts`.

**Proof:** `tests/test_workspace_duplicate.py` 5/5; isolated export→import
round-trip verified (worker + pack appear, re-import dedups, traversal rejected).
Doc: `docs/audits/workspace-duplicate-2026-05-29.md`.

**Status:** SHIPPED. (live edge proof appended after deploy)

---

## Backend hardening + consistency batch (2026-05-29)

### #BE-CLEAR-1 `/runs/clear` was a global, irreversible footgun that wiped 593 prod runs

**Where:** `apps/api/main.py` `clear_runs` (`/runs/clear`); backup helpers `_backup_db_before_clear` / `_live_db_file_path` / `_preclear_backup_dir`. Repo delete: `apps/api/db/sqlite.py` `RunsRepository.clear_all` (already owner-scoped via `list_all_ids` `WHERE w.owner_id = ?`).

**Symptom:** A referee agent called `POST /runs/clear?confirm=yes-wipe-all-runs` against prod :8011 thinking it was local dev and irreversibly wiped 593 runs/logs/artifacts. The only guard was the `?confirm=` query gate; one call destroyed all run history with no backup.

**Fix:**
1. **Auto-backup before wiping** — `_backup_db_before_clear` snapshots the live DB to `/root/backups/manual/floom-preclear-<epoch>.db` via SQLite `VACUUM INTO` (atomic, WAL-consistent, no sidecar). Backup dir overridable via `WORKEROS_PRECLEAR_BACKUP_DIR` (defaults to prod path).
2. **Abort on backup failure** — if the snapshot raises or is missing/empty, the endpoint returns HTTP 500 and deletes NOTHING.
3. **Owner-scoped** — delete already runs through `clear_all(user_id=...)` (`WHERE w.owner_id = ?`); never a cross-tenant wipe. Hardened the docstring + log line to make this explicit.
4. Response now returns `{status, cleared_count, deleted_runs (back-compat alias), backup_path}`.

**Proof:** `tests/test_runs_clear_hardening.py` (3/3): backup-created-before-delete + owner-scope + abort-on-backup-fail. `tests/test_round8_worker_authz.py::test_runs_clear_only_deletes_owner_history` updated to assert the backup + cleared_count contract (passes). Did NOT exercise a real wipe against prod; the 595 prod runs are untouched.

**Status:** FIXED (live edge proof appended after deploy).

### #BE-CTX-2 `/contexts` LIST showed "0 workers" while the pack was in use

**Where:** `apps/api/main.py` `_context_summary` (hardcoded `worker_count=0`), `list_contexts`, new helper `_context_worker_counts`. Detail path `_context_detail` already computed `used_by` + `worker_count` correctly.

**Symptom:** GET `/contexts` row for `worker-author-style` reported `worker_count: 0`, while GET `/contexts/worker-author-style` (detail) reported `worker_count: 1, used_by: [Worker Author]`. List and detail disagreed; the UI showed "0 workers" for packs that were actually mounted.

**Fix:** `_context_worker_counts` builds a `pack_name -> count` map from a SINGLE `repos.workers.list()` call (no N+1 across packs), computed from the same `context_mount_names(config.contexts)` source the detail path uses. `list_contexts` passes the per-pack count into `_context_summary`.

**Proof:** Live (pre-fix) confirmed the inconsistency on :8011 — list `worker-author-style`=0, detail=1. `apps/api/tests/test_contexts_system_packs.py::test_list_worker_count_matches_detail` asserts list == detail == 1 after a worker mounts the pack. curl proof appended after deploy.

**Status:** FIXED (live edge proof appended after deploy).

---

## P0 — generator first-pass quality: ~50% of awkward prompts gated on first run (2026-05-29)

### #G1 Generated workers used a weak coder (gpt-4o-mini) → ~half gated, operator had to regen

**Where:** the three codegen call sites — `workers/worker-author/run.py` (meta-worker generation), `apps/api/run_service.py` `_repair_run_py` (smoke-repair), `apps/api/main.py` `_call_draft_llm` (`/workers/draft-from-prompt`). All three used `gpt-4o-mini`.

**Symptom:** A worker generated from a plain-English prompt ran green on the first try only ~50% of the time. The durable gate kept it safe (never silently broken), but the operator had to regenerate for the other half — not self-serve-grade.

**Fix (PR #313, `f915580`; deployed SHA `d059d57…`):**
1. **Model bump (biggest lever):** new single source of truth `apps/api/codegen_model.py` — `WORKEROS_CODEGEN_MODEL` env, default `gpt-5.1` (strongest *chat-capable* coder on the prod key; `gpt-5.1-codex` is not a chat model). `chat_completion_codegen()` handles the gpt-5.x `max_completion_tokens` vs gpt-4 `max_tokens` difference + self-heals on the param-name 400. Shared by all three call sites; the E2B sandbox env propagates the override to the meta-worker.
2. **Contract tightening:** 6 worked run.py examples in `RUN_PY_TEMPLATE.py` (the single source of truth) covering historical failure classes; template injection cap 4000→9000; fixed the draft prompt's banned `from dotenv import` examples; added an explicit "implement EVERY declared output fully" rule to all three prompt surfaces.
3. **Repair tuning:** `_MAX_SMOKE_REPAIRS` 2→3; the repair now gets the worker's intent (description) so it can fix under-implementation, not just syntax. `output_validation_failed` already routes into repair. 0-silently-broken durable gate unchanged.

**Verification (real `/workers/new/from-prompt` flow, 10 diverse prompts, live on :8011):** 10/10 GREEN, 0 repairs (pure first-pass), 0 gated, 0 silently-broken; each worker produced correct real output on a fresh run; multi-output workers fully implemented. New `tests/test_codegen_model.py` passes. 10 test workers cleaned up (scoped DELETE); runs floor held (595→605). Full table: `docs/audits/generator-quality-2026-05-29.md`.

**Status:** SHIPPED + VERIFIED.

---

## Feature — Emily can read Slack channels she's invited to (consent = invite) (2026-06-04)

### #SC1 On-demand Slack channel reading, invite-gated

**What Federico asked:** "be able to read the channels if the user wants to. Full power."

**Consent model (decided + implemented):**
- **Invite = consent.** Slack only lets the bot read a channel it is a MEMBER of, so the operator controls access per-channel by inviting Emily (`/invite @Emily`). Default access stays DM + @mention only.
- **On-demand only.** Emily reads a channel's recent history WHEN the operator asks ("summarize #launch"). No firehose, no proactive ingestion, no event subscription to all channel messages.
- **Privacy:** reading a channel ingests everyone's messages there. Emily is matter-of-fact about that (`privacy_note` on every read).

**Where:** `apps/api/chat_service.py` — two new workspace tools in `_workspace_tools`:
- `slack__list_channels` — `users.conversations` (the bot's own memberships) → name + id + is_private + is_member. Reuses `main._slack_bot_token_for_team(None)` (multi-team aware) with `SLACK_BOT_TOKEN` fallback.
- `slack__read_channel(channel, limit?)` — resolves a name (or bare id) to a channel id, then `conversations.history` (limit clamped 1–100, default 50). Returns cleaned messages (author + text + ts), system-join noise dropped, oldest-first.

**Graceful failure (never crashes):** `_slack_friendly_error` maps Slack errors to Emily-voice messages —
- `missing_scope`/`invalid_scope` → "channel access isn't enabled yet; owner adds channels:read/channels:history/groups:read/groups:history and reinstalls."
- `not_in_channel`/`channel_not_found` → "I'm not in that channel yet. Invite me with /invite @Emily."
- no bot token → "Slack isn't connected."

**Scope dependency:** reading needs `channels:history`, `channels:read`, `groups:history`, `groups:read` bot scopes (added to `docs/slack-app-manifest.example.yml`; reinstall required). Tools WORK once granted and degrade gracefully until then. Guidance added to `workers/workspace-agent/SKILL.md` + `docs/slack-self-test.md`.

**Tests:** `tests/test_emily_slack_channels.py` — 12 tests (list/read happy paths, name resolution, bare-id, limit clamp, and the graceful missing_scope / not_in_channel / no-token paths). All green.

**Status:** SHIPPED (live-verified pre-scope-grant: Emily responds gracefully, telling the operator how to enable channel access).

---

## Backend batch - Emily cross-surface + Round 9/10 (2026-06-05)

### #BB-A1 Emily `workers__update` did not change runtime behavior

**Status:** FIXED + VERIFIED. Deployed in PR #427 at `bb8c92942c3f88c00a817a428089bdbd3dceebfe`. Prod worker `cxtest-a1-4410f483` changed from run `run_db40defe7596` output `HELLO MIXED` to run `run_fffec79acedc` output `hello mixed` after Emily called `workers__update`.

### #BB-A2 Caller-supplied conversation ids lost history

**Status:** FIXED. Caller ids now map to stable owner-scoped `conv_client_*` ids. Prod caller `cxtest-a2-26acccc0` remembered `codeword-0c343d` on turn 2. Cross-owner protection is verified by local tests; prod is currently single-tenant and does not enable `x-floom-user` scoping.

### #BB-A3 `/chat` source was hardcoded to web

**Status:** FIXED + VERIFIED. `/chat` accepts `source`; MCP sends `source:"mcp"`. Prod `source:"mcp"` returned the MCP channel phrasing; invalid source returned 422.

### #BB-A4 MCP create errors rendered `[object Object]`

**Status:** FIXED + VERIFIED. Real MCP stdio `workers.create` invalid WorkerContract now returns JSON validation detail and no `[object Object]`. Tool docs include `schema_version` and root `inputs.json` / `result.json`.

### #BB-B1 Public trailing-space auth repro

**Status:** PARTIAL. App/Uvicorn raw-header path is fixed: direct raw socket to `127.0.0.1:8011` returns 403 for secret plus space/tab. Public `https://workers-api.floom.dev` still returns 200 for the trailing-space curl repro because Cloudflare/cloudflared normalizes trailing header whitespace before FastAPI receives it. Public edge enforcement remains open.

### #BB-B2 `/workers/draft-and-create` 500

**Status:** NO LIVE 500 REPRODUCED. Empty/missing/null/invalid JSON shapes returned clean 4xx on prod before and after deploy. Existing empty-prompt test is green.

### #BB-B5 Approval pause

**Status:** VERIFIED EXISTING. Prod worker `cxtest-b5-e35143b3`, run `run_37d0b3a562be`, reached `pending_approval`; no code change needed.

### #BB-P1 Follow-ups

**Status:** MIXED. A5, A6, A8 fixed; B6 verified on prod (`cxtest-b6-6f0aa63d` create + rotate); A7, A9, A10, B7, and P2 items remain open/skipped. Full evidence: `docs/audits/backend-batch-fix-2026-06-04.md`.

---

## Deep prod walk — UI batch (2026-06-05, N-series)

**Source:** Federico deep prod walk, N1–N27 series.

**PR:** https://github.com/floomhq/workeros/pull/433 (`ui/batch-deepwalk-fixes`)

### N1 (P0) — Emily chat UI / /assistant

**Status:** INVESTIGATED — NOT REGRESSED, NEVER EXISTED

**Finding:** No chat component ever existed in web. First commit of `apps/web/app/assistant/page.tsx` (f089491, 2026-06-01) is config-only (Instructions + Final Prompt tabs). Backend `/chat` SSE endpoint works. Web frontend has always been config-only; Slack is the designed chat interface. **Scope question for Federico: build a chat tab on /assistant or leave Slack as the sole chat interface?**

### N5 — Overview nav / inconsistent path

**Status:** FIXED (PR #433)

Sidebar logo links (desktop, mobile header, mobile drawer) changed from `/` to `/overview`. Nav item already detected both paths as active; canonical URL is now `/overview`.

### N7 — Missing secret badge lacks fix CTA

**Status:** FIXED (PR #433)

"Add secret →" inline link to `/secrets` added next to the "Missing secret" status badge in the worker header.

### N8 — Webhook placeholder looks real

**Status:** FIXED (PR #433)

Placeholder text changed from `https://hooks.example.com/run-events` to `e.g. https://hooks.example.com/run-events`.

### N10 — Brain tab "0 brain resources attached" while packs shown

**Status:** FIXED (PR #433)

Header copy when 0 attached now reads "No brain resources attached — toggle any pack below to attach it." instead of the misleading "0 brain resources attached".

### N11 — Pack with 0 files + 2 workers not clear

**Status:** FIXED (PR #433)

Pack file count: 0 files renders "Empty pack (no files yet)". Worker count only shows when > 0 ("used by N workers").

### N13 — Connections "Last used" shows "—" before async load

**Status:** FIXED (PR #433)

Added `lastUsedLoaded` state; ConnectionRow accepts `lastUsedLoading` prop; shows `<Skeleton>` while in flight instead of "—".

### N17 — Cmd-K palette missing Brain + Approvals; sidebar missing Settings

**Status:** FIXED (PR #433)

Cmd-K NAV now includes Brain and Approvals. Settings was already in the palette. Sidebar already had Brain/Approvals top-level; Settings reachable via profile dropdown — sidebar gap was palette-only.

### N18 — Worker attention reason buried in Runs, not on About

**Status:** FIXED (PR #433)

About tab shows an attention banner when `worker.status === "missing_secret"` listing required secret names + link to /secrets.

### N23 — Share modal clips left edge under sidebar at 1280px

**Status:** FIXED (PR #433)

`DialogContent` gets `md:translate-x-[120px]` to offset half the sidebar width, centering the modal over the content pane.

### N25 — Source tab Save shown when no edits pending

**Status:** FIXED (PR #433)

Raw/YAML Save + Discard buttons only render when `filesDirty === true`.

### N27 — Run-detail "Edit" misleadingly navigates to worker source

**Status:** FIXED (PR #433)

Button relabelled "Edit worker" to clarify destination.

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

---

## Emily chat persistence pass (2026-06-06)

**Scope:** Emily chat in `apps/web` (engine) — the dock (`EmilyDock`) and the
full-page chat (`EmilyChatPage` at `/chat`). Federico hit these live on
`workers.floom.dev`. Propagates to Cloud via engine sync (no Cloud-repo edits).

### EC1 — Conversation does not survive dock close→open, fullscreen toggle, or reload

**Status:** FIXED

**Root cause:** `useChatStream` held `messages` + `conversationId` in in-memory
`useState` only. Closing/reopening the dock, switching between the dock and
`/chat`, or reloading the browser dropped the in-memory state, so the chat
appeared to reset even though the server already persisted the conversation.

**Fix:** the active `conversationId` is persisted to `localStorage`
(`workeros.emily.conversationId`). On mount the hook fetches
`GET /conversations/{id}` (new `api.conversations.get`) and rehydrates server
messages + tool cards into the live `ChatMessage`/`MsgPart` shape via
`emily-chat-rehydrate.ts`. A `storage` event listener mirrors session changes
across the dock/full-page/other tabs.

### EC2 — No way to start a new conversation

**Status:** FIXED

**Fix:** a "New chat" control resets messages + conversationId and clears the
localStorage key, starting a fresh conversation. The previous conversation is
NOT deleted server-side (still retrievable via `GET /conversations/{id}`).

### EC3 — No way to export a conversation

**Status:** FIXED

**Fix:** an "Export" control downloads the current conversation as Markdown
(readable You/Emily turns, tool actions noted briefly) via
`emily-chat-export.ts`. A JSON export helper is included as a bonus.

### EC4 — Controls must be reachable in both dock and full-page chat

**Status:** FIXED

**Fix:** New chat + Export live in a controls bar inside the shared
`EmilyChatCore`, so both `EmilyDock` and `EmilyChatPage` get them.

**Evidence:** `apps/web` `npm run lint` (0 errors), `npm test` (33 passed),
`npm run build` (Compiled successfully). Targeted `tsc` of the new/changed
feature modules is clean; two pre-existing `tsc` errors in
`tests/useChatStream.test.ts` (`.title` on the `ToolCard` union, present on
origin/main, not exercised by CI's vitest+lint gate) are untouched.

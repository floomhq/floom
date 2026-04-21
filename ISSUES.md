# Floom — Launch-Blocker Issues

Last updated: 2026-04-21 (late evening — docs aligned with locked landing wireframe)

Status: OPEN / FIXING / FIXED / VERIFIED / DEFERRED.
Verification requires a live preview.floom.dev test with evidence (screenshot or terminal output), not just "code merged".

---

## LAUNCH WEEKEND DIRECTION (2026-04-21 lock, revised evening)

**Launch target: weekend 2026-04-25/26 (Sat-Sun).** Shifted from "launch today/tomorrow" for quality.

**Active workplan:** `/root/floom/WORKPLAN-20260421-launch-weekend.md` (gitignored; local source of truth for the week).

**Landing is locked to the wireframe:** `docs/wireframes/final-landing-wireframe.html`. Every string on the landing must match that file. No free-styling, no earlier synthesis.

**Landing copy (from wireframe):**

- **Eyebrow:** "Works with Claude, Cursor, GitHub, OpenAI"
- **H1:** "Ship AI apps fast."
- **Accent line (green):** "Vibe-coding speed. Production-grade safety."
- **Lede:** "Turn one app into every interface it needs. Paste your app's link. Get a Claude tool, shareable page, chat interface, CLI, and clean URL, with auth and history built in."
- **Wedge:** "Turn one app into every interface it needs." (lede's first sentence doubles as the wedge)
- **Hero input placeholder:** `github.com/you/lead-scoring-api`
- **Primary CTA:** "Publish your app"
- **Secondary CTAs:** "Browse live apps" / "Self-host in one command"
- **Proof row:** "1 app → many usable surfaces" / "45s to a publishable first version" / "Built-in auth, history, and boring stuff" / "OSS cloud or self-hosted path"
- **Self-host snippet:** `docker run -p 3010:3010 floomhq/floom`

**Superseded copy (do NOT ship):** "Your agent built it. You run it. Ship in one command." / "Turn any script into a live app with API, UI, and share link. No setup." — earlier synthesis that contradicted the wireframe. Removed from the docs set (this file, `WORKPLAN-20260421-launch-weekend.md`, `project_floom_positioning.md`, `project_floom_roadmap.md`).

**3 killer human-facing demos (launch catalog, matching the wireframe's live-apps strip)** — each: real input → non-trivial transformation → shareable output, 5-second comprehension:

1. **Lead Scorer** (HERO) — upload CSV, rank each row 0-100 with reason, return ranked table. Surfaces: Page + Claude + API.
2. **Competitor Analyzer** — paste one or more company URLs, get positioning + pricing + notable claims. Surfaces: Page + Chat + CLI.
3. **Resume Screener** — upload candidate CVs (PDF), rank against a job description. Surfaces: Page + Claude + API.

**Default model for demos: Gemini 3 + web search + URL context.** Not Claude. See `memory/feedback_no_claude_bias.md` for the rule; matches the `bulk.run` default and fits ICP / URL / CV extraction better (native grounding + URL fetch).

**Cuts from landing:** chatbots, tweet generators, summarizers, todos, CRUD dashboards.

**Catalog cleanup:** delist 9 broken first-party apps (no source / no Dockerfile). Demote 5 buildable utility apps (blast-radius, dep-check, claude-wrapped, session-recall, hook-stats) from hero to a utility tier below the fold on `/apps`.

**Minimum launch:** landing rewrite + Demo #1 (Lead Scorer). **Target launch:** all 3 demos.

**Runtime gap:** file/* input plumbing for CSV + PDF is IN FLIGHT on branch `feature/file-inputs-runtime-fix` (branch agent `a42fb0397fa8ed4e4`). Contract: container reads files at `/floom/inputs/<name>.<ext>`. Full plan: `/root/floom/WORKPLAN-20260421-file-inputs-root-fix.md`. If it slips, lead with Competitor Analyzer (URL-only, no file input) and punt Lead Scorer + Resume Screener to week 2.

**In-flight PRs (2026-04-21):**

- `#244` focus-mode `/p/:slug` + light-theme landing terminals — MERGED 16:35:06Z (fixes A16, A18)
- `#245` openapi-ingest `secrets_needed` — MERGED 16:35:02Z (fixes A17 root systemic bug)
- `#246` renderer react-dom + MCP URL derivation — MERGED (fixes B7 + B8)
- `#247` docs alignment with locked landing wireframe — OPEN (this doc set)

**New launch-weekend tickets:** L1 Landing rewrite (wireframe-verbatim), L2 Delist 9 broken apps, L3 Demo #1 Lead Scorer, L4 Demo #2 Competitor Analyzer, L5 Demo #3 Resume Screener. See bottom of file.

**Deferred to week 2 given demo-focused launch:** A3, A5, A7, A8, A14, A15 (unless a fix is trivial enough to land in passing).

---

## A1 — Landing input requires typing `github.com/` prefix
**Status:** FIXING (agent in flight)
**Severity:** P1 (UX friction on the most important conversion input)
**Where:** `apps/web/src/pages/CreatorHeroPage.tsx:472` — placeholder is `github.com/you/api`, aria-label accepts both GitHub repo and direct OpenAPI URL.
**Fix:** smart-normalize on submit. Accept `you/api`, `github.com/you/api`, `https://github.com/you/api`, or any full URL ending in `.yaml` / `.yml` / `.json` / `/openapi`. No hardcoded prefix badge because the input is dual-purpose.

## A2 — Private GitHub repos cannot be ingested
**Status:** FIXING (agent in flight)
**Severity:** P0 (blocks serious creators from publishing internal APIs)
**Where:** OpenAPI ingest currently does an anonymous HTTP fetch. No OAuth token path.
**Fix:**
- GitHub OAuth request `repo` scope (not just `read:user`).
- Store per-user GitHub access token encrypted in vault.
- On ingest, if URL is a private `github.com/<org>/<repo>`, use the user's token via `https://api.github.com/repos/<org>/<repo>/contents/<path>`.
- Fallback: "Paste a PAT" UI for users who don't want to OAuth the whole `repo` scope.

## A3 — App icons are all generic green + basic symbols
**Status:** DEFERRED to week 2 (2026-04-21 launch-weekend lock — unless trivial)
**Severity:** P1 (store looks fake / unfinished)
**Where:** `apps/web/src/components/hub/` + wherever `manifest.icon` is read.
**Fix:**
- Add a real icon system: `manifest.icon` can be a Lucide icon name, an emoji, a URL to an SVG, or a gradient-mark with monogram.
- For the 11 live apps, pick appropriate per-app Lucide icons (not the same green pill with a letter for all).
- Reference: Raycast Store, Linear integrations, Vercel Marketplace — each integration has a distinct mark.
- Hard rule (already in CLAUDE.md `memory/logos.md`): never text-in-circles, never invented monograms. Real Lucide or real SVG only.

## A4 — Missing "proper productivity" demo apps
**Status:** OPEN
**Severity:** P2 (not launch-blocking but the store feels thin)
**Where:** current 11 apps are all developer utilities (jwt-decode, base64, hash, uuid, password, json-format, word-count + 4 natives).
**Fix — suggested catalog additions for demo day:**
- Invoice generator (JSON → PDF)
- Receipt roast (image upload → LLM critique)
- Meeting notes to action items (paste → structured JSON)
- URL unshortener + safety report
- QR code generator with logo
- Color palette extractor from image
- Screenshot to OpenAPI (scan API docs image → spec)
- Cover letter generator (job post + CV → draft)
- Unit converter (natural language: "3 cups to ml")
- OG image generator (title + subtitle → PNG)

Each is a 1-file custom renderer + 1 OpenAPI spec. 30-60 min per app.

## A5 — Studio page is bloated when clicked pre-signin
**Status:** DEFERRED to week 2 (2026-04-21 launch-weekend lock — unless trivial)
**Severity:** P1 (first-impression damage for creators)
**Where:** `/studio/*` routes. Sidebar renders full creator toolkit (build, apps, memory, renderers, secrets, workspaces) even when no session exists.
**Fix:** pre-signin Studio shows a focused sign-in-to-start state: one short pitch, "Sign in with Google / GitHub", and a 3-bullet "what you get" list. Hide the full toolkit until session is live. Post-signin shows the current sidebar.

## A6 — Product page has duplicate "Run X" CTAs
**Status:** OPEN
**Severity:** P1 (confusion + trust hit)
**Where:** `/p/:slug` renders a "Run jwt-decode" button AND ~10 screen-inches below it the same run form with another submit button. Two run surfaces on the same page.
**Fix:** single run surface. If there's a separate "Try it" tab vs "Install" tab, that's fine, but one tab = one CTA. Audit all of `apps/web/src/pages/AppPermalinkPage.tsx`.

## A7 — No mock / example data on product page
**Status:** DEFERRED to week 2 (2026-04-21 launch-weekend lock — unless trivial; 4 demo pages will have real example inputs baked in)
**Severity:** P1 (demo friction: users have to guess valid input)
**Where:** /p/:slug run form has empty fields.
**Fix:** manifest gains `example_inputs: [...]`. `/p/:slug` renders a "Try example" button that pre-fills the form with valid input. Click → immediate run → output appears. Zero-typing demo path.
- For the 11 live apps, write example inputs (jwt for jwt-decode, sample string for base64, etc.)
- For ingested OpenAPI apps, pull from `examples:` in the spec if present.

## A8 — API-key apps don't surface "add your key" UI nicely
**Status:** DEFERRED to week 2 (2026-04-21 launch-weekend lock — unless trivial; 4 demos won't need caller-provided keys)
**Severity:** P1 (several catalog apps unusable because key input is hidden)
**Where:** Apps with `secrets_needed` + `caller_must_provide` policy. The backend supports it. The UI doesn't prompt clearly.
**Fix:** on /p/:slug run form, if the app needs a caller-provided secret, show a dedicated "Your API key" field with a hint ("Stored encrypted, never shared. Auto-revoke in 30 days by default.") + link to where the user can get the key (docs/signup page of the upstream API).

## A9 — Catalog sweep gave false positives; my delist plan was wrong
**Status:** REVERTED (PR #241 delist commits not merged; no apps actually delisted)
**Severity:** P1 (avoiding a self-inflicted wound)
**What happened:** first sweep ran from a single rate-limited IP. "429" + "intermittent upstream" + "truly dead" all got labeled "broken" together. Federico caught it — some of the supposedly broken apps worked when he tested.
**Correct plan:**
1. Re-verify each flagged app using `FLOOM_AUTH_TOKEN` admin bearer (bypasses rate limit, cleaner signal).
2. Run each app 2-3 times spaced out to distinguish "dead" from "flaky upstream."
3. Only after per-app manual confirmation: keep as-is / fix manifest / add key-input UI / delist.
4. Don't touch visibility in bulk.

## A8 (refined) — Surface secrets + versions somewhere clear on /p/:slug
**Status:** OPEN
**Refinement from Federico:** not necessarily a "tab"; just accessible. Could be a collapsible section, settings pane, or tabs — TBD. The requirement:
- If an app needs a caller-provided key, there must be a clearly labeled place on /p/:slug where the user inputs it (and optionally saves to their vault).
- App versions should be visible/accessible somewhere (for users to pin, for creators to bump).
- Work out final IA with the wireframes pass.

## A14 — "Your app is live" banner shown to anon viewers on /r/:id share links
**Status:** DEFERRED to week 2 (2026-04-21 launch-weekend lock — unless trivial)
**Severity:** P1 (confusing + misleading first impression for shared-link recipients)
**Where:** share / run-result page (likely `apps/web/src/pages/AppPermalinkPage.tsx` or a RunSharePage component) — banner text: "Your app is live / This link works for anyone — send it to coworkers, Twitter, anywhere. / Copy share link / Make another / Dismiss"
**Fix:** detect viewer-is-creator vs anon. Creator (in Studio) → keep congratulatory copy. Anon viewer on a shared link → neutral framing, e.g. "Someone shared this Floom app with you" + single CTA "Try it yourself" / "Explore the store." No "your app," no "make another."

## A18 — /p/:slug pushes run surface below the fold; no focus/run mode
**Status:** OPEN
**Severity:** P1 (returning users want to run, not read the marketing blurb again)
**Where:** `apps/web/src/pages/AppPermalinkPage.tsx` + related. Above the fold today: breadcrumb, big icon + name + version + "stable" badge, description paragraph, primary CTA ("Run JWT Decoder"), "Add to your tools" + Share, Category/License sidebar, tabs (Run / About / Install / Source). The actual run form + output land below the fold (screenshot 21.11.45).
**Fix:** restructure so opening `/p/:slug` drops the user straight into the execution surface.
- Compact header: icon + name on one line. Description → one line or tucked into an "About" tab.
- Run form + output are the hero content (above the fold).
- Category / License / "For developers" move to a collapsible details block or the About tab — not prime real estate.
- Remove the duplicate "Run <app>" CTA at the top (A6 already filed).
- Consider a `?run=1` or `/r/:slug` focus-mode URL that strips to the run surface only. Sidebar-free, minimal chrome, for power users and embedded contexts.
- Auto-focus the first input on mount.

## A16 — Dark terminal graphics clash with otherwise-light landing
**Status:** OPEN
**Severity:** P1 (feels AI-slop on a light page; three blocks reinforce each other)
**Where:** landing page, three hero/section code blocks:
1. UUID Generator demo widget — "// Output appears here after Run." on near-black bg (screenshot 21.16.40)
2. "Add any app to Claude in 3 lines" — `mcpServers` JSON block on dark bg with syntax colors (screenshot 21.16.44)
3. "Run it on your own box" — `$ docker run -p 3010:3010 floomhq/floom` on dark bg (screenshot 21.16.46)
**Fix:** light theme for all three. Light gray / off-white bg, slate text, a single subtle accent for syntax tokens. No full-dark containers on a light page. Match the rest of the landing's palette.

## A17 — Per-flagged-app root-cause audit required (replaces the delist sweep)
**Status:** AUDIT COMPLETE 2026-04-21 (awaiting fix/delist decisions); PR #241 still OPEN, unmerged
**Severity:** P0 (Federico: "document it properly before you continue fixing them")
**Scope:** every app that the original sweep flagged "broken" (30 apps in PR #241 diff) needed an individual root-cause record before we decide fix vs delist vs key-input UI vs leave-live.
**Method used:**
- Ran each slug 3 times (8s apart) via `/api/:slug/run` against preview backend on 127.0.0.1:3051
- `FLOOM_AUTH_TOKEN` is not set on the preview container (and the PR #241 admin-bypass code isn't deployed yet), so instead rotated a fresh fake public IP via `X-Forwarded-For` on every call — `FLOOM_TRUSTED_PROXY_CIDRS=172.16.0.0/12` trusts the loopback proxy, giving a fresh rate-limit bucket per request. 0 rate-limit 429s during the whole audit.
- Cross-referenced each upstream base_url with a direct HEAD probe to distinguish "host dead" from "path drift" from "key required".

**Per-app audit table:**


| slug | status | upstream | attempts | root cause | verdict | action |
|------|--------|----------|----------|-----------|---------|--------|
| `apimatic-api-transformer` | public (flagged) | `https://apimatic.io/api/transform` | 0/3 (ups=[None, None, None]) | enum input list too narrow — catalog enum doesn't match accepted values | **MANIFEST BUG** | fix catalog enum |
| `ecosystem-api` | public (flagged) | `https://api.apideck.com` | 0/3 (ups=[404, 404, 404]) | host alive (host live) — our paths point at stale version | **MANIFEST BUG** | re-ingest OpenAPI spec |
| `auckland-museum-api` | public (flagged) | `https://api.aucklandmuseum.com` | 0/3 (ups=[415, 415, 415]) | upstream rejects content-type (415); proxied-runner sent JSON where upstream wants form/xml | **OUR INGEST BUG** | fix openapi-ingest content-type resolution |
| `balldontlie` | public (flagged) | `https://balldontlie.io` | 0/3 (ups=[404, 404, 404]) | host alive (host live; api moved to api.balldontlie.io + requires key) — our cached OpenAPI path drifted vs current API | **MANIFEST BUG** | re-ingest OpenAPI spec |
| `radio-music-services` | public (flagged) | `https://rms.api.bbc.co.uk` | 0/3 (ups=[404, 404, 404]) | X-API-Key header shown as required text input (should be secret). Also: BBC RMS internal API; likely deprecated or partner-only — gated/deprecated | **OUR INGEST BUG + NEEDS USER API KEY** | fix openapi-ingest to emit secrets_needed for security params; then surface secret UI (A8) |
| `api-clarify-io` | public (flagged) | `https://api.clarify.io` | 0/3 (ups=[404, 404, 404]) | host 404 on /; service likely shut down | **UPSTREAM DEAD** | delist after launch |
| `cnab-online` | public (flagged) | `https://cnab-online.herokuapp.com/v1` | 0/3 (ups=[404, 404, 404]) | Heroku free-dyno host dead (Heroku killed free dynos Nov 2022) | **UPSTREAM DEAD** | delist after launch (dead) |
| `exchangerate-api` | public (flagged) | `https://api.exchangerate-api.com/v4` | 0/3 (ups=[404, 404, 404]) | host alive (host live) — our cached OpenAPI path drifted vs current API | **MANIFEST BUG** | re-ingest OpenAPI spec |
| `u-s-epa-enforcement-and-compliance-history-online-` | public (flagged) | `https://echodata.epa.gov/echo` | 0/3 (ups=[404, 404, 404]) | host gated — gated/deprecated | **UPSTREAM DEAD** | delist after launch OR investigate |
| `europeana-search-record-api` | public (flagged) | `https://api.europeana.eu` | 0/3 (ups=[400, 400, 400]) | wskey shown as required text input (should be secret). Also: upstream 400 — required upstream param not marked required in our manifest | **OUR INGEST BUG + NEEDS USER API KEY** | fix openapi-ingest to emit secrets_needed for security params; then surface secret UI (A8) |
| `exude-api-service` | public (flagged) | `https://exude-api.herokuapp.com` | 0/3 (ups=[404, 404, 404]) | Heroku free-dyno host dead (Heroku killed free dynos Nov 2022) | **UPSTREAM DEAD** | delist after launch (dead) |
| `geodatasource-location-search` | public (flagged) | `https://api.geodatasource.com` | 0/3 (ups=[404, 404, 404]) | key shown as required text input (should be secret). Also: host 404 on /; service moved behind key | **OUR INGEST BUG + NEEDS USER API KEY** | fix openapi-ingest to emit secrets_needed for security params; then surface secret UI (A8) |
| `highways-england-api` | public (flagged) | `https://webtris.highwaysengland.co.uk/api` | 0/3 (ups=[404, 404, 404]) | host alive (host live) — our cached OpenAPI path drifted vs current API | **MANIFEST BUG** | re-ingest OpenAPI spec |
| `handwrytten-api` | public (flagged) | `https://api.handwrytten.com/v1` | 0/3 (ups=[400, 400, 400]) | upstream 400 rejects for missing credentials | **NEEDS USER API KEY** | surface secret-input UI (A8) |
| `enanomapper-database` | public (flagged) | `https://api.ideaconsult.net/enanomapper` | 0/3 (ups=[400, 400, 400]) | upstream 400 — required upstream param not marked required in our manifest | **MANIFEST BUG** | mark input required or pick different example action |
| `image-charts` | public (flagged) | `https://image-charts.com` | 0/3 (ups=[400, 400, 400]) | upstream 400 — required upstream param not marked required in our manifest | **MANIFEST BUG** | mark input required or pick different example action |
| `ip2location-io-ip-geolocation-api` | public (flagged) | `https://api.ip2location.io` | 0/3 (ups=[401, 401, 401]) | upstream 401 — manifest has auth=none but upstream requires API key | **NEEDS USER API KEY** | surface secret-input UI (A8) |
| `ip2location-ip-geolocation` | public (flagged) | `https://api.ip2location.com/v2` | 0/3 (ups=[401, 401, 401]) | upstream 401 — manifest has auth=none but upstream requires API key | **NEEDS USER API KEY** | surface secret-input UI (A8) |
| `ip2proxy-proxy-detection` | public (flagged) | `https://api.ip2proxy.com` | 0/3 (ups=[401, 401, 401]) | upstream 401 — manifest has auth=none but upstream requires API key | **NEEDS USER API KEY** | surface secret-input UI (A8) |
| `api-isendpro` | public (flagged) | `https://apirest.isendpro.com/cgi-bin` | 0/3 (ups=[None, None, None]) | subAccountPassword shown as required text input (should be secret). Also: enum input list too narrow — catalog enum doesn't match accepted values | **OUR INGEST BUG + NEEDS USER API KEY** | fix openapi-ingest to emit secrets_needed for security params; then surface secret UI (A8) |
| `languagetool-api` | public (flagged) | `https://api.languagetoolplus.com/v2` | 0/3 (ups=[400, 400, 400]) | apiKey shown as required text input (should be secret). Also: upstream 400 — required upstream param not marked required in our manifest | **OUR INGEST BUG + NEEDS USER API KEY** | fix openapi-ingest to emit secrets_needed for security params; then surface secret UI (A8) |
| `magento-b2b` | public (flagged) | `https://example.com/rest/default` | 0/3 (ups=[405, 405, 405]) | password shown as required text input (should be secret). Also: upstream 405 — proxied-runner defaulted method instead of OpenAPI spec method | **OUR INGEST BUG + NEEDS USER API KEY** | fix openapi-ingest to emit secrets_needed for security params; then surface secret UI (A8) |
| `mtaa-api-documentation` | public (flagged) | `https://mtaa-api.herokuapp.com/api` | 0/3 (ups=[404, 404, 404]) | Heroku free-dyno host dead (Heroku killed free dynos Nov 2022) | **UPSTREAM DEAD** | delist after launch (dead) |
| `miataru` | public (flagged) | `https://service.miataru.com/v1` | 0/3 (ups=[400, 400, 400]) | upstream 400 — required upstream param not marked required in our manifest | **MANIFEST BUG** | mark input required or pick different example action |
| `health-repository-provider-specifications-for-hip` | public (flagged) | `https://dev.ndhm.gov.in/gateway` | 0/3 (ups=[404, 404, 404]) | clientSecret shown as required text input (should be secret). Also: host 404 | **OUR INGEST BUG + NEEDS USER API KEY** | fix openapi-ingest to emit secrets_needed for security params; then surface secret UI (A8) |
| `ntropy-transaction-api-v1` | public (flagged) | `https://api.ntropy.network` | 0/3 (ups=[404, 404, 404]) | host alive (host live) — method/path drift | **MANIFEST BUG** | re-ingest OpenAPI spec |
| `opencage-geocoder` | public (flagged) | `https://api.opencagedata.com/geocode` | 0/3 (ups=[400, 400, 400]) | key shown as required text input (should be secret). Also: upstream 400 — required upstream param not marked required in our manifest | **OUR INGEST BUG + NEEDS USER API KEY** | fix openapi-ingest to emit secrets_needed for security params; then surface secret UI (A8) |
| `daymet-single-pixel-extraction-tool-api` | public (flagged) | `https://daymet.ornl.gov/single-pixel` | 0/3 (ups=[400, 400, 400]) | upstream 400 — required upstream param not marked required in our manifest | **MANIFEST BUG** | mark input required or pick different example action |
| `osf-apiv2-documentation` | public (flagged) | `https://api.test.osf.io/v2` | 0/3 (ups=[404, 404, 404]) | host alive (host live (test.osf.io)) — our cached OpenAPI path drifted vs current API | **MANIFEST BUG** | re-ingest OpenAPI spec |
| `poemist-api` | public (flagged) | `https://www.poemist.com/api/v1` | 0/3 (ups=[404, 404, 404]) | host 403 on /; endpoints all 404 — gated/deprecated | **UPSTREAM DEAD** | delist after launch OR investigate |
### Summary

- **30 apps audited** (every slug PR #241 tried to flip to private). 0 rate-limit 429s during audit — XFF rotation via trusted-proxy CIDR (172.16.0.0/12) gave fresh buckets per request. Results are deterministic: 3/3 attempts matched for every single app. **Sweep flakiness was NOT the cause** for any of these; every failure is reproducible.

- **Verdict distribution:**
  - **11 MANIFEST BUG** (our catalog has stale OpenAPI-derived paths, enums, or required-field lists vs the live upstream)
  - **8 OUR INGEST BUG + NEEDS USER API KEY** (dual: openapi-ingest.ts listed security params like `apiKey`, `wskey`, `X-API-Key`, `password`, `clientSecret` as plain-text required inputs instead of emitting them as `secrets_needed`; upstream then 401/400s for missing credentials)
  - **6 UPSTREAM DEAD** (5 free-tier-Heroku hosts killed Nov 2022: cnab-online, exude-api-service, mtaa-api-documentation; plus api-clarify-io abandoned, poemist-api abandoned, u-s-epa-enforcement-and-compliance-history-online- gated)
  - **4 NEEDS USER API KEY** (auth metadata correctly dropped or not present; catalog still says `auth: none`; upstream 401)
  - **1 OUR INGEST BUG** (auckland-museum-api: upstream 415 because proxied-runner sends JSON where the upstream expects XML/SOAP; openapi-ingest didn't carry the content-type through)
  - **0 ACTUALLY WORKS** / **0 RATE-LIMITED** / **0 FLAKY**

- **Root systemic bug (affects >8 apps):** `scripts/build-catalog.ts` + `apps/server/src/services/openapi-ingest.ts` flow does not populate `secrets_needed` from OpenAPI `security` schemes. Parameters that live in the `security` section or are named `key`/`apiKey`/`wskey`/`X-API-Key` end up as required plain-text inputs in the action manifest. Fix this one ingest path and ~8 of the 30 apps move from "broken" to "needs key UI" (the A8 bring-your-own-key surface).

- **6 genuinely dead upstreams** can stay live until the A8 error-card copy is shipped (so the user at least sees "This upstream is offline" rather than a raw 404). Do not flip to private before launch; the sweep PR #241 over-reached by delisting everything indiscriminately.

- **OpenBlog is NOT one of these 30 apps.** It is a **first-party Floom app** (`author: federicodeponte`, `status: inactive` in the apps table) along with 13 other first-party apps (openpaper, openslides, openkeyword, openanalytics, opencontext, opengtm, blast-radius, dep-check, bouncer, claude-wrapped, session-recall, hook-stats, opendraft). These are hidden because their Docker images (`floom-app-app_yyyzfrybsv:v1` etc.) are not present on the preview host's local Docker registry. `POST /api/openblog/run` returns `"App is inactive, cannot run"`. This is a separate pre-launch issue (image publish/ingest pipeline) that is NOT addressed by PR #241. Tracked elsewhere in the Go-Public checklist.

- **Evidence files:**
  - Per-attempt JSON: `/tmp/floom-audit-results.json`
  - Full log: `/tmp/floom-audit.log`
  - Classified rows: `/tmp/floom-final-audit.json`
  - Audit script (reproducible): `/tmp/floom-audit.py`

### Do NOT act on this yet
- PR #241 stays OPEN. No merge, no close.
- No `visibility: private` flips. No `gh pr close`.
- Table is documentation only; awaiting Federico's fix/delist decisions.


## A15 — No top-nav tab for user's runs / execution view
**Status:** DEFERRED to week 2 (2026-04-21 launch-weekend lock — unless trivial)
**Severity:** P1 (users have nowhere obvious to find their past runs)
**Where:** top nav currently has Studio + Store only. `/me/runs` exists but is not surfaced.
**Fix:** add a third top-nav tab ("Runs" or "Execution") that routes to `/me/runs` (or a promoted `/runs`). Signed-out users: hide or route to sign-in. IA: Studio (build) / Store (discover) / Runs (use + history).

## A13 — "This box has lots of dead space" (screenshot pending)
**Status:** OPEN (awaiting screenshot — Mac Desktop path `Screenshot 2026-04-20 at 21.12.52.png` not found on sshfs mount)
**Severity:** TBD
**Action:** when screenshot available, identify which component has the dead space and tighten.

## A11 — "For developers" + "License" fields feel pointless / misplaced
**Status:** OPEN (needs clarification — which page)
**Severity:** P2 (clutter)
**Where:** likely Studio build form or /p/:slug. Federico's read: "then why have this field at all?" = user doesn't see value in the License field.
**Fix options:**
- If it's /p/:slug: move License into a small footer line, not a prominent field.
- If it's Studio build: default to MIT silently, expose only when user clicks "More options."
- If "For developers" is a section on /p/:slug showing code snippets: keep but collapse by default.
- Audit every form field against "would I fill this in on a first try?" Cut or defer anything that fails.

## A10 — OpenAPI importer bug (root cause of A8 + some of A9)
**Status:** OPEN (post-launch)
**Severity:** P2 (only matters when we regenerate the catalog from source)
**Where:** `scripts/build-catalog.ts`
**Fix:** field names matching `/key|apikey|token|secret|keyid|password/i` must land in `secrets_needed`, not `inputs.required[]`. Otherwise any catalog regeneration reintroduces the bug.

---

## Previously-caught P0s (still in flight)

## B1 — Forgot password is a `mailto:` link, not a real reset flow
**Status:** FIXING (agent `ae2ea3af03934e990`)
**Severity:** P0
**Fix:** Better Auth `sendResetPassword` hook + /forgot-password + /reset-password pages.

## B2 — /me/apps returns 404
**Status:** FIXING (same agent)

## B3 — Feedback button hidden on mobile
**Status:** FIXING (same agent)

## B4 — 404 page returns HTTP 200 (soft-404 SEO)
**Status:** FIXING (same agent; fix is `<meta name="robots" content="noindex">`)

## B5 — Cookie banner has 🍪 emoji
**Status:** FIXING (same agent)

## B6 — Rate limit 60/hr per anon IP is too tight
**Status:** FIXING (agent `ac98c34d5740c58a7`)
**Fix:** bump to 150/hr, cap retry_after_seconds at 300, add `FLOOM_AUTH_TOKEN` bypass for ops sweeps.

## B7 — Custom renderer upload returns `bundle_failed: Could not resolve "react-dom/client"`
**Status:** OPEN
**Severity:** P0 (blocks every creator trying to ship a custom renderer)
**Where:** `apps/server/src/services/renderer-bundler.ts` — `getReactNodePaths()`.
**Root cause:** `require.resolve('react/package.json')` returns a pnpm virtual-store dir that only contains `react`, not `react-dom`. esbuild's `nodePaths` ends up with one entry, so `import ReactDOM from 'react-dom/client'` fails.
**Fix:** also resolve `react-dom/package.json` and push its parent `node_modules` onto nodePaths. Include `jsx-runtime` in the candidate set.

## B8 — `ingest_app` MCP response hardcodes `https://floom.dev` URLs
**Status:** OPEN
**Severity:** P0 (copy-paste from an MCP client against preview breaks; users get prod URLs)
**Where:** `apps/server/src/routes/mcp.ts` near line 313 — `ingest_app` response builder.
**Fix:** derive base from `new URL(c.req.url).origin` (or `FLOOM_PUBLIC_ORIGIN` env + helper). Permalink + mcp_url must match the environment that served the request.

## B9 — Settings page can't edit name, description, category, or tags
**Status:** OPEN
**Severity:** P1 (creators can't rename or recategorize without delete + re-ingest)
**Where:** `apps/web/src/pages/StudioAppPage.tsx` (UI) + `apps/server/src/routes/hub.ts:374-378` (`PatchBody` Zod schema).
**Fix:** extend `PatchBody` to accept `name`, `description`, `category`, `tags`. Add inputs + an `updateAppMetadata` client method. Comment at `hub.ts:371` already acknowledges this as deferred.

## B10 — Timestamps display 2h off in non-UTC browsers
**Status:** OPEN
**Severity:** P1 (run history shows times in the future/past depending on locale)
**Where:** `apps/web/src/lib/time.ts` + SQLite `datetime('now')` default.
**Root cause:** SQLite stores `YYYY-MM-DD HH:MM:SS` with no `Z`. `new Date("2026-04-21 04:17:13")` in Europe/Berlin parses as local time.
**Fix:** append `Z` in the API response serializer, or parse explicitly as UTC in `time.ts` when the string has no timezone marker.

## B11 — Preview container 502s briefly during Docker ingest
**Status:** OPEN
**Severity:** P2 (self-heals after ~6s)
**Fix:** make Docker ingest non-restarting, or front with a warm proxy.

---

## Post-launch backlog (not launch-blocking)

- Dark mode toggle
- Cmd+K global command palette
- Catalog health gate in CI (auto-hide apps that break)
- Personal API tokens (per-user PATs for external agent publishing)
- Visible key-expiry timer on user secrets (Vikas's trust-page ask)
- Expand catalog with 10 productivity demos from A4

---

## LAUNCH-WEEKEND TICKETS (2026-04-21 lock, revised evening)

All five below are tracked in `/root/floom/WORKPLAN-20260421-launch-weekend.md`. Verification gates (Build / Visual-landing / Visual-demo / Regression) defined there. Tickets updated to match the locked wireframe at `docs/wireframes/final-landing-wireframe.html`.

## L1 — Landing rewrite (wireframe-verbatim)
**Status:** OPEN
**Severity:** P0 (launch-critical)
**Where:** `apps/web/src/pages/CreatorHeroPage.tsx` + related landing sections.
**Fix:** implement `docs/wireframes/final-landing-wireframe.html` verbatim, with these exact strings:
- Eyebrow: "Works with Claude, Cursor, GitHub, OpenAI"
- H1: "Ship AI apps fast."
- Accent line (green): "Vibe-coding speed. Production-grade safety."
- Lede: "Turn one app into every interface it needs. Paste your app's link. Get a Claude tool, shareable page, chat interface, CLI, and clean URL, with auth and history built in."
- Hero input placeholder: `github.com/you/lead-scoring-api`
- Primary CTA: "Publish your app"
- Secondary CTAs: "Browse live apps" / "Self-host in one command"
- Proof row (4 chips): "1 app → many usable surfaces" / "45s to a publishable first version" / "Built-in auth, history, and boring stuff" / "OSS cloud or self-hosted path"
- Killer-demo section directly under hero (Lead Scorer preview table + "Use in Claude / Open page / Call API" chips)
- Live-apps strip (3 rows): Lead Scorer / Competitor Analyzer / Resume Screener, each with the wireframe's tagline + surface mix
- Why-floom section (3 cards): "You built it. Now what?" / "Make it usable everywhere." / "No infrastructure detour."
- What-you-get grid (6 surfaces): Claude tool / Share page / Chat interface / CLI / Clean URL / Auth + history
- Flows section (3 columns): Deploy flow / User flow / Agent flow (4 steps each from wireframe)
- Self-host block: `docker run -p 3010:3010 floomhq/floom` (light-theme terminal, matches PR #244)

Do NOT ship the superseded synthesis copy ("Your agent built it. You run it. Ship in one command." / "Turn any script into a live app with API, UI, and share link. No setup." / 4-card demo grid). Remove any existing imagery for chatbots, tweet generators, summarizers, todos, CRUD dashboards.

## L2 — Delist 9 broken first-party catalog apps
**Status:** OPEN
**Severity:** P0 (launch-critical)
**Where:** seed data and/or DB rows for the first-party apps whose Docker images are absent on the preview host (see A17 summary).
**Fix:**
- Identify the 9 broken first-party apps (cross-ref A9 + A17 + the `floom-app-app_*:v1` absence list).
- Flip `visibility=private` or `status=inactive` so they don't appear on `/apps` or `/store`.
- Demote 5 buildable utility apps (blast-radius, dep-check, claude-wrapped, session-recall, hook-stats) to a utility section below the fold on `/apps`.
**Guardrail:** do NOT rerun the broad sweep from PR #241. Manually confirm each slug.

## L3 — Demo #1 Lead Scorer (HERO)
**Status:** OPEN
**Severity:** P0 (launch-critical — hero demo; minimum launch scope)
**Scope:** upload CSV of leads, Gemini 3 scores each row 0-100 with a one-line reason, return ranked table. Shareable via `?run=<id>`. Surfaces: Page + Claude + API.
**Dependencies:** file/* input plumbing (`feature/file-inputs-runtime-fix`, branch agent `a42fb0397fa8ed4e4`, contract: app reads CSV at `/floom/inputs/leads.csv`).
**Fix:**
- Manifest with `file/csv` input + example CSV.
- Backend: read CSV from `/floom/inputs/leads.csv`, Gemini 3 per-row scoring (with web search / URL context for any company-domain enrichment), serialize ranked JSON.
- Custom renderer: 3-column table matching the wireframe's killer-demo output (Lead / Score / Reason).
- Share URL restores run state.
**Model default:** Gemini 3, not Claude (per `memory/feedback_no_claude_bias.md`).

## L4 — Demo #2 Competitor Analyzer
**Status:** OPEN
**Severity:** P0 (launch-critical — no file-input dependency, safest shippable demo)
**Scope:** paste one or more company URLs, Gemini 3 fetches them (URL context) and extracts positioning + pricing + notable claims. Surfaces: Page + Chat + CLI.
**Fix:**
- Manifest: `input: { urls: string[] }`, `output: { competitors: [{ url, positioning, pricing, notable_claims }] }`.
- Backend: Gemini 3 URL context on each URL, structured-output schema.
- Custom renderer: per-competitor card.

## L5 — Demo #3 Resume Screener
**Status:** OPEN
**Severity:** P0 if file/* plumbing lands this weekend; else DEFERRED to week 2.
**Scope:** upload candidate CV (PDF) + job description text, Gemini 3 scores fit and extracts reasons. Surfaces: Page + Claude + API.
**Dependencies:** file/* input plumbing (`feature/file-inputs-runtime-fix`, contract: app reads PDF at `/floom/inputs/cv.pdf`).
**Fix:**
- Manifest: `file/pdf` input + `job_description: string` input.
- Backend: Gemini 3 PDF read + JD match scoring.
- Custom renderer: ranked candidate card with fit reasons.

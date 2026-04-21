# WORKPLAN — Floom launch weekend (2026-04-21 → 2026-04-26)

**Status:** ACTIVE
**Owner:** Federico + Claude (main agent + delegated subagents)
**Created:** 2026-04-21 (evening, Europe/Berlin)
**Revised:** 2026-04-21 (late evening) — aligned with locked landing wireframe `docs/wireframes/final-landing-wireframe.html`
**Launch target:** Sat-Sun 2026-04-25/26
**Scope mode:** REDUCTION — one-app-many-surfaces story, 3 demos, lean utility catalog

---

## Target

Ship Floom publicly on weekend 2026-04-25/26 with a landing page that matches the locked wireframe and three live demos.

**Landing (locked wireframe: `docs/wireframes/final-landing-wireframe.html`):**

- **Eyebrow:** "Works with Claude, Cursor, GitHub, OpenAI"
- **H1:** "Ship AI apps fast."
- **Accent line (green):** "Vibe-coding speed. Production-grade safety."
- **Lede:** "Turn one app into every interface it needs. Paste your app's link. Get a Claude tool, shareable page, chat interface, CLI, and clean URL, with auth and history built in."
- **Hero input placeholder:** `github.com/you/lead-scoring-api`
- **Primary CTA:** "Publish your app" → killer-demo section anchor
- **Secondary CTAs:** "Browse live apps" / "Self-host in one command"
- **Proof row (4 chips):** "1 app → many usable surfaces" / "45s to a publishable first version" / "Built-in auth, history, and boring stuff" / "OSS cloud or self-hosted path"
- **Killer demo directly under hero:** Lead Scorer (CSV upload → ranked conversion scores → "Use in Claude / Open page / Call API" chips)
- **Live apps strip (3 rows):**
  1. Lead Scorer — "Score inbound leads from a CSV upload" — surfaces: Page + Claude + API
  2. Competitor Analyzer — "Paste URLs, get positioning and pricing" — surfaces: Page + Chat + CLI
  3. Resume Screener — "Upload candidate CVs and rank them" — surfaces: Page + Claude + API
- **Why Floom (3 cards):** "You built it. Now what?" / "Make it usable everywhere." / "No infrastructure detour."
- **What you get (6 surface cards):** Claude tool / Share page / Chat interface / CLI / Clean URL / Auth + history
- **Flows (3 columns):** Deploy flow / User flow / Agent flow (4 steps each, as in wireframe)
- **Self-host block:** `docker run -p 3010:3010 floomhq/floom` (light-theme terminal, matches PR #244)

**3 killer demos on `/p/:slug`** (each: real input → non-trivial transformation → shareable output, 5-second comprehension):

1. **Lead Scorer** — upload CSV, rank rows 0-100 with reason, return ranked table (HERO — shown in the killer-demo section on the landing).
2. **Competitor Analyzer** — paste one or more company URLs, get positioning + pricing + notable claims.
3. **Resume Screener** — upload candidate CVs (PDF), rank against a job description.

**Default model for demo LLM calls: Gemini 3 + web search + URL context** (grounding + native URL fetch is the right tool for ICP / URL / CV extraction). Not Claude. This matches the `bulk.run` default and the explicit direction in `memory/feedback_no_claude_bias.md`.

**Catalog cleanup:**

- Delist 9 broken first-party apps (no source / no Dockerfile).
- Demote 5 buildable utility apps (blast-radius, dep-check, claude-wrapped, session-recall, hook-stats) to a utility tier below the fold.

**Minimum launch:** landing rewrite + Demo #1 (Lead Scorer) live.
**Target launch:** all 3 demos live with working share URLs.

**Runtime gap:** file/* input plumbing (CSV + PDF) lands via `feature/file-inputs-runtime-fix` (branch agent `a42fb0397fa8ed4e4`). See `/root/floom/WORKPLAN-20260421-file-inputs-root-fix.md`. Container-side contract: app reads files at `/floom/inputs/<name>.<ext>`. If plumbing slips, ship Competitor Analyzer as primary demo (URL-only, no file input needed) and punt the two file-input demos to week 2.

---

## After-compaction instructions (READ FIRST if context is fresh)

**If you are resuming after compaction, read these in order before doing anything:**

1. **`docs/wireframes/final-landing-wireframe.html`** — locked landing copy. Every word on the landing page must match this file unless Federico explicitly edits the wireframe.
2. **This workplan** (`/root/floom/WORKPLAN-20260421-launch-weekend.md`) — source of truth for the next 6 days.
3. **`/root/floom/WORKPLAN-20260421-file-inputs-root-fix.md`** — file/* input plumbing, IN FLIGHT, unblocks Demos #1 and #3.
4. **`/root/floom/ISSUES.md`** — open/fixing/fixed bug ledger. Top section "LAUNCH WEEKEND DIRECTION (2026-04-21 lock)" summarizes what changed.
5. **`/root/.claude/projects/-root/memory/project_floom_positioning.md`** — locked copy, wedge, 3-demo list, cuts.
6. **`/root/.claude/projects/-root/memory/project_floom_roadmap.md`** — canonical P0 ranking + what landed when.
7. **`/root/.claude/projects/-root/memory/feedback_no_claude_bias.md`** — default model for demos is Gemini 3, not Claude.
8. **`/var/www/wireframes-floom/autonomous/2026-04-17-ROADMAP.md`** — full state doc.

Then check in-flight agents: `ls -lt /tmp/claude-0/-root/*/tasks/ 2>/dev/null | head -20`.

Then check PR status: `gh pr list --repo floomhq/floom --state open`.

Only after that, pick the next item in "Daily breakdown" below.

---

## Daily breakdown

### Tuesday evening 2026-04-21 (today)

- **Scope lock v2.** Landing wireframe locked to `docs/wireframes/final-landing-wireframe.html`. Positioning memory, roadmap memory, wireframes roadmap, ISSUES.md updated to match.
- **PRs landed today** (evening window):
  - `#244` focus-mode `/p/:slug` + light-theme landing terminals — MERGED 16:35:06Z.
  - `#245` openapi-ingest `secrets_needed` — MERGED 16:35:02Z.
  - `#246` renderer react-dom + MCP URL derivation — MERGED (see `git log --oneline -5` on main).
  - `#247` docs alignment with locked wireframe — OPEN (this PR).
- **File/* input plumbing** (`feature/file-inputs-runtime-fix`) running in background per `WORKPLAN-20260421-file-inputs-root-fix.md`. Blocks Lead Scorer + Resume Screener demos.

### Wednesday 2026-04-22 — landing rewrite + delist

**Morning:**

- **L1 Landing rewrite** (subagent, `apps/web/src/pages/CreatorHeroPage.tsx` + landing sections):
  - Implement the wireframe verbatim: eyebrow, H1, accent line, lede, hero input, proof row, killer-demo section, live-apps strip, why-floom cards, what-you-get surface grid, three flows, self-host block.
  - No "Your agent built it. You run it." copy. No "Turn any script into a live app with API, UI, and share link." No 4-demo card grid. Those are from a previous synthesis that contradicted the wireframe.
  - Keep the light-theme terminals from PR #244.
- **L2 Delist 9 broken first-party apps** (subagent):
  - Identify the 9 broken first-party catalog apps (cross-ref ISSUES A9 + A17 + the `floom-app-app_*:v1` image absence list in A17).
  - Flip `visibility=private` or `status=inactive` so they don't surface on `/apps` or `/store`.
  - Demote the 5 buildable utility apps (blast-radius, dep-check, claude-wrapped, session-recall, hook-stats) to a utility section below the fold on `/apps`.

**Afternoon:**

- **L3 Demo #1 Lead Scorer** (subagent, depends on `feature/file-inputs-runtime-fix` landing):
  - Manifest with `file/csv` input (reads from `/floom/inputs/leads.csv` inside the container per file-inputs contract).
  - Example input CSV shipped alongside the manifest.
  - Model: Gemini 3 (not Claude). Use URL context for any domain enrichment lookups on the lead rows.
  - Custom renderer: ranked table matching the wireframe's killer-demo output (Lead / Score / Reason columns).
  - Share URL restores the run state.

**End-of-day gate:** landing build passes and preview renders the wireframe-matching page; 9 apps delisted; Lead Scorer manifest drafted; file-inputs plumbing lands.

### Thursday 2026-04-23 — Demos #2 and #3

- **L4 Demo #2 Competitor Analyzer** — URL-only demo, no file input dependency:
  - Manifest: `input: { urls: string[] }`, `output: { competitors: [{ url, positioning, pricing, notable_claims }] }`.
  - Backend: fetch each URL via Gemini 3 URL context, extract structured positioning + pricing.
  - Custom renderer: per-competitor card (PR #246 already merged; renderers stable).
- **L5 Demo #3 Resume Screener** — file input demo, depends on file-inputs plumbing:
  - Manifest: `file/pdf` input (reads from `/floom/inputs/cv.pdf`) + `job_description: string` input.
  - Backend: Gemini 3 PDF read + JD match scoring.
  - Custom renderer: ranked candidate list with fit reasons.

**End-of-day gate:** Demo #1 runs end-to-end on preview, Demos #2 + #3 manifests + backend ingest complete.

### Friday 2026-04-24 — polish and regression

- Demo #1 / #2 / #3 live on preview. Run each 5 times with varied input, eyeball the renderer.
- Check every `/p/:slug` loads under 450ms for the 7 existing featured apps.
- Regression sweep: landing 200, `/apps` 200, Google OAuth round-trip, GitHub OAuth round-trip.
- Copy audit on the landing: every line, eyebrow, chip, card, flow step must match the wireframe.
- Empty-state design for the live-apps strip if any of the three demos isn't shipping.

**End-of-day gate:** all three demos live on preview OR Lead Scorer + Competitor Analyzer live with explicit "more shipping" placeholder for the Resume Screener slot.

### Saturday 2026-04-25 — deploy

- **Morning:** visual QA. Take screenshots of the landing (hero, killer-demo, live-apps, why-floom, what-you-get, flows, self-host) and the three `/p/:slug` pages. Diff against `docs/wireframes/final-landing-wireframe.html`.
- **Deploy to floom.dev prod:**
  - `cd ~/floom && docker build -t floom-web:latest .`
  - `cd /opt/floom-deploy && docker compose up -d --no-deps prod`
  - Verify waitlist is OFF (`NEXT_PUBLIC_WAITLIST_MODE=false`).
- **Afternoon:** LAUNCH. Announce to X, LinkedIn, Discord, WhatsApp group. Share Lead Scorer URL as the hero demo.

### Sunday 2026-04-26 — launch day 2 + triage

- Monitor logs, respond to feedback, hot-fix any P0 issues.
- Collect feedback into ISSUES.md for week-2 planning.

---

## Verification protocol (3 gates)

No item is marked DONE until all three gates pass.

### Gate 1: Build

- `pnpm -r typecheck` exits 0.
- `pnpm --filter @floom/server test` exits 0 with 0 failures.
- `pnpm --filter @floom/web build` produces a clean bundle.
- Evidence: terminal output with exit code, pasted into the execution log below.

### Gate 2: Visual (landing)

- Landing page loads to HTTP 200 within 3s.
- Eyebrow, H1, accent line, lede, hero input placeholder, proof row (4 chips), killer-demo, live-apps strip (3 rows), why-floom (3 cards), what-you-get (6 surfaces), flows (3 columns), self-host block all render.
- Every string on the landing matches `docs/wireframes/final-landing-wireframe.html`. Zero drift.
- Evidence: side-by-side screenshot of rendered landing vs wireframe.

### Gate 2b: Visual (demos)

For each `/p/:slug` demo page (Lead Scorer, Competitor Analyzer, Resume Screener — or the shipped subset):

- Page loads to HTTP 200 within 3s.
- Run button is visible above the fold (focus-mode from PR #244 active).
- Clicking Run focuses the first input field.
- For file-input demos, drag-drop + file picker both work; the container reads the file at `/floom/inputs/<name>.<ext>`.
- Submitting valid input renders a non-trivial output (not just a raw JSON dump).
- Share URL (`?run=<id>`) works: copy, open in incognito, output restores.
- Evidence: screenshot per demo pasted into the execution log.

### Gate 3: Regression

- Landing page returns HTTP 200 and renders the new hero.
- `/apps` (or `/store`) returns HTTP 200 and shows the cleaned catalog (no delisted apps, utility tier below the fold).
- Google OAuth: click sign-in, lands on Google consent screen, no errors.
- GitHub OAuth: same.
- The 7 existing featured apps (`/p/jwt-decode`, `/p/json-format`, `/p/password`, `/p/uuid` + 3 others) still load under 450ms end-to-end.
- Evidence: HTTP status + screenshot proof per route pasted into the execution log.

---

## In-flight PRs (live)

| PR | Title | Status | Blocking? |
|---|---|---|---|
| [#244](https://github.com/floomhq/floom/pull/244) | fix: light-theme landing terminals + compact focus mode on /p/:slug | MERGED 2026-04-21T16:35:06Z | No |
| [#245](https://github.com/floomhq/floom/pull/245) | fix(openapi-ingest): emit secrets_needed for auth schemes | MERGED 2026-04-21T16:35:02Z | No |
| [#246](https://github.com/floomhq/floom/pull/246) | fix: renderer react-dom bundle + MCP URL derivation | MERGED | No (unblocks custom renderers) |
| [#247](https://github.com/floomhq/floom/pull/247) | docs: align launch-weekend docs with locked landing wireframe | OPEN (this PR) | No |

**File/* input plumbing:** `feature/file-inputs-runtime-fix` — branch agent `a42fb0397fa8ed4e4` — IN FLIGHT. Blocks Demos #1 and #3 (Lead Scorer CSV, Resume Screener PDF). Details in `WORKPLAN-20260421-file-inputs-root-fix.md`.

---

## Federico-owned blockers

- **Launch announcement copy**: X / LinkedIn / Discord / WhatsApp broadcast message.
- **Legal minimum**: imprint + privacy + terms + cookie stubs (Floom, Inc., Delaware jurisdiction). Blocks production go-live if missing.
- **Pricing page decision**: is `/pricing` public pre-launch or post?
- **FlyFast 403**: rotate token or disable FlyFast from the store. Not demo-critical but shows poorly if hit during launch demo.

---

## Execution log

Append entries as work progresses. Include: timestamp, what was done, evidence (PR link, commit SHA, screenshot path, terminal output).

### 2026-04-21 (Tue, evening)

- 18:00Z — workplan v1 created; positioning + roadmap memories updated; ISSUES.md launch direction header added; wireframes source-of-truth doc updated.
- PRs landed: #244 (16:35:06Z), #245 (16:35:02Z), #246 merged on main.
- (pending) subagent: runtime CSV audit output.
- **~20:00Z — workplan v2 (this rewrite).** Landing wireframe locked to `docs/wireframes/final-landing-wireframe.html`. Old "Your agent built it. You run it." copy removed from this plan, ISSUES.md, positioning memory, roadmap memory. Demos trimmed from 4 to 3 (Lead Scorer / Competitor Analyzer / Resume Screener) to match the wireframe's live-apps strip. Default LLM for demos set to Gemini 3 per `feedback_no_claude_bias.md`. File/* input plumbing (WORKPLAN-20260421-file-inputs-root-fix.md, branch `feature/file-inputs-runtime-fix`, agent `a42fb0397fa8ed4e4`) referenced as the dependency for CSV + PDF demos.

### 2026-04-22 (Wed) — landing rewrite + delist

- _empty — fill as work happens_

### 2026-04-23 (Thu) — Demos #2 and #3

- _empty_

### 2026-04-24 (Fri) — polish and regression

- _empty_

### 2026-04-25 (Sat) — deploy

- _empty_

### 2026-04-26 (Sun) — launch day 2

- _empty_

---

## Scope contract

If any of the following is proposed during the weekend, **push back and log the deviation** here before changing scope:

- Adding a 4th demo to the landing's live-apps strip.
- Re-adding any of the cut landing categories (chatbots, tweet generators, summarizers, todos, CRUD dashboards).
- Rolling back the delist of the 9 broken apps.
- Reintroducing the "Your agent built it. You run it." copy anywhere on the landing.
- Swapping the demo default model away from Gemini 3 without a concrete task-fit reason.
- Shipping a new feature not on this workplan.

Scope creep beats the launch. Reduction is the mode. The wireframe is the contract.

# Floom Workeros Roadmap

Tracks decisions and scope beyond V0 (V0 spec lives in `SPEC.md`). Each item lists status, decision rationale, and order.

Last updated: 2026-05-25

---

---

## Priority order (corrected 2026-05-26)

Federico 2026-05-26: "skills-based markdown workers should come much earlier than the calendar view." Reordering by strategic importance, not by build effort. The literal section order in this file is HISTORICAL (append-only as decisions landed); this priority list overrides it.

### Tier 0 — done (shipped this session)
- V0 spec § 25 MVP
- F1 sandbox abstraction (local + e2b per-worker)
- F2 cron scheduler
- F3 webhook trigger with HMAC
- Composio Connections
- Design v2 (glass material, theme toggle, blue accent)
- V1 UX (worker creation UI, manifest viewer, log search, structured errors, secrets CRUD, runs export)

### Tier 1 — foundational primitives (DO NEXT; aligns workeros with skills-neo)
**Strategic gate: every Tier-1 item should also exist on skills-neo's live-skills branch. Same primitive logic.**

1. **WorkerContract migration** — adopt skills-neo's `@floom/shared` manifest schema; split `skill_version` (recipe) vs `worker` (instance). Unlocks marketplace install path from skills.floom.dev.
2. **Skill-based markdown workers (`runtime.type: skill`, entrypoint `SKILL.md`)** — the connection between skills.floom.dev (library) and workeros (runtime). Non-developers write a markdown spec; LLM executes. **NEW primitive for BOTH workeros and skills-neo** — both products need it built.
3. **Capability grants (fail-closed)** — declared `secrets[]` + `network.egress: boolean`. Migrate 8 existing workers to declare what they need.
4. **Content-hashed file input bindings** — port `apps/web/lib/live-skills/file-inputs.ts` pattern from skills-neo. Per-worker + per-run authorization.
5. **5 upstream PRs to skills-neo `live-skills-v0x-schema` branch** — `label`, `placeholder`, `description`, `select+options`, `approvals` block. Backward-compatible additions to `@floom/shared` Zod schema.

### Tier 2 — visibility + UX (after primitives align)
6. **Connections page polish** — real Composio logos + OAuth scopes display
7. **Skeleton visual fix** — radius mismatch, dark-mode contrast (broker-blocked diagnosis, queued)
8. **Worker descriptions richer** — `long_description`, `tags`, `use_cases`, `example_input` in worker.yml
9. **Empty-state CTAs** everywhere
10. **Post-run actions** — copy, use-as-input, schedule, retry
11. **Per-error-type CTAs** — "what to do next" wired to each error class
12. **Outgoing HMAC notify URLs** (port `notify-url.ts` from live-skills)

### Tier 3 — automation + observability surfaces
13. **Daily health checks + alerts** (connection liveness, secret tests)
14. **Calendar view of scheduled runs**
15. **⌘K palette + global search**
16. **Notifications** (browser + email + Slack)
17. **Help / docs / changelog in-app**

### Tier 4 — distribution + scale
18. **Library mode SDK** — `@floom.worker` decorator (Shape A) + observability SDK (Shape B)
19. **Multi-user / team workspaces** — auth, per-user secrets, role separation

### Tier 5 — parked (revisit later)
- Real pause-resume approvals (V2; resurfaces only when an action-taking worker needs it)
- Multi-agent PR review loop (concept only)
- Mobile = monitoring-surface positioning

---

*Below this line: original append-only sections documenting individual decisions. Read for "why" + raw quotes. The Priority Order above is the canonical sequence.*

## V1 (shipping now / shipped)

| Item | Status | Notes |
|---|---|---|
| Approvals OFF by default | shipped (PR #12) | Approvals UI hidden (PR #10) until real pause-resume model lands |
| UI worker creation (`/workers/new`) | shipped (PR #12) | Form + live YAML preview + run.py textarea |
| Manifest tab on worker detail | shipped (PR #12) | Raw `worker.yml` viewable read-only |
| Run observability: log search + step timings + structured error panel | shipped (PR #12) | No token cost (spec § 18 excludes) |
| Skills-neo design system port (tokens + theme toggle + glass material) | shipped (PR #13 + #14) | Light + dark, Inter + JetBrains Mono, blue accent #3a6ea5, glass cards + ambient bg |
| Composio Connections | shipped (PR #11) | OAuth via Composio, demo worker `gmail_intake_brief`, capability declared in `worker.yml` as `connections:` |
| Settings: full secret CRUD | shipped (PR #12) | Add / test / update / delete |
| Runs filters + CSV export | shipped (PR #12) | Worker, status, date filters; export all from Overview |

---

## V1.5 (queued — Federico-approved, build when next round opens)

### Worker composition (cross-worker invocation)
- `context.workers.invoke(id, inputs)` — sync call from one worker into another
- Use case: Gmail Intake worker invokes Research Brief worker on each email
- Federico 2026-05-25: "would be pretty cool, to be honest" — non-blocking, but queued

### Capability declarations in worker.yml (fail-closed)
Extend `worker.yml` to declare what each worker can access. Default = nothing. Worker fails if it tries something undeclared.

```yaml
connections: [gmail, linkedin]      # already shipped in PR #11
skills:      [research_brief_v2]    # Floom skill library access
workers:     [research_brief]       # which other workers this one can invoke
artifacts_from: [run_*]             # cross-run artifact reads
```

### Sandbox abstraction (per-worker: local | e2b)
- Federico 2026-05-25: "we already discussed that i want sandbox logic? either local or e2b? since different workers might need different requirements/dependencies?"
- **Decision: sandbox is per-worker, declared in `worker.yml`.** Worker A may need OpenAI only (runs `local` fine), Worker B may need heavy deps or untrusted code (`e2b`). User chooses.
- Manifest shape:
```yaml
runtime:
  type: python
  entrypoint: run.py
  runner: local   # or 'e2b'
```
- Implementation: port the `SandboxDriver` interface from skills-neo live-skills (apps/web/lib/live-skills/sandbox/). Two drivers ship at minimum: `local` (Python subprocess in workers venv) and `e2b` (sandbox API, installs requirements.txt per run, captures stdout/stderr/output.json).
- E2B drivers in live-skills (TS): we port the logic to Python. Same logical contract, different language.

### Schedule trigger (cron)
- Spec § 11.2. Per-worker cron via `trigger.type: schedule` + `trigger.cron: "0 9 * * MON"`.
- Implementation: FastAPI background task (asyncio loop) that polls workers every minute, picks workers with `next_run_at <= now`, creates a run. Same pattern as live-skills `scheduler.test.ts`.
- New DB column `next_run_at` on workers OR new `schedules` table (spec § 13.7 already declares it). Port the existing scaffolded schedules table.
- UI: nothing new required — schedule status visible on worker detail (and roadmap'd `/calendar` view later).

### Webhook trigger (incoming)
- Spec § 11.3. Each worker gets `POST /webhooks/{worker_id}`. Body becomes the run input.
- Worker.yml: `trigger.type: webhook` + optional `webhook.secret` (HMAC-signed) + `webhook.allowed_origins`.
- Implementation: new FastAPI route. Validate worker exists + (if secret declared) verify HMAC of request body. Create a run with `trigger_source: webhook` and the request body as inputs.
- Same security model as live-skills `notify-url.ts` + `runner.ts` HMAC.

### Floom MCP as the unified tool surface
Federico 2026-05-25: "Workers don't need much apart from whatever they already have in their SDK. OpenAI, Anthropic, Gemini already have search web and tools like that in their SDK, right? Just the MCP of Floom, with whatever guardrails and stuff, would be through the connections. The Composio connections. This MCP obviously also would include other skills."

Concrete: Floom exposes a single MCP server that workers connect to. Behind the MCP:
- Connections (Composio) — gated tools (gmail.send, slack.post, etc.)
- Skills library — invokable as MCP tools
- (eventually) other workers — invokable as MCP tools

Workers don't declare individual tools; they declare which MCP namespaces they get (`connections: [gmail]` → MCP exposes `gmail.*` tools).

Built-in SDK tools (OpenAI web search, Anthropic computer use, Gemini code interpreter) stay handled by the SDK, not Floom.

### Multi-action workers
Federico 2026-05-25: agreed on **option A** — multiple actions per worker. Each action has its own inputs/outputs/function.

Shape (per Federico's pick):
- Folder structure: each action gets its own Python file under the worker folder
- `worker.yml` declares actions with their inputs:
```yaml
actions:
  - id: fetch
    label: Fetch unread
    entrypoint: fetch.py
    inputs: [{name: query, type: text, default: "is:unread"}]
    outputs: [{name: messages, type: json}]
  - id: draft
    label: Draft reply
    entrypoint: draft.py
    inputs: [{name: message_id, type: text}]
    outputs: [{name: draft, type: markdown}]
  - id: send
    label: Send reply
    entrypoint: send.py
    inputs: [{name: message_id, type: text}, {name: body, type: textarea}]
    outputs: [{name: sent_id, type: text}]
```
- UI: worker detail page gets a tab per action, each with its own auto-form
- Migration: existing single-action workers continue to work (1 implicit action = whole worker)

### Zero-cost action label
Optional `cost_class: zero | llm | external_api` field per action. UI shows "Free" badge for `zero`. Cosmetic, low priority.

---

## V2+ (parked — concept stage, no commitment)

### Action without LLM tokens
Sub-class of multi-action workers. Pure deterministic actions (DB query, fetch URL, send Slack) that don't burn LLM budget. Already possible (any Python), but UI labeling is a nice signal.

### Multi-agent PR review loop
Federico 2026-05-25: "PR agent invokes other agent if not happy yet to continue with feedback. This idea of the other agent reviews is just a concept, but we don't have to have it now, so the PR thing is definitely overshoot."

Concept: when one worker writes/edits skills or context, it opens a PR with proof; another worker (the reviewer) reads, scores, and either approves or requests changes. Iterates until pass.

Parked entirely. Revisit only after V1.5 lands.

### Real pause-resume approvals
Spec § 3.6 approvals are currently fake (review-after-output, no actual side-effect gate — see ADR comment in PR #10). To make them real:
- Worker calls `await context.request_approval(preview)` mid-execution
- Runner serializes worker state, marks run as `pending_approval`
- Human decides
- Runner resumes worker from the await point
- Worker proceeds with side effect OR aborts

Build day: requires async-resumable runner (Python async generators or task continuations). E2B-based runners get this for free if the sandbox supports task resume.

### Schedule + Webhook triggers — promoted to V1.5
Federico 2026-05-25: "obv we need cron and webhook for workeros, wasnt this discussed?" Yes — moved to V1.5 (see above section).

### CLI maturity
- `floom dev / reload / worker create / run` already shipped (PR #12)
- Roadmap: `floom worker test <id>` (run with fixtures), `floom worker publish <id>` (push to skills marketplace), `floom secret rotate <name>`

### Multi-user / team workspaces
- Spec § 20 Phase 4
- Single-user today (Federico behind Vercel SSO)
- Multi-user requires real auth + per-user secrets + per-user connections + role separation. ~10x scope.
- Park until external user actually wants it (e.g., Search Assistant's 6 FTE need 6 logins).

---

## Open design questions (waiting on Federico)

### Q1: Composition shape — sync vs async
When worker A invokes worker B via `context.workers.invoke()`:
- **Sync (block):** simpler, worker A halts until B completes. Easy to reason about.
- **Async (fire+forget+callback):** unlocks fan-out (1 worker spawns N children). Requires coordination layer.
- Federico has not picked. Default: sync until a real use case demands async.

### Q2: Multi-action worker file layout — already decided
- Federico 2026-05-25: option A — multiple files per folder, declared in `worker.yml` `actions:`. ✅ locked.

### Q3: E2B-default or per-worker selection — RESOLVED
- Federico 2026-05-25: per-worker selection (`runner: local | e2b` in worker.yml). Both drivers ship. ✅ locked.
- Federico 2026-05-25: leaning "everything on E2B" but open to challenge. ✅ default = E2B; trusted-local stays as dev/debug only.

---

## Notes / context

- **Spec lives in `SPEC.md`**: V0 reference, do not edit unless explicitly redrafting V0.
- **This file**: V1+ decisions and scope. Edit freely as decisions land.
- **Decisions need a date + source** (e.g., "Federico 2026-05-25"). No anonymous "we decided".
- **Roadmap is NOT a backlog**: only items Federico has approved go here. Backlog of "could-do" lives in chat / memory until promoted.

---

## V2 candidate — Library mode (workers-as-SDK, not folder-based)

Federico 2026-05-25: "how people can use this like sentry/posthog/langfuse by simply adding import statements to their cron jobs or so? would make this even more flexible? this could maybe be a stripped down minimal version of this?"

Two shapes:

### Shape A — Decorator (workers-as-library)
Existing functions become Floom workers via `@floom.worker(...)`. Full Floom semantics layered on top.

```python
from floom import worker

@worker(id="enrich_leads", inputs=[{"name": "rows", "type": "json"}], outputs=[{"name": "enriched", "type": "csv"}])
def enrich_leads(rows: list) -> dict:
    # ... existing code ...
    return {"status": "success", "outputs": {"enriched": "..."}}
```

Their existing cron / Docker / Lambda calls `enrich_leads(rows=...)` exactly the same. The decorator:
- Registers the function with the Floom backend on first call
- Wraps invocations as runs (creates run record, captures logs, stores output)
- Surfaces in `workers.floom.dev` UI alongside folder-based workers
- Honors `secrets:` / `connections:` declarations

Distribution wedge: zero migration. Existing cron jobs adopt Floom by adding a decorator, not by restructuring the codebase.

### Shape B — Observability SDK (Sentry/PostHog style)
Lighter. Their function stays a plain function. They emit telemetry to Floom.

```python
import floom
floom.init(api_key="ak_...")

def my_cron():
    with floom.run("daily_enrich"):
        floom.log("starting")
        # ... existing code ...
        floom.capture_output({"enriched_count": 42})
```

Less invasive but also less powerful: no run form, no approvals, no auto-trigger.

### Why this matters
Today's workeros requires the user to restructure their existing code into `workers/<id>/worker.yml + run.py` and host it on the Floom backend. That's friction for anyone with an existing codebase.

Library mode means Floom integrates with how people already run code (cron, Lambda, Docker, GitHub Actions) instead of demanding they migrate. Same trajectory Sentry/PostHog/Langfuse took.

### Scope when this gets built
- Shape A first (more value, more interesting). Shape B can come as a subset.
- Backend changes minimal: the worker registry already takes config; library mode just sends config + invocations over HTTP instead of from disk.
- New artifact: `pip install floom-sdk` published to PyPI.
- Open question: how does library-mode worker code show up in the UI for inspection? (No `worker.yml` on disk — just the decorator config registered remotely.)

Parked V2. Worth revisiting after V1.5 lands.

---

## V1.5+ — Observability and Visibility expansion

Federico 2026-05-25: "for observability: i feel like there could be more? like what is everything i know to know if all works smooth or not? and also for connections and secrets we should check them every day? and add to alerts if failed? and what else is important? maybe even a calendar view of all scheduled runs? like we need to make this more visual. and the workers itself with descriptions of what they do?"

### System Health surface
A single "is everything OK?" page (likely an upgraded Overview):
- Worker fleet health (count by status: healthy / needs_attention / paused / missing_secret / error)
- Recent failures grouped by worker (last 24h)
- Connection liveness: every Composio Connection pinged daily, status badge (Active / Expired / Failing)
- Secret health: every declared secret in any worker's `worker.yml` checked (OPENAI_API_KEY → tiny test call; generic key → just env presence) — daily
- Run volume: 7-day sparkline of runs/day, faled-runs/day
- Cost (FUTURE — spec § 18 currently excludes; revisit if needed)
- Average run duration per worker (trend up = slowing down)

### Daily health checks (cron-driven)
- 6am daily background job iterates connections + secrets + recent runs
- Writes a `system_health` snapshot row
- Sends alert if any: connection expired, secret unreachable, > N% failed runs, worker missing a secret it needs

### Alerts
Channels to support, in order: in-UI banner (red bar at top when something's broken), email (via Resend), optional Slack webhook (per-team setting), optional WhatsApp via Federico's clawdbot stack.

Trigger conditions:
- Connection status flips from Active → anything else
- Secret test fails (e.g., OpenAI 401)
- Worker fails N times in a row
- Scheduled run misses its window
- Disk usage on artifact directory > 80%

### Calendar view of scheduled runs
- New `/calendar` page (between Runs and Approvals in nav, or as a Runs sub-tab)
- Week/month view, each scheduled run plotted at its next-fire time
- Past runs shown as completed/failed dots
- Click a run → detail page
- Lights up the moment Schedule trigger lands (currently V0.5 spec)

### Worker descriptions richer than `description:`
Current `worker.yml` has a single-line `description`. Federico wants more:
- `description` (one-line, current)
- `long_description` (markdown, multi-paragraph — shown on worker detail)
- `tags` (e.g., `recruiting`, `email`, `compliance` — drives filtering on /workers)
- `use_cases` (markdown bullet list — "When to use this worker")
- `example_input` (sample inputs that auto-fill the run form for first-time users)
- `last_used_by` / `runs_last_30d` (computed, not declared)

### Visual upgrades across the UI
- Workers page → visual catalog with logos, tags, "what this does" preview
- Runs page → optional kanban view (by status) alongside list
- Run detail → richer timeline with avatars/icons per step
- Secrets/Connections → status icons + last-check timestamp
- Dark/light density toggles for power users

### Parking
All of this is V1.5+ scope (not V0 spec). Build in priority order:
1. Connection daily-ping + alert (biggest reliability win)
2. Worker fleet health card on Overview
3. Worker long_description / tags / use_cases
4. Calendar view (depends on Schedule trigger landing)
5. Alerts to email
6. Slack/WhatsApp alerts
7. Kanban/visual upgrades

---

## V2 library mode — BOTH shapes confirmed

Federico 2026-05-25 update: "both directions interesting. pls capture."

Shape A (decorator) and Shape B (observability SDK) both stay in V2 candidate scope. The decorator is the wedge for code-people; the SDK is the lighter lift for already-running cron jobs that just want observability.

Order: A first (full worker semantics), then B as a stripped subset using the same SDK.

---

## V1.5+ — User Experience (non-developer persona)

Federico 2026-05-25: "think from a user perspective pls, how to make this extremely intuitive and easy to use?"

The persona that matters: someone like Morten at Search Assistant. Not a developer. They get a Vercel SSO link, open the app, and need to feel "I understand what this is and what to do" in 30 seconds.

### First-time onboarding
- Welcome state on Overview when run_count = 0: "Try one of these →" with 3 suggested workers prefilled with example inputs
- "What is Floom?" 1-tap explainer card, dismissible
- Per-page contextual tour highlights ("?" icon → walks through what each section does)
- Tour state persisted in user profile (don't re-tour after dismissed)

### Worker creation accessibility
Current `/workers/new` has a `run.py` textarea. Recruiters won't write Python. Add:
- **Starter templates**: "CSV summarizer", "Email triager", "Web scraper", "Sheet enricher" — each pre-fills `run.py` with working code the user can edit minimally
- **AI-assisted generation** (V2 stretch): "Describe what you want this worker to do" → LLM generates the run.py + worker.yml. Codex/Anthropic SDK call. Recruiter never sees raw Python unless they want to.
- **Hide raw YAML by default** behind an "Advanced" toggle on the create page

### Worker discovery
- Tags + category filter on `/workers` (recruiting / email / compliance / research / etc.)
- Each card shows: example output preview thumbnail, tags, "runs in last 30 days" count, "last used by [team member]" if multi-user
- Sort: alphabetical / most-used / recently-created

### "Try with sample input" CTA
- Every worker has `example_input` declared in `worker.yml` (already in roadmap)
- Worker detail run form has a "Use example" button that fills all fields
- First-time users hit Run with the example to see what it does

### Post-run actions (dead-end fix)
After a run completes, surface:
- **Copy to clipboard** per output (one button per artifact)
- **Save to library** — pin this output for later
- **Use as input for another worker** — opens worker picker with this output prefilled
- **Schedule this** — "Run this same input every Monday at 9am" → creates schedule entry (depends on Schedule trigger landing)
- **Share** — generates a read-only link (multi-user-gated)

### Notifications
- Browser Notification API opt-in: "Notify me when long runs finish?" → ping when run completes
- Email-on-complete option per run (or default-on for runs > 30s)
- Slack/WhatsApp via the alert channels in the observability roadmap section

### Failure recovery surface
Structured error panel shipped in V1 (pattern-matched friendly headline + raw collapsible). Add CTAs per error type:
- `openai_auth` → "Update OPENAI_API_KEY in Secrets" (button → /secrets)
- `openai_rate_limit` → "Retry in 60s" (button starts a timer)
- `schema_violation` → "Edit worker code" (button → worker manifest tab)
- `missing_connection` → "Connect [App]" (button → /connections)
- `timeout` → "Retry with shorter input" (re-opens form with same input)

Every failed run has a "Retry" button at minimum.

### Secrets/Connections "used by" rendering
- `/secrets` row shows badges of all workers declaring that secret
- `/connections` row shows badges of all workers declaring that connection
- Click badge → jumps to worker detail

### Global ⌘K palette
- Trigger with ⌘K (or Ctrl+K on Linux/Windows)
- Searches: workers (by name + tags), runs (by ID + by input content), pages
- Quick actions: "Run worker X", "Open connections", "Toggle theme"
- Keyboard-first navigation — matches Linear/Vercel/Notion idiom

### Empty-state CTAs everywhere
- /runs empty: "Run your first worker →"
- /approvals empty (when re-enabled): "Approvals appear when workers ask for them"
- /secrets empty: "Add OPENAI_API_KEY to use AI workers"
- /connections empty: "Connect an app to unlock integration workers"
- Settings empty fields: helpful placeholder text, not silence

### Help + Docs
- `/docs` page in-app — short walkthrough articles ("How worker.yml works", "What is a Connection", "Approvals — coming soon")
- "?" icon top-right of every page, opens contextual help drawer for THAT page
- Inline tooltips on every uncommon term (worker.yml, trigger, artifact, secret)

### Post-OAuth pointer
After Gmail (or any) connection goes Active: show a banner on /connections — "You can now run: Gmail Intake Brief →" linking to the worker that uses it. Same for HubSpot, Apollo, etc.

### "What's new" / changelog
- In-app changelog drawer accessible from sidebar footer
- Highlights new workers, new connections, breaking changes
- Persists "last seen" so we can show a subtle dot for unread updates

### Mobile = monitoring surface
- Mobile drawer + responsive layout already works
- BUT filling worker forms on mobile is bad UX
- Position mobile as a "watch what's running" surface: runs feed, approvals queue, alerts
- Discourage worker creation on mobile (or hide /workers/new behind "request desktop view")

### Priority order
1. Empty-state CTAs (cheapest, biggest first-impression lift)
2. "Try with sample input" CTA + `example_input` in worker.yml
3. Post-run actions (Copy, Use-as-input, Schedule, Retry)
4. Secrets/Connections "used by" surface
5. Per-error-type "what to do next" CTAs
6. ⌘K palette
7. Starter templates for worker creation
8. Onboarding tour + welcome state
9. Notifications (browser + email)
10. `/docs` + contextual help

---

## V2 — Workers as Skills (markdown-first, code-optional)

Federico 2026-05-25: "why do workers require python? huh? it can even just be an md file since we have LLM behind it, no? like we want to bring skills to live. skills can be pure md / a mix / pure python..."

**The fundamental rethink.** Today's worker = `worker.yml` + `run.py` (Python required). Federico's insight: with an LLM behind the runtime, the worker can be just a markdown spec. An LLM reads the spec + inputs + available connections/skills, does the work, returns output.

### Three worker types under one primitive

```
workers/<id>/
  worker.yml      # always: declares interface (inputs, outputs, connections, secrets, approvals)
  ONE OF:
    skill.md      # markdown-only: LLM reads + executes
    run.py        # Python: classic worker (today's shape)
    BOTH          # mixed: Python orchestrates, calls into prompts for fuzzy steps
```

### Markdown worker example

```yaml
# workers/competitive_research/worker.yml
id: competitive_research
name: Competitive Research
description: Research competitors for a target market and summarize positioning.

inputs:
  - { name: market, type: text, required: true, label: Target market }
  - { name: competitors, type: textarea, label: Known competitors (one per line) }

outputs:
  - { name: report, type: markdown }

connections: []
secrets: [OPENAI_API_KEY]
runtime:
  type: skill
  entrypoint: skill.md
```

```markdown
# workers/competitive_research/skill.md

You are a market research analyst. Given a target market and a list of competitors,
research each competitor and produce a structured markdown report.

## What to do
1. For each competitor in `inputs.competitors`, search for:
   - Their public positioning
   - Pricing model
   - Distinct technical claims
2. Synthesize across competitors to identify gaps in the market.
3. Output a markdown report with sections: Competitor profiles, Market gaps, Recommended positioning.

## Output requirements
- Use H1 for the report title
- One H2 per competitor
- Cite URLs inline as `[source](url)`
- Final section "Recommended positioning" must include 2-3 concrete suggestions
```

The runtime sees `runtime.type: skill`, loads `skill.md` as the system prompt, passes `inputs` as user message, lets the LLM call tools (connections + Floom MCP), captures output.

### Why this matters

1. **Non-developers can write workers.** A recruiter writes "research these candidates" in plain English; it executes.
2. **Connects Floom Skills + workeros into one product.** A Skill on skills.floom.dev IS a worker on workers.floom.dev. The library publishes skills; the runtime runs them.
3. **Same tool surface for code + skill workers.** Whether the worker is `run.py` or `skill.md`, it can declare `connections: [gmail]` and `skills: [...]` the same way. The runtime injects them either as a context dict (Python) or via MCP tools (markdown).
4. **Distribution wedge.** Every Floom skill in the public library becomes runnable in workeros with one click. Library users say "I want to USE this skill, not just read it" → workers.floom.dev runs it.

### What changes

- New runtime type `skill` (alongside `python`)
- New entrypoint resolution: if `skill.md` present, use skill runtime; if `run.py`, use python; if both, dispatcher Python can call into markdown via `context.skill.run(skill_name, inputs)`
- LLM choice: declared per-worker (`runtime.model: gpt-4o-mini` or `claude-haiku-4-5` etc.)
- Tool exposure: workeros's MCP layer auto-exposes the worker's `connections` + `skills` as tools to the LLM
- Output validation: same schema enforcement (worker.yml declares output type, runtime validates)

### Open questions

1. **Deterministic vs LLM workers.** A "send Slack message at 9am" worker doesn't need an LLM — it's a deterministic action. Should workers support `runtime.type: action` for pure-tool-call workers (no LLM, just orchestrate a Connection call)?
2. **Cost.** LLM-backed workers run per-invocation cost. Should `worker.yml` declare `cost_class: zero | llm | external_api` so the UI can warn users before triggering?
3. **Streaming.** Markdown workers naturally stream LLM output. Should the runtime forward streaming to the UI? (Spec § 18 currently excludes — but if we have streaming for free from the LLM, it's nearly cosmetic to add.)
4. **Multi-model selection.** Different workers might want different LLMs (cheap GPT-4o-mini for triage, Claude for research, Gemini for code). Should `worker.yml` declare default model + allow override per-run?

### Sequencing

1. Land the `runtime.type: skill` primitive (V2 milestone — significant work)
2. Port one existing worker to skill-only (e.g., `research_brief` → `skill.md`-only)
3. Build a skills→workers bridge: any skill from skills.floom.dev can be `Pull → Run` in workeros
4. Library/marketplace integration with skills.floom.dev (subscription model — Federico's earlier "auto-update everyday" memory)

Parked V2. The most strategically important item in this roadmap.

---

## V1.5 — WorkerContract migration (after F1/F2/F3)

Federico 2026-05-25: "agree! sounds good. compatibility with skills-neo is important. otherwise we diverge too much."

Adopt skills-neo's `WorkerContract` shape (from `@floom/shared`) as workeros' canonical manifest. Migrate the 8 existing worker.yml files. Lock in marketplace compatibility with skills.floom.dev.

### What changes in workeros

1. **Pydantic models match `WorkerContract`** shape:
```yaml
schema_version: "0.3"
name: research-brief        # slug
title: Research Brief       # display
description: "..."
version: "0.1.0"            # semver per skill
entrypoint: SKILL.md        # markdown spec (can be empty docstring for V1.5; matters in V2)
targets: [generic]
exec:
  command: python run.py
  runtime: python311
  inputs:
    - { name: topic, kind: scalar, type: string, label: Research topic, required: true }
    - { name: depth, kind: scalar, type: string, enum: [overview, detailed, deep_dive], default: overview }
  secrets: [OPENAI_API_KEY]
  outputs:
    - { name: brief, kind: file, media_type: text/markdown, path: out/brief.md }
capabilities:
  secrets: [OPENAI_API_KEY]
  network: { egress: false }
```

2. **Skill ≠ worker separation:**
   - `skill_version` (recipe — versioned, immutable, reusable across workers + across libraries)
   - `worker` (instance — trigger config, grants, notify settings, enabled flag, owner)
   - New DB tables `skill_versions`, `workers` (current `workers` table effectively becomes `skill_versions`; new `workers` table = instances)
   - Multiple workers can reference the same skill version (e.g., "Daily research brief" + "Weekly research brief" share the recipe)

3. **Triggers move from manifest to worker instance:**
   - Manifest (skill) declares NOTHING about triggers
   - Worker row has `trigger_type`, `cron_expr`, `next_run_at` etc.
   - Same skill can power a manual worker AND a scheduled worker AND a webhook worker

4. **Migration of existing 8 workers:**
   - Each becomes a `skill_version` (recipe) + 1 `worker` (instance) — backward-compatible UX
   - Old `worker.yml` shape stays parseable for one release with a deprecation warning, but new workers must use WorkerContract

### Upstream to skills-neo — workeros does these better, skills-neo should adopt

Federico 2026-05-25: "if skills-neo is inferior on some points also happy to adjust on their side, lmk!"

Concrete items where workeros' worker.yml is more UX-friendly than skills-neo's WorkerContract — upstream as PRs to skills-neo:

| Improvement | What | Why |
|---|---|---|
| **`inputs[].label`** | Display name for the input distinct from the slug `name`. Workeros: `label: "Raw notes"`. Live-skills: no label field. | Form-generation. "raw_notes" → "Raw notes" lookup is fragile. |
| **`inputs[].placeholder`** | Field placeholder text. Workeros has it. | Onboards non-developers; recruiter sees "Paste notes, bullets..." vs empty textarea. |
| **`inputs[].description`** | Per-input help text (rendered as small subtext). Workeros has it implicitly via comments. | Live-skills has only `examples: []`. Help text per field is materially better UX. |
| **`inputs[].type: select` + `options: [...]`** | Workeros: `type: select, options: [internal, investor, customer]`. Live-skills: `type: string` + you'd need an external schema for enum. | Form renders a dropdown without a separate schema lookup. |
| **`approvals: { required, label }`** block (on the worker INSTANCE, not the skill) | Workeros has it (currently lives in manifest but logically belongs on instance). | Quick declarative "this output needs human sign-off" without orchestrating an async runner. |

These are all UX-additive — backward-compatible with the existing WorkerContract schema. Skills-neo PR would extend the Zod schema in `packages/shared/src/manifest.ts`.

### Scope and order

After F1/F2/F3 codex round lands:
1. Port WorkerContract Pydantic models into workeros (`apps/api/models.py`)
2. Split `workers` table into `skill_versions` + `workers` (migration)
3. Backfill: each existing worker.yml → 1 skill_version + 1 worker
4. Update worker-create UI to generate WorkerContract shape
5. Update worker-registry discovery to parse new shape (with one-release fallback for old shape)
6. Open upstream PR to skills-neo **on the `live-skills-v0x-schema` branch** (not main) with the 5 UX additions above. Federico 2026-05-25.

---

## Tangential bug — skeleton loaders look "a bit weird"

Federico 2026-05-25: "skeletons a bit weird rn?"

self-hosted server Browser Broker was timing out on `browser_navigate` (both pool-a + pool-b) — couldn't get a verification screenshot. Queued with code-level diagnosis.

### Code-state observations
`apps/web/components/ui/skeleton.tsx` uses `bg-muted` (`--bg-2`):
- Light mode: `#ededec`
- Dark mode: `#1c1c1c` (near body bg `#161616` — possibly near-invisible)

### Likely culprits (rank by probability)
1. **Radius mismatch** — Skeleton is `rounded-md` (7px). Design v2 cards are `rounded-xl` (11px). Skeleton inside `rounded-xl` looks misaligned at corners.
2. **Dark-mode contrast** — `#1c1c1c` on `#161616` body = barely visible. Needs lighter shade in dark mode.
3. **Glass card backdrop interaction** — `animate-pulse` over `backdrop-filter blur` may render oddly.
4. **Stat-card height** — Overview KPI skeletons `h-8 w-12` inside `text-2xl` div. Off-by-1 against Inter line-height could look janky.

### Proposed fix
- `rounded-[inherit]` so skeleton picks up parent radius automatically
- Lighter dark-mode shade (`bg-[var(--bg-3)]` for dark)
- Optionally swap pulse → shimmer (more on-brand with glass material)
- Verify height on all 10 call sites

Queued for the round after F1/F2/F3 + WorkerContract migration. When broker is healthy, codex round: "Open https://workers.floom.dev in chrome-depontefede, screenshot every page with loading state, fix any skeleton visual mismatches."

---

## V1.5 — Connections page polish (logos + scopes)

Federico 2026-05-25: "lets have their real logos and all? of the connection apps? and also show the scope that we connected for?"

### Real app logos
Composio publishes per-app logos at `https://logos.composio.dev/api/<toolkit_slug>` (verified — the toolkit response from `/api/v3/auth_configs` already includes `toolkit.logo` field with this URL).

Current `/connections` page uses Lucide `Plug` icon for everything. Change:
- Each connection row + each app in the "Connect an app" modal renders the actual logo via `<img src={toolkit.logo}>` with a square frame + fallback to Plug icon if image fails
- Workers page: when a worker declares `connections: [gmail]`, show the Gmail logo next to the worker name (provenance signal)

### OAuth scopes per connection
Composio's `/api/v3/auth_configs/{id}` returns `credentials.scopes: [...]` — the full list of Google API scopes the OAuth flow asked for. Example for the current Gmail auth_config:
```
- googleapis.com/auth/userinfo.profile
- googleapis.com/auth/userinfo.email
- googleapis.com/auth/contacts.readonly
- googleapis.com/auth/profile.language.read
- mail.google.com/                       (read+modify+send)
- etc.
```

Update:
- `composio_client.py` — when listing connections, also fetch the auth_config + extract `scopes`
- DB: add `scopes_json` column on `composio_connections` table (or fetch lazily on connection detail)
- UI: connection row shows a "Scope" button (or auto-expanded section). Each scope rendered as a chip with a human-readable label ("Read your inbox", "Send email on your behalf", "Modify labels"). Hover for the raw scope URL.

### Scope-to-human-label map
Build a small dictionary of common scopes → friendly labels. e.g.:
- `mail.google.com/` → "Full Gmail access (read, send, modify, delete)"
- `auth/contacts.readonly` → "Read your contacts"
- `auth/calendar` → "Manage your calendar"
- LinkedIn `r_liteprofile` → "Read your LinkedIn profile basics"
- Slack `chat:write` → "Send messages on your behalf"

For unknown scopes: fall back to showing the raw URL.

### Why this matters
- **Trust signal:** a recruiter sees "Floom asked for: Read inbox, Modify labels" — knows what permissions they granted. Currently invisible.
- **Audit trail:** if Floom asked for a scope a worker doesn't actually need, scope display surfaces the over-permissioning.
- **Marketplace:** when skills.floom.dev shows a worker that requires `gmail`, the install page can preview which scopes will be requested before the user clicks Connect.

### Sequencing
After F1/F2/F3 + WorkerContract migration. Frontend-heavy round, ~2-3h codex.

---

## Scope decisions (2026-05-26) — codex recommendation accepted

After Federico's UI walkthrough, codex consulted on three open scope questions. Verdicts:

**A. Tags, not folders.** Flat `tags: [...]` field in `worker.yml`. Render as chips on `/workers` with one-click filter. No folder hierarchy, no tag-management UI in first pass. 12 workers don't justify folders; Search Assistant needs quick recognition like `recruiting`, `email`, `compliance`, `client-a`.

**B. T2 entry round = Workers page.** Front door for non-devs. Fixing it compounds queued T2 items: logos (Connections polish), tags filter, richer descriptions (long_description/use_cases/example_input), empty-state CTAs all become visible in one high-traffic surface.

**C. Tier order unchanged.** Workers-as-skills + WorkerContract + capability grants + file inputs stay T1 (foundational primitives). Calendar / notifications / ⌘K stay T3 (organize usage AFTER there is enough valuable usage to organize).

### Federico's substitution principle (locked)

"Workspace switching CAN BE REPLACED with folders for now" — when a heavy feature has a lighter alternative, default to the lighter one. Examples already applied or queued:
- Multi-workspace switcher → tags (workspace = client-a tag)
- Roles inside workspace → single user for V1
- Library view → punted; rely on workers list + connections + skills.floom.dev marketplace
- Pause-resume approvals → review-after-output hidden until pause-resume lands
- Multi-action workers → option A (multiple files per folder) instead of new sub-router

### Calendar view (T3) — promote when cheap

Federico: "i do like calendar view if its not too complicated". F2 cron scheduler is already shipped, so calendar = a frontend month/week grid reading `next_run_at` + recent runs from existing endpoints. Estimated 2-3h codex. Promotion rule: dispatch calendar whenever bandwidth opens during T2/T3; don't block T1.

### The first-run moment (codex insight D)

Critical observation: every worker today requires typing inputs from scratch on first run. workeros reads as a "developer console" until that's fixed.

T1a (in flight) already roadmapped `example_input: {...}` per worker as part of the richer descriptions. Promote this:
- T1a: add `example_input` to the WorkerContract Pydantic schema (cheap)
- T2 first sub-round: backfill `example_input` for all 12 workers + add "Try with sample" button on worker detail
- Acceptance test: a fresh visitor can run any stock worker in under 60 seconds via a single click

This is THE conversion gate. Without it, no amount of design v2 polish will land for a non-dev persona.

---

## Stack reference (locked 2026-05-26)

Federico explicit: "tech stack is shadcn + composio + e2b/local, right? no supabase or so?" — confirmed.

| Layer | Choice | Why |
|---|---|---|
| Frontend | Next.js + Tailwind + shadcn/ui | V0 spec § 6.3 |
| Backend | Python FastAPI + Pydantic | V0 spec § 6.3 |
| Database | SQLite | V0 spec § 6.3, local-first. **No Supabase.** Skills-neo uses Supabase; workeros stays local. |
| Connections | Composio (OAuth, tool execution via v3 API) | PR #11 |
| Sandbox | E2B + local subprocess, per-worker selection | F1 shipped via PR #17 |
| LLM | OpenAI (`OPENAI_API_KEY`); future: per-worker model declaration in WorkerContract | T1a in flight |
| DNS + WAF + tunnel | Cloudflare (zone `dbad3455549f1eb7aeb8535af2f4a961`) | Set up earlier this session |
| Hosting | Vercel (frontend), self-hosted server systemd (API) | Set up earlier this session |
| Auth gate | Vercel SSO (frontend), CF WAF + per-webhook HMAC (API) | Set up earlier this session |
| Artifacts storage | Local filesystem (`/root/workeros/data/artifacts`) | V0 spec § 6.3 |

If skills-neo's pattern uses Supabase for a feature we want to port (e.g., file-input authz pattern), the PORT into workeros uses SQLite + local filesystem, NOT Supabase.

---

## Scope override (2026-05-26) — folders + tags, both

Federico revised: "i think we also need folders next to tags. cannot be that complicated?"

Override the earlier codex recommendation that said tags-only. Adopt the **Gmail/Notion model**: folders for primary hierarchy + tags for cross-cutting cross-cutting labels.

### Implementation
- `worker.yml` gains TWO new optional fields:
  - `folder: "client-a/compliance"` — slash-separated path, single-parent
  - `tags: [recruiting, urgent, email]` — flat array, multi-assign
- Backfill defaults: `folder: "stock"` for the 12 existing workers; `tags: []` empty (operator adds later)
- `/workers` page shows:
  - **Tree on the left** (folders with worker counts: "Stock (12)" expandable, "Client A (3)" etc.)
  - **Filter chips on the right** (tags: All / recruiting / email / compliance / ...)
  - Worker cards in the main area, scoped to selected folder × selected tags

### Migration
- T1a (in flight) doesn't know about folders/tags yet — add to WorkerContract Pydantic models as optional fields. Cheap.
- T2 first sub-round (Workers page) renders the tree + chips.

### Scope discipline
- No folder management UI in V1 (no drag-drop, no rename). Folder = whatever you typed in `worker.yml`. Operator can edit YAML.
- No tag-management UI either. Same rule.
- Both can grow management UIs in V2 if real users ask.

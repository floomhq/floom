# Floom Workeros Roadmap

Tracks decisions and scope beyond V0 (V0 spec lives in `SPEC.md`). Each item lists status, decision rationale, and order.

Last updated: 2026-05-25

---

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
- Park until external user actually wants it (e.g., NovaSearch's 6 FTE need 6 logins).

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

The persona that matters: someone like Morten at NovaSearch. Not a developer. They get a Vercel SSO link, open the app, and need to feel "I understand what this is and what to do" in 30 seconds.

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

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

### Move to E2B runner (drop trusted-local default)
- Federico 2026-05-25: "I don't know if we really need trusted local. Isn't it much easier with E2B, because E2B is sandboxed and can install dependencies out of that. With the to-do so much engineering around how to run this, dependencies will not work. What about untrusted code? I'm not sure I would actually just have everything on E2B."
- Decision: E2B becomes the default runner. Trusted-local stays as a dev/debug fallback only.
- Spec § 10.2 already lists E2B as Phase 3, optional. This decision promotes it to default.
- Open question for build day: dev-loop UX. Local debugging of E2B-running workers needs a story (logs forwarded, breakpoints, etc.).

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

### Schedule + Webhook triggers (V0.5 per spec)
- Spec § 11.2 schedule (cron-based)
- Spec § 11.3 webhook (per-worker URL `POST /webhooks/{worker_id}`)
- Not yet built. Build when first concrete use case (e.g., cron-driven CRM sync, Composio webhook arriving at a workeros worker).

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

### Q3: E2B-only or E2B-default-with-local-fallback?
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

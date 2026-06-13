# Workeros Roadmap

Single source of truth. Two sections:
1. **Launch Readiness** — shipped or actively in flight; required for "the operator uses workeros for his own stuff."
2. **Post-Launch** — explicitly parked; not in scope until reopened.

Scope decisions are owned by the operator. Implementation decisions are owned by Codex. Claude orchestrates and reviews.

Last updated: 2026-05-27 — added Series S launch-readiness push to a target score of 91/100.

---

## Launch Readiness

All items below are SHIPPED unless flagged otherwise. Anything not on this list is post-launch.

### Primitives

- **WorkerContract manifest** (`schema_version: "0.3"`) — name, title, description, version, inputs, outputs, capabilities, exec, trigger, connections, approvals.
- **Skill bundle as the worker primitive** — a worker is a manifest plus an arbitrary skill bundle (markdown, python, js, multi-file, or none). Default executor is an agent that reads the bundle plus inputs and figures out the work. Pure-script mode is the explicit opt-out (`exec.mode: pure-script`) for workers that don't need an AI.
- **Flexible exec block** — `exec.mode: agent | pure-script`, `exec.runtime: python311 | node22 | bash | skill | none`, optional `entrypoints[]` for multi-tool skills, `system_prompt`, `model` (default `gpt-5-mini`), `limits.{max_tool_iterations, max_output_tokens, max_total_tokens, timeout_seconds}`.
- **Capability grants — declared-not-enforced** — `capabilities.{secrets, files, connections, network.egress}` is documentation only at launch; the frontend renders it as an audit badge. No fail-closed enforcement until marketplace install or multi-user lands.
- **Content-hashed file inputs** — `/uploads` endpoint, sha256 dedup, per-run mount into `<artifacts>/<run_id>/inputs/`, bind-time revalidation against `inp.accepts` and `inp.max_size_mb`, ownership audit log.
- **Runtime routing — E2B scripts + AgentDriver agents** — `runner: e2b` is the supported runner for script workers. Agent workers route to AgentDriver based on `SKILL.md` / `exec.mode: agent`; script workers route to E2B based on `run.py`, `.sh`, or `.js` entrypoints. There is no in-process local runner.

### Triggers

- **Manual** — invoke via API, MCP, or UI.
- **Cron (schedule)** — croniter scheduler, atomic check-and-advance.
- **Webhook (incoming)** — HMAC-SHA256 verification, per-worker rotatable secret, Cloudflare WAF allowlist on `/webhooks/*`.
- **Composio triggers** — `trigger.type: composio` with `event`, `connection_id`, `filters`. Backend registers/unregisters with Composio on worker create/update. `/composio-events` receiver verifies the Composio signing key and creates runs. Unlocks ~1000 SaaS event sources.

### Agent runtime

- **AgentDriver** — loads the entrypoint file (default `SKILL.md`) as system prompt, inputs as JSON user message, OpenAI tool loop. Tool surface: `list_dir`, `read_file`, `write_output`, `run_command`, `invoke_worker`, `composio.<app>.<tool>`, `log`. Native skill-loading pattern (no bespoke file-index injection — agent calls `read_file` as needed). Composio `tool_slug` constrained to declared app namespace; missing-connection fails fast pre-HTTP. Transcript artifact per run with regex + exact-value scrubbing on logs and outputs.
- **Pure-script driver** — E2B execution with no agent overhead. Used by stock Python workers that don't need an LLM.
- **Cost caps** — per-worker `limits` enforce iterations/output tokens/total tokens/timeout.

### Agent interface (primary)

- **MCP server** — `@floomhq/workeros@0.1.0` on npm. Single install command: `npx @floomhq/workeros install` patches the user's agent config (Claude Code / Cursor / Continue). Tools: `workers.list / get / create / update / delete / run`, `runs.list / get / watch`.
- **REST API** — `https://workers-api.floom.dev`, x-floom-secret on every route except `/webhooks/*`, `/composio-events`, `/connections/callback`, `/healthz`. SSE stream on `/runs/{id}/events`.
- **CLI** — `floom` Python CLI in repo. Future: rewrite as `@floomhq/workeros` Node CLI subcommand. Not blocking.

### Connections

- **Composio integration** — v3 API (`/auth_configs`, `/connected_accounts`, `/tools/execute`). OAuth init flow. Connections stored locally with status.
- **Connections page** — connected accounts list with real Composio logos and OAuth scopes display. Auth-gated route handlers (no public Composio metadata oracle). Declared-not-enforced framing in UI copy.
- **Catalog browse** — `/connections/browse` renders the full Composio app catalog (1000+ integrations) from `/api/v3/apps`. Search and category filter, click → existing OAuth init.

### Worker UI (trust signals)

- **Rich worker descriptions** — `long_description`, `use_cases`, `example_input`, `example_output`, `how_it_works` (ASCII flow), `tags`, `folder` (slash-nested) on every WorkerContract.
- **"Try with sample" CTA** — populates the run form from `example_input`. Safe handling for file inputs (no filename-string base64 bug).
- **Empty-state CTAs** — `/workers`, `/connections`, `/runs` empty states render actionable next steps.
- **Folder tree + tag chips** — flat folder grouping on `/workers`, tag filter chips, no nested route changes.
- **Transcript tab** — agent-mode runs render the LLM transcript on `/runs/{id}`. Code-mode runs hide the tab.

### Consumer creation flow (B2C-ready) — the operator 2026-05-26

- **Prompt-to-worker on `/workers/new`** — user pastes a natural-language description ("summarise all my meetings from Granola and update my CRM HubSpot accordingly"). System uses an LLM to (1) draft `SKILL.md` for the worker, (2) identify required Composio connections from the prompt, (3) identify required OpenAI/API secrets, (4) generate the I/O schema (inputs from the prompt nouns, output as markdown). User reviews + edits.
- **Inline OAuth + secret entry** — at create-time the form walks the user through connecting any required SaaS (Composio OAuth popup) and entering any required secrets, in-flow. No separate `/secrets` or `/connections` detour. After connect/enter, the form re-renders with green checkmarks.
- **One-click test** — run the worker with `example_input` after creation. Show the result inline. If it fails, surface the error + suggest a fix.
- **One-click schedule** — convert a successful test into a recurring worker (cron / webhook / Composio event). Single dropdown for the trigger type, sensible defaults.

### Run lifecycle controls

- **Cancel run** — `POST /runs/{id}/cancel` marks `cancel_requested: true`. The runner respects this between iterations / on terminal-status writes. UI has a "Cancel" button on `/runs/{id}` for any non-terminal run. Distinct from worker pause (which was cut): pause is "stop this worker firing"; cancel is "kill this specific in-flight run now." For LLM agent runs that go into runaway token loops.

### API endpoints

- `GET/POST /workers` — list and create.
- `GET /workers/{id}` — detail.
- `PATCH /workers/{id}` — update trigger, cron, inputs, capabilities; rotate webhook secret.
- `DELETE /workers/{id}` — delete row, cancel running runs, release bundle dir if shared `skill_version` unused.
- `POST /workers/draft-from-prompt` — given a natural-language prompt, return a draft WorkerContract (SKILL.md body, required connections, required secrets, I/O schema) for the user to review and edit on `/workers/new`.
- `POST /runs/{id}/cancel` — request cancellation of an in-flight run. Returns 200 if the request was recorded, 404 if no such run, 409 if already terminal. The runner respects cancel_requested between iterations and on the next status write.
- `GET /runs/{id}/events` — SSE stream of status/log/artifact events. Closes on terminal state.
- `POST /uploads` — content-hashed file blob upload.
- `POST /webhooks/{worker_id}` — HMAC-authed inbound webhook.
- `POST /composio-events` — Composio-signed trigger receiver.
- `GET /connections/callback` — OAuth browser redirect landing.
- `GET /healthz` — liveness (auth-exempt).

### Stack

- **Frontend** — Next.js 16 + Tailwind + shadcn, hosted on Vercel as `workers.floom.dev`.
- **Backend** — FastAPI + SQLite, hosted on self-hosted server as `workers-api.floom.dev` via Cloudflare tunnel.
- **Sandbox** — Python subprocess (local) + E2B (per-worker selectable).
- **Integrations** — Composio v3 for all SaaS connections + triggers.
- **LLM** — OpenAI GPT-5 family (default `gpt-5-mini`). Configurable per-worker.
- **Auth** — single `x-floom-secret` for the developer/agent surface. HMAC for webhooks. No multi-user.

### Stock workers (live, 12 total)

8 pure-script Python workers (legacy run.py path, agentless): csv_enricher, cv_writeup, dach_compliance, e2b_test, gmail_intake_brief, input_types_test, reverse_match_crm, schedule_test, webhook_secret_test, webhook_test.

2 agent-mode skill workers (markdown SKILL.md, OpenAI tool loop): research_brief, weekly_update.

---

## Series S — Launch-readiness push (2026-05-27)

Goal: take launch-readiness score from 78 → 91 / 100. Brutally simple: cut anything that doesn't move the score for a single-user v0.

### Shipped this push

| PR | Title | Status |
|---|---|---|
| S7 | Shared `worker-form/` components (DRY across create + edit) | ✅ merged |
| S8 | `/workers/[id]` side-nav B, `/workers` Drive folders, sparklines | ✅ merged #58 |
| S9 | `/workers/new` Option A (single hero card, integrated upload, chip examples, skip Step 2 → land on edit) | ✅ merged #60 |
| S10 | Sandbox secrets via `.env.local` (dotenv) instead of `secrets.json` | ✅ merged #59 |
| S11 | `exec.entry` simplified mode (one field, derives mode from suffix), `web_search` default-on, `/system/metrics`, daily backup script (committed, enabled in S13) | ✅ merged #61 |
| Cloudflare WAF fix | Allow rule expanded to permit `/composio-events` + `/connections/callback` (audit found webhooks were 403'ing) | ✅ live |
| Composio Connect Link white-label | Switched to v3 `/connected_accounts/link` endpoint so OAuth shows Floom-branded screen | ✅ merged |

### In flight (parallel cursor-agent lanes)

| PR | Worktree | Scope |
|---|---|---|
| S12 | `/tmp/workeros-pr-s12` | `/` Overview page, `/runs` global runs list, `/runs/<id>` detail (output-first + Download + Edit + Re-run), `/workers` Drive-clone simplification, `/settings` in-page tabs, global `<Tabs>` primitive (horizontal + vertical), run-time bundle snapshot |
| S13 | `/tmp/workeros-pr-s13` | `/system/info` path-leak fix, `/system/platform-config` secret-name redaction, draft endpoint per-hour cap, `/webhooks/composio-events` + `/webhooks/oauth-callback` aliases, backup cron `systemctl enable`'d, S11.1 `detectEntry()` hotfix |
| S15 | `/tmp/workeros-pr-s15` | Device-code CLI login (`floom login` → browser → `~/.config/workeros/credentials.json`), Tier 1 CLI in Node (`floom run`, `floom workers list/show`, `floom runs list/show/logs/download`, `floom secrets *`, `floom mcp install`, completion, `--json`), `@path` file syntax, `--output-dir`, new `/cli-auth/*` API endpoints |

### Queued (serialized — touches files S12 owns)

| PR | Scope | Why serial |
|---|---|---|
| S14 | Git-backed worker versioning (auto-commit per save), History tab in side-nav B, "Restore this version" button, diff viewer | Touches `run_service.py` heavily — conflicts with S12's snapshot path |
| S16 | Inline PDF + image render in `/runs/<id>` Output panel, multi-file inputs + drag-drop, MCP file-path passing, secrets + connections MCP tools | Touches `output-renderer.tsx` + `FileInputUpload.tsx` which S12 owns |

### Parallelization rules

- One cursor-agent per worktree, one PR per worktree.
- Two PRs can run in parallel if they don't both edit the same file's same block. `apps/api/main.py` is the common surface — adding new endpoint blocks is fine, editing the same existing handler is not.
- Web pages are usually safe: each page is its own file.
- `run_service.py`, `e2b_driver.py`, `models.py`, `agent_driver.py` are bottlenecks — only one PR may touch them at a time.

### Post-merge audit plan

Locked at `docs/audits/PLAN-2026-05-28.md`. Run after S12 + S13 + S15 + S17 land. 9 sections, evidence per finding, cross-agent rule: no agent audits what it built (claude-virgin + codex-roast + nvidia-deepseek dispatched for the virgin walks, security probes, and edge-case reasoning).

### Path to 91 / 100

| PR | Score delta | Cumulative |
|---|---|---|
| Current (S8-S11 merged + Cloudflare fix) | baseline | 78 |
| S12 lands | +6 | 84 |
| S13 lands | +3 | 87 |
| S14 lands | +2 | 89 |
| S15 lands | +2 | 91 |
| S16 lands | +1 (polish) | 92 |

Above 92 needs things outside single-user v0 scope: Sentry, multi-tenancy prep, real DR drills.

---

## Post-Launch (parked)

Explicitly NOT in scope. Will reopen only with a specific trigger.

| Item | Reopen trigger |
|---|---|
| Multi-user / team workspaces | First paying customer with multi-seat need |
| Calendar view of scheduled runs | More than 10 active cron workers in one account |
| Daily health checks + alerts on connections / secrets | First production outage from a stale connection |
| Notifications (browser + email + Slack) | the operator reports missing a run failure |
| ⌘K palette + global search | More than 50 workers in one account |
| In-app docs / changelog | First external user |
| Worker composition (`context.workers.invoke`) | the operator explicitly wants chained workers |
| Library mode SDK (`@floom.worker` decorator + observability) | First framework user asks for it |
| Pause-resume approvals (real mid-run) | the operator needs an action-taking worker that requires human approval |
| Multi-agent PR review loop | Concept-stage, not a product wedge |
| Post-run actions (copy / use-as-input / schedule / retry) | First time the operator clicks "what now?" on a finished run |
| Per-error-type CTAs (Stripe-style) | First user-visible error class that needs guided recovery |
| Outgoing HMAC notify URLs | First worker needing webhook-out fan-out |
| Skeleton visual fix (radius mismatch, dark-mode contrast) | the operator flags as P0 design |
| Capability grants enforcement (fail-closed) | Marketplace install path OR multi-user |
| Multi-action skills (`entrypoints[]` exposed as separate API actions + MCP tool param) | First worker that genuinely needs >1 invokable action — workaround today is one worker per action |
| Richer input/output types (`kind: json` with nested-schema validation, arrays-of-objects) | First user trying to pass nested JSON and asking for first-class type |
| In-UI preview for file outputs (PDF, Excel, images, video) | the operator wants to glance at a run's output without downloading |
| Skills marketplace (install from skills.floom.dev) | After workeros has real usage |
| Library worker (`@floom.worker` decorator for Python apps) | Library use case validated |

Adding to post-launch requires the operator approval. Items move from post-launch to launch readiness ONLY when their reopen trigger fires.

---

## How to add to this roadmap

- **Launch readiness additions**: blocking decisions go to the operator. Implementation goes to Codex.
- **Post-launch additions**: append to the table with a clear reopen trigger. Never use vague reopens like "later" or "future."
- **Removed items**: move to the `## History` section with date + reason, do not delete entirely.
- **Tier numbering** (T0, T1, etc.): retired. The two-section split above is the only structure. Numbered tier drift was the source of repeated scope confusion; do not reintroduce.

---

## History

- **2026-05-26**: Full rewrite to the launch-readiness boundary. Cut from prior draft: multi-user, calendar, palette, notifications, composition, library SDK, pause-resume, multi-agent PR, post-run actions, per-error CTAs, notify URLs. Retired tier numbering (T0-T5). Single source of truth.
- **2026-05-26**: T1g flexible skill primitive landed (#27). exec.mode: agent default; pure-script opt-in. Renamed `runtime: skill` → `exec.mode: agent`.
- **2026-05-26**: workeros-mcp shipped as `@floomhq/workeros@0.1.0` on npm. Single-command install: `npx @floomhq/workeros install`.
- **2026-05-26**: Capability grants flipped to declared-not-enforced. Audit metadata only at launch; no fail-closed gates.
- **2026-05-26**: Composio triggers shipped (#26). Event-driven workers across ~1000 SaaS apps.
- **2026-05-26**: Connections catalog browse shipped (#25). Full Composio app discovery in-app.
- **2026-05-26**: Worker descriptions + rich metadata shipped (#23). Trust signal layer for non-developer users.
- **2026-05-26**: PATCH/DELETE/SSE endpoints + auth gate tightened (#24). Closed the GET-unauth hole.
- **2026-05-26**: Content-hashed file inputs shipped (#20). Per-run isolation.
- **2026-05-26**: Connections page polish shipped (#22). Real logos + OAuth scopes display.
- **2026-05-26**: skill.md runtime shipped (#19). Foundation for agent-default execution.
- **2026-05-25**: WorkerContract migration shipped (#18). Aligned schema with skills-neo.
- **2026-05-25**: Sandbox + cron + webhook triggers shipped (#17).

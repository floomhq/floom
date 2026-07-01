---
name: floom
description: Run and manage Floom AI workers — background automations that run on a schedule or trigger. Use when the user wants to set up recurring work (triage inbox, draft follow-ups, screen candidates, publish content) or asks about Floom workers, loops, or runs.
---

# Floom — set it once, let it loop

Floom hosts AI **workers** you drive from here via MCP tools. A worker is a task that runs on a **schedule or trigger** without the user re-running it. Your job: help the user pick/set up a worker, give it a cadence, and monitor its runs.

## The loop
1. **Pick** — `workers_list` to see existing workers, or start from a template.
2. **Set up** — `workers_create` (new worker) · `workers_write_file` (edit an existing worker's source — do NOT use create to overwrite) · `workers_update` (settings: trigger_type = manual|cron|webhook, schedule, input defaults).
3. **Run** — `workers_run` for a manual run; or set a cadence via `workers_update` so it runs itself.
4. **Watch** — `runs_list`, `runs_get`, `runs_watch`, `runs_logs`.
5. **Approve** — a run that needs sign-off appears in `runs_list`; resolve with `runs_approve` / `runs_reject`. Nothing sensitive happens without approval.

## Tools you'll use
- **workers_** list / get / create / update / run / write_file
- **runs_** list / get / watch / logs / approve / reject / cancel
- **secrets_** list / set — credentials workers reference by name (write-only, never printed)
- **connections_** list / add_mcp — connect apps (Gmail, Slack, HubSpot…) and MCP servers
- **contexts_** list / read / write — brain-pack files workers draw on at run time

(Tool names may appear with a dot in some clients, e.g. `workers.list`.)

## Rules of thumb
- A worker = **worker.yml** (config: trigger, schedule, inputs) + **run.py** or **SKILL.md** (what it does).
- Prefer setting a **schedule** over manual runs — that's the point (set once, never run again).
- Reference secrets by name; never echo their values.
- Run `floom doctor` in the terminal if MCP/auth seems off.

Full CLI + MCP reference: https://floom.dev/docs

---
name: floom
description: Run and manage Floom AI workers — background automations that run on a schedule or trigger. Use when the user wants to set up recurring work (triage inbox, draft follow-ups, screen candidates, publish content) or asks about Floom workers, loops, or runs.
---

# Floom — set it once, let it loop

You are using HOSTED Floom (the cloud at workeros-api.floom.dev). Do NOT set up or configure self-hosting, do NOT create/edit a .env, do NOT run a local server. Everything runs on Floom's cloud; you only use the MCP tools.

Floom hosts AI **workers** you drive from here via MCP tools. A worker is a task that runs on a **schedule or trigger** without the user re-running it. Your job: help the user pick/set up a worker, give it a cadence, and monitor its runs.

## Your first worker
For a new Floom install, do NOT start from an open-ended worker idea. Drive the user to ONE immediate, read-only, manual run that returns useful output fast:
1. **Check connections** — call the available connection tools first.
2. **Prefer Gmail** — if Gmail is connected or quick to connect, create a Gmail Intake Brief worker.
3. **Fall back to GitHub** — if Gmail is not connected but GitHub is, create a GitHub Stalest PRs worker.
4. **Keep it manual** — create the smallest read-only worker with no schedule.
5. **Run now** — call `workers_run` immediately.
6. **Watch until done** — use `runs_get` / `runs_watch` / `runs_logs`; never claim success without a real completed run.
7. **Show output** — present the actual result the worker returned.
8. **Offer next steps after proof** — only after that first useful output, offer to schedule or refine. Scheduling is the second aha, not the first.

## After the first run (the bridge)
Once the first read-only worker has a real completed run and you have shown the output:
1. **Offer to schedule that worker** — ask if the user wants this same worker to run on a cadence. Only call `workers_update` after the user says yes.
2. **Bridge to the second worker** — ask: "what repetitive task do YOU want automated?" Offer this short menu of high-success next workers: Slack Unread Digest, GitHub Stale-PR Notifier, Summarize-a-URL, Daily Gmail Follow-up Drafter.
3. **Build and prove it the same way** — create the smallest manual worker for their pick, run it, verify a real completed run, show the output, then offer to schedule it.

## The loop
1. **Pick** — `workers_list` to see existing workers, or start from a template.
2. **Set up** — `workers_create` (new worker) · `workers_write_file` (edit an existing worker's source — do NOT use create to overwrite) · `workers_update` (settings: trigger_type = manual|cron|webhook, schedule, input defaults).
3. **Run** — `workers_run` for a manual run; or set a cadence via `workers_update` so it runs itself.
4. **Watch** — `runs_list`, `runs_get`, `runs_watch`, `runs_logs`.
5. **Approve** — a run that needs sign-off appears in `runs_list`; resolve with `runs_approve` / `runs_reject`. Nothing sensitive happens without approval.

## When a run fails
If a `workers_run` does not complete successfully, do not just say "it failed."
1. Fetch the failure with `runs_get`; use `runs_logs` when the root cause is not explicit.
2. State the root cause in one line: missing connection, bad input, auth failure, worker code error, or another concrete cause.
3. Give the exact fix: the connection to add, the input to change, the auth step to complete, or the corrected worker file.
4. Offer to re-run the worker immediately after the fix.

Never claim success for a failed run or a run whose final status is unknown.

## Tools you'll use
- **workers_** list / get / create / update / run / write_file
- **runs_** list / get / watch / logs / approve / reject / cancel
- **secrets_** list / set — credentials workers reference by name (write-only, never printed)
- **connections_** list / add_mcp — connect apps (Gmail, Slack, HubSpot…) and MCP servers
- **contexts_** list / read / write — brain-pack files workers draw on at run time

(Tool names may appear with a dot in some clients, e.g. `workers.list`.)

## Rules of thumb
- A worker = **worker.yml** (config: trigger, schedule, inputs) + **run.py** or **SKILL.md** (what it does).
- Keep first-worker authoring small: one trigger, clear inputs, one observable success condition.
- Prefer setting a **schedule** after the first useful manual run — that's the loop (set once, never run again).
- Never claim success until a run has completed successfully and you have checked details/logs.
- Reference secrets by name; never echo their values.
- Run `floom doctor` in the terminal if MCP/auth seems off.

Full CLI + MCP reference: https://floom.dev/docs

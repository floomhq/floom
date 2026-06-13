# Workeros UI Design Mockups (ASCII)

These ASCII layouts were used to align with the operator on the UI direction during the 2026-05-27 launch-readiness push. Saved here as durable artifacts so they're not lost in chat scrollback. Each section also notes which PR shipped the implementation.

---

## /workers/[id] — Worker Detail Page — Side-Nav B (chosen by the operator, shipped in PR S8 #58)

the operator's pick from three options (A: narrow icon rail, **B: wide labeled rail**, C: anchored sections). Triggers added as its own menu item per the operator's note "all are missing triggers as menu item".

```
┌────────────────────────────────────────────────────────────────────────┐
│ ⬛ Floom  (main app sidebar)                                            │
│ ─────────────────────────────────────────────────────────────────────  │
│ Overview     ┌──┐  📦 Research Brief             [↗ Edit] [▶ Run]      │
│ Workers ●    │← │  Generates a markdown research brief on any topic.   │
│ Runs         └──┘  research · brief · strategy · markdown              │
│ Secrets                                                                │
│ Connections ┌──────────────────┐ ┌─────────────────────────────────┐  │
│ Settings    │ ▶  Run        ●  │ │ Run worker                      │  │
│             │ <> Code           │ │ Topic                           │  │
│             │ ⏱  Triggers   (2) │ │ ▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢   │  │
│             │ 🔌 Connections    │ │ Audience  [executive ▼]         │  │
│             │ ▦  Runs       (3) │ │ Depth     [overview  ▼]         │  │
│             │ ℹ  Overview       │ │ [───── Run worker ─────]        │  │
│             │                   │ │                                 │  │
│             │ ── meta ──        │ │                                 │  │
│             │ Last run: 13h     │ │                                 │  │
│             │ Status: healthy   │ │                                 │  │
│             │ Triggers: manual  │ │                                 │  │
│             │ + 1 scheduled     │ │                                 │  │
│             └──────────────────┘ └─────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────────┘

- Worker rail = 180px, icon + label + count badges.
- Bottom of rail = live meta (last run, status, trigger summary).
- Section state synced to ?section=run URL param.
- Triggers section reuses shared TriggersEditor (PR S7) in edit mode.
```

---

## /workers/new — Worker Creation Page — Option A (chosen by the operator, shipping in PR S9 #?)

Three options were proposed (A: single hero card, B: side-by-side composer + "how it works" panel, C: inline conversational). the operator picked **A** plus "skip Step 2 → land on /workers/<id>/edit after Generate" (DRY/SOLID consolidation).

### BEFORE (current, "cards floating around" — the operator's complaint)

```
┌────────────────────────────────────────────────────────────────────────┐
│ ⬛ Floom  │  New worker                                                 │
│ Overview │  Describe what you want to automate, drop a file,            │
│ Workers  │  or pick an example.                                          │
│ Runs     │                                                              │
│ Secrets  │  ┌───────────────────── Prompt ─────────────────────┐        │
│ Conns    │  │ Describe what you want this worker to do          │        │
│ Settings │  │ ▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢      │        │
│          │  │                            [Generate ⌘+↵]        │        │
│          │  └───────────────────────────────────────────────────┘        │
│          │  ┌────────── Upload an existing skill ───────────────┐        │
│          │  │ Drop a .md/.py/.zip file here, or browse...       │        │
│          │  └───────────────────────────────────────────────────┘        │
│          │  ┌──────────────────── Examples ─────────────────────┐        │
│          │  │ • Summarise Granola meetings → HubSpot daily     │        │
│          │  │ • Every morning 9am, GitHub PRs digest           │        │
│          │  │ • Invoice email → extract total → Google Sheets  │        │
│          │  │ • New HubSpot deal → Slack #sales                │        │
│          │  │ • Last week's Granola → draft follow-up emails   │        │
│          │  └───────────────────────────────────────────────────┘        │
└────────────────────────────────────────────────────────────────────────┘

Three stacked cards. Visual noise. "Cards floating around."
```

### AFTER (Option A, single hero + chip examples)

```
┌────────────────────────────────────────────────────────────────────────┐
│ ⬛ Floom  │  Create a worker                                            │
│ ...      │  Tell Floom what to automate.                                │
│          │                                                              │
│          │  ╔═══════════════════════════════════════════════════════╗   │
│          │  ║                                                       ║   │
│          │  ║  ▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢   ║   │
│          │  ║  Summarise my Granola meetings and post action       ║   │
│          │  ║  items to HubSpot CRM daily                          ║   │
│          │  ║                                                       ║   │
│          │  ║                                                       ║   │
│          │  ║  ──────────────────────────────────────────────       ║   │
│          │  ║  📎 Upload .md / .py / .zip      ⌘+↵ Generate →      ║   │
│          │  ╚═══════════════════════════════════════════════════════╝   │
│          │                                                              │
│          │  Or start from an example:                                   │
│          │  [🗓 Granola → HubSpot daily]  [🐙 GitHub PR digest 9am]    │
│          │  [📧 Invoice → Sheets]  [🤝 HubSpot deal → Slack]            │
│          │  [📝 Granola → email drafts]                                 │
└────────────────────────────────────────────────────────────────────────┘

One hero card. Upload + Generate integrated. Examples as inline chips.
After Generate: skip Step 2, create the worker on the server, navigate
to /workers/<new-id>/edit (same shared form as editing any worker).
```

---

## /workers — Worker List Page — Google Drive Folders (shipped in PR S8 #58)

the operator's spec: "Recent / Favourites / Folders (Google Drive style)" instead of the previous top-chip folder filter (PR N).

```
┌────────────────────────────────────────────────────────────────────────┐
│ Workers                                          [Reload] [+ New]      │
│ All available workers. Run, edit, or create.                          │
│                                                                        │
│ Recent                                                                 │
│ [Research Brief]  [CSV Enricher]  [DACH Compliance]                   │
│                                                                        │
│ Favourites                                                            │
│ [★ Research Brief]  [★ Granola → HubSpot]                             │
│                                                                        │
│ Folders                                                               │
│ ┌──────────────┐  ┌──────────────────┐  ┌──────────────┐              │
│ │ 📁 Operations │  │ 📁 Recruiting     │  │ 📁 Research  │              │
│ │   3 workers  │  │   3 workers      │  │   1 worker   │              │
│ └──────────────┘  └──────────────────┘  └──────────────┘              │
│                                                                        │
│ All workers                                                            │
│ ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐│
│ │ Research B.. │  │ Weekly Upd.. │  │ CV Reform... │  │ DACH Compl.. ││
│ │ [healthy]    │  │ [healthy]    │  │ [healthy]    │  │ [healthy]    ││
│ │ research...  │  │ updates...   │  │ recruiting.. │  │ dach...      ││
│ │ Manual       │  │ Manual       │  │ Manual       │  │ Manual       ││
│ │ ▁▃█▅▂▁▂▄▃▁▁▁ │  │ ▁▁▁▁▁▂▁▁▁▁▁▁ │  │ (no runs)    │  │ ▁▁▁█▁▁▁▁▁▁▁▁ ││
│ │ 8 runs · 75% │  │ 1 run · 100% │  │              │  │ 1 run · 100% ││
│ │ [👁][✎][▶]   │  │ [👁][✎][▶]   │  │ [👁][✎][▶]   │  │ [👁][✎][▶]   ││
│ └──────────────┘  └──────────────┘  └──────────────┘  └──────────────┘│
└────────────────────────────────────────────────────────────────────────┘

- Recent = 5 worker cards by last_run_at DESC
- Favourites = starred workers (★ button per card, persisted to localStorage)
- Folders = clickable Drive-style cards; click filters All workers
- Sparkline = 14-day daily run count (green=completed, red=failed)
- Card actions = View (👁), Edit (✎), Run (▶) — PR H
```

---

## Worker Card — Sparkline detail (shipped in PR S8 #58)

```
┌────────────────────────────┐
│ 📦 Research Brief  [👁][✎] │
│    [healthy]              │
│    Generates a markdown    │
│    research brief...       │
│    Research                │
│    [research][brief]...    │
│    [Manual]                │
│   ┌──────────────────────┐ │
│   │ Runs (last 14d)      │ │
│   │ ▁▂▃▅█▆▅▃▄▂▁▂▅▄      │ │
│   │ 8 runs · 75% success │ │
│   └──────────────────────┘ │
│ ┌────────────────────────┐ │
│ │ ▶ Run worker           │ │
│ └────────────────────────┘ │
└────────────────────────────┘

- 14 vertical bars (one per day).
- Green = completed runs, red = failed (stacked).
- Hover: "May 15: 2 OK, 1 failed".
- Hidden when runs_7d == 0 (no card clutter for unused workers).
- Backend: GET /workers/{id}/runs/timeseries?days=14 (also batched into
  list_workers to avoid N+1).
```

---

## / — Overview Page (LOCKED, shipping in PR S12)

Landing page when user opens workers.floom.dev. B2C single-user: surface "what ran, what's running, what's next" without forcing a click.

```
┌────────────────────────────────────────────────────────────────────────┐
│ ⬛ Floom  │  Today                                  [+ New worker]      │
│ Overview●│                                                              │
│ Workers  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐    │
│ Runs     │  │ Runs     │  │ Success  │  │ Active   │  │ Connect. │    │
│ Secrets  │  │  12 24h  │  │   92%    │  │ workers  │  │  3 / 5   │    │
│ Connect. │  │ ▁▃█▅▂▁▂ │  │  7d      │  │   8      │  │  healthy │    │
│ Settings │  └──────────┘  └──────────┘  └──────────┘  └──────────┘    │
│          │                                                              │
│          │  Recent runs                                  [See all →]   │
│          │  ✓ Research Brief         13min ago    8.4s  Manual         │
│          │  ✓ Weekly Update          1h ago      12.1s  Schedule       │
│          │  ✗ Granola → HubSpot      2h ago       4.2s  Gmail trigger  │
│          │  ✓ CV Reformat            6h ago       9.0s  Manual         │
│          │  ✓ DACH Compliance        13h ago      6.3s  Manual         │
│          │                                                              │
│          │  Scheduled today                                             │
│          │  09:00  GitHub PR digest  (in 2h)                            │
│          │  18:00  Granola summary   (in 11h)                           │
│          │                                                              │
│          │  Needs attention                                             │
│          │  ⚠ Granola → HubSpot failed 2× today  [View runs →]         │
│          │  ⚠ Slack connection expires in 3 days [Reconnect →]         │
└────────────────────────────────────────────────────────────────────────┘

- 4 stat cards (last 24h runs + sparkline, 7d success rate, active worker count,
  connection health). Click any → drill into Runs / Workers / Connections.
- Recent runs = last 5 across ALL workers. Click row → /runs/[id].
- Scheduled today = next 3-5 scheduled triggers firing today.
- Needs attention = failure clusters + expiring connections. Empty state hides
  the section entirely (no fake "all good" card).
- Backend: GET /system/overview returning all four blocks in one call.
```

---

## /runs — Runs Page (LOCKED, shipping in PR S12)

Global runs view. Currently lives only inside `/workers/[id]?section=runs` — needs a flat list across all workers. the operator 2026-05-27: rows must look clickable; detail page output-first with download.

```
┌────────────────────────────────────────────────────────────────────────┐
│ ⬛ Floom  │  Runs                                                       │
│ Overview │                                                              │
│ Workers  │  Worker: [All ▼]  Status: [All ▼]  When: [Last 7d ▼]        │
│ Runs   ● │                                                              │
│ Secrets  │  Volume (last 7d)                                            │
│ Connect. │  ▁▂▃▅█▆▅▃▄▂▁▂▅▄▃▄▂▅▆█▇▅▄▃▂▁▂▃▄ ─────────  84 runs  91% ok   │
│ Settings │                                                              │
│          │  ┌──────────────────────────────────────────────────────┐   │
│          │  │ When         Worker           Trigger    Dur  Status │   │
│          │  │ ─────────────────────────────────────────────────────│   │
│          │  │ 13min ago    Research Brief   Manual     8.4s   ✓    │   │
│          │  │ 1h 4min ago  Weekly Update    Schedule   12.1s  ✓    │   │
│          │  │ 2h 12min ago Granola→HubSpot  Gmail      4.2s   ✗    │   │
│          │  │ 2h 38min ago Granola→HubSpot  Gmail      3.9s   ✗    │   │
│          │  │ 6h ago       CV Reformat      Manual     9.0s   ✓    │   │
│          │  │ 13h ago      DACH Compliance  Manual     6.3s   ✓    │   │
│          │  │ 1d ago       Research Brief   Manual     7.2s   ✓    │   │
│          │  │ ...                                                  │   │
│          │  └──────────────────────────────────────────────────────┘   │
│          │                                                              │
│          │  [← Newer]                                       [Older →]   │
└────────────────────────────────────────────────────────────────────────┘

List row (the operator 2026-05-27: "must be clear you can click them"):
- Entire row is the `<a href="/runs/<id>">` anchor.
- `cursor: pointer`, hover background, chevron `→` at the end of every row.
- Failed runs: red `✗` glyph + soft-red row background.

Run detail at `/runs/<id>` — own URL, shareable, output-FIRST:

┌────────────────────────────────────────────────────────────────────────┐
│ ← Back   Research Brief · run f4a8...               [⤓ Download all]  │
│ ✓ success · 8.4s · Manual · started 13min ago                          │
│                                                                        │
│ ┌─────────────────────────────────────────────────────────────────┐   │
│ │ Output                                            [⤓ Download]  │   │
│ │ ───────────────────────────────────────────────────────────────│   │
│ │ # Research Brief: Q2 Planning                                   │   │
│ │                                                                 │   │
│ │ ## Summary                                                      │   │
│ │ The Q2 priorities focus on...                                   │   │
│ │ (renders markdown / JSON / plain text by file type)             │   │
│ │ ...                                                             │   │
│ └─────────────────────────────────────────────────────────────────┘   │
│                                                                        │
│ ▸ Inputs                       (collapsed by default — click to open) │
│ ▸ Logs                                                                 │
│ ▸ Artifacts (2 files)                                                  │
└────────────────────────────────────────────────────────────────────────┘

For failed runs, Output panel is replaced by Error panel (same shape, red):

┌─────────────────────────────────────────────────────────────────┐
│ Error                                              [⤓ Logs]     │
│ ───────────────────────────────────────────────────────────────│
│ HubSpot 401: token expired                                      │
│                                                                 │
│ Run.py raised at line 47:                                       │
│   composio.execute("HUBSPOT_CREATE_CONTACT") → 401              │
└─────────────────────────────────────────────────────────────────┘

- /runs/<id> is a real URL (not a drawer) — back button, shareable, bookmarkable.
- "Download all" → zip of inputs.json + outputs.* + logs.txt + artifacts/.
- Output renders by content-type: markdown via react-markdown, JSON pretty-printed,
  plain text monospace. Images preview inline.
- Top: filter chips on /runs (worker, status, time window). State synced to URL.
- Volume sparkline = same component used on worker cards, 7d daily bars.
- Table = paginated 50/page, server-side filter.
```

---

## /workers — Drive-clone (LOCKED, shipping in PR S12 — REPLACES live page)

the operator 2026-05-27: "/workers don't agree, too noisy". Current page has 5 sections (Recent / Favourites / Folders / Tags / All) — cut to Drive-clone with one tab row.

Looking at the live page screenshot (2026-05-26): Recent shows 3 cards with NO sparkline + NO stats (Recruiting/TeamB x2, Recruiting/Compliance). "Recent" should mean "ran recently" — workers with zero runs do not belong there.

```
Fixes vs. live:
1. Recent = workers WHERE last_run_at IS NOT NULL, ordered by last_run_at DESC, LIMIT 5.
   Workers with zero runs fall through to "All workers" only.
2. Favourites section MUST render (currently hidden if 0 starred — fine, but ★
   button on cards must actually persist to localStorage AND show in this section
   after star click).
3. Card title truncates to "Re..." / "W..." / "C..." — bump max-width or use
   2-line clamp. Worker names are the primary anchor; don't hide them.
4. Folder cards show worker count, but path-style names ("Operations/Reporting")
   should display as nested: top-level "Operations" folder, click → drill into
   sub-folders. NOT flat "Operations/Reporting" as if it's one folder. Drive-style.

Drive-clone Workers page (final):

┌────────────────────────────────────────────────────────────────────────┐
│ Workers                                          [Reload] [+ New]      │
│                                                                        │
│ [🔍 Search workers...]    [All●] [⭐ Starred] [⏱ Recent]                │
│                                                                        │
│ Workers /                                          (breadcrumb)         │
│                                                                        │
│ Folders                                                                │
│ ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐    │
│ │📁 Operations│  │📁 Recruiting│  │📁 Research  │  │📁 Personal  │    │
│ │  5          │  │  4          │  │  1          │  │  2          │    │
│ └─────────────┘  └─────────────┘  └─────────────┘  └─────────────┘    │
│                                                                        │
│ Workers                                                                │
│ ┌────────────────┐  ┌────────────────┐  ┌────────────────┐            │
│ │ Research Brief │  │ Weekly Update  │  │ CV Reformat    │            │
│ │ ☆ [healthy]    │  │ ☆ [healthy]    │  │ ☆ [healthy]    │            │
│ │ ▁▃█▅▂▁▂▄▃▁▁▁  │  │ ▁▁▁▁▁▂▁▁▁▁▁▁  │  │ (no runs)      │            │
│ │ 8 runs · 75%   │  │ 1 run · 100%   │  │                │            │
│ │ [▶ Run]        │  │ [▶ Run]        │  │ [▶ Run]        │            │
│ └────────────────┘  └────────────────┘  └────────────────┘            │
└────────────────────────────────────────────────────────────────────────┘

- Search input filters live across all workers (name + description + tags).
- Tabs (in-page <Tabs> primitive):
  - All  = folders row + all workers
  - ⭐ Starred = hides folders, starred workers only
  - ⏱ Recent = hides folders, workers WHERE last_run_at IS NOT NULL ORDER BY last_run_at DESC LIMIT 10
- Folder click drills in: breadcrumb "Workers / Operations / Reporting", nested
  sub-folders + workers in that folder.
- KILLED: separate Recent + Favourites + Tags sections. Search + tabs cover all.
- Tab state synced to ?tab=all (default), ?tab=starred, ?tab=recent.
- Folder path synced to ?folder=Operations/Reporting.
```

---

## /settings — In-page tabs (LOCKED, shipping in PR S12)

Currently `/settings` just shows the Floom secret. With more config coming (notifications, theme), use in-page horizontal tabs — NOT expanding sidebar submenus.

```
┌────────────────────────────────────────────────────────────────────────┐
│ ⬛ Floom  │  Settings                                                   │
│ Overview │                                                              │
│ Workers  │  [ API access ] [ Notifications ] [ Appearance ] [ Danger ] │
│ Runs     │  ─────────────                                               │
│ Secrets  │                                                              │
│ Connect. │  Floom secret                                                │
│ Settings●│  Used by CLI / MCP to authenticate as you.                   │
│          │  ┌──────────────────────────────────────────────────────┐   │
│          │  │ x-floom-secret: ••••••••••••••••••••••••••••••••     │   │
│          │  │ [👁 Reveal] [⎘ Copy] [↻ Rotate]                      │   │
│          │  └──────────────────────────────────────────────────────┘   │
│          │  ⚠ Rotating invalidates all CLI / MCP installs.             │
│          │                                                              │
│          │  Rate limit                                                  │
│          │  2000 requests / minute. Read-only.                          │
│          │                                                              │
│          │  Webhook signing key                                         │
│          │  Used to verify trigger callbacks from connection providers. │
│          │  ┌──────────────────────────────────────────────────────┐   │
│          │  │ whsec_•••••••••••••••••••••••  [👁] [⎘] [↻]         │   │
│          │  └──────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────────────────┘

- Tabs synced to URL: /settings?tab=api (default), /settings?tab=danger etc.
- NO expanding sidebar submenus. Same pattern as side-nav B for /workers/[id]
  but horizontal (tabs are for ≤6 items, vertical rail for ≥6 OR per-entity).
- Danger tab: "Wipe all runs" (with type-to-confirm), "Delete account" (v1).
- Appearance tab: theme (light/dark/system), font (v1, currently Inter only).
- Notifications tab: email-on-run-failure toggle (v1, no email infra yet).
```

---

## Navigation pattern decision (the operator 2026-05-27)

**Chosen: flat sidebar + in-page tabs (NOT expanding sidebar submenus).**

Rationale:
- 6 top-level items fit flat (Linear, Vercel, Notion all use this pattern at our scale).
- Submenus add hover/click ambiguity, two-level cognitive load, worse keyboard nav.
- Sub-sections live INSIDE the page: horizontal tabs (Settings) or vertical rail (per-entity, like /workers/[id]).
- Re-evaluate only if top-level grows past ~8 items.

---

## Worker mode simplification (the operator 2026-05-27, shipping in PR S11)

Drop the three-mode model (`agent | pure-script | hybrid`). The entry point IS the truth — full stop:

```yaml
exec:
  entry: SKILL.md   # → agent loop (LLM reads it, uses tools)
  # or
  entry: run.py     # → just exec the script
  # or
  entry: run.sh     # → just exec the script
```

- Only `exec.entry` decides what runs. Other files in the bundle have zero special meaning to the platform.
- If `entry: SKILL.md` and a `run.py` also exists in the bundle, the platform still runs the agent loop. The script just sits there. The agent may decide to call it (via `read_file` / `run_command` tools) or ignore it.
- If `entry: run.py` and a `SKILL.md` also exists, the script runs. The markdown sits there. The script can `open("SKILL.md")` if it wants.
- Hybrid is not a platform mode — it's a pattern the script implements by calling an LLM library itself.
- `ExecModePicker.tsx` is now a read-only display that shows the resolved entry from `exec.entry` in the saved worker.yml (NOT inferred from file list — see TODO below).

TODO (PR S11.1): `apps/web/app/workers/[id]/edit/page.tsx` `detectEntry()` currently infers from the file list. It should parse `exec.entry` out of the editable worker.yml content instead. Display the entry the user actually saved, not a guess.

---

## Tracking

| Layout | Decision | PR | Status |
|---|---|---|---|
| Side-nav B on /workers/[id] | the operator chose B + Triggers | PR S8 #58 | ✅ merged |
| Sparklines on worker cards | Approved | PR S8 #58 | ✅ merged |
| Drive folders on /workers | Approved (superseded by S12 simplification) | PR S8 #58 | ✅ merged |
| /workers/new Option A | the operator chose A + skip Step 2 | PR S9 #60 | ✅ merged |
| Worker mode → entry point | the operator 2026-05-27 (3 modes → 1 field) | PR S11 | 🔄 in flight |
| Tools by default + disable_tools opt-out | the operator 2026-05-27 (web_search default-on) | PR S11 | 🔄 in flight |
| /overview page (4 stats + recent + scheduled + attention) | Locked the operator 2026-05-27 | PR S12 | 📋 queued |
| /runs page (clickable rows, sparkline header) | Locked the operator 2026-05-27 | PR S12 | 📋 queued |
| /runs/[id] detail (output-first, download, collapsibles) | Locked the operator 2026-05-27 | PR S12 | 📋 queued |
| /workers Drive-clone simplified (kill Recent/Favs/Tags) | Locked the operator 2026-05-27 | PR S12 | 📋 queued |
| /settings in-page tabs | Locked the operator 2026-05-27 | PR S12 | 📋 queued |
| Global `<Tabs>` primitive (DRY across all pages) | Locked the operator 2026-05-27 | PR S12 | 📋 queued |

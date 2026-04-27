# Pallavi — Floom launch-week brief (2026-04-27, revised post-codex demo-apps ship)

You own two main workstreams + one stretch. We (claude + codex + Federico) handle UI / wireframes / spec — you handle backend, agent flows, and end-to-end testing as a real user. Zero UI overlap.

Repo: `~/floom` (public, `floomhq/floom`). Preview: `https://preview.floom.dev`. Backend lives in `apps/server/`. SQLite primary at `/data/floom.db`. Stack: Hono + Bun + React + Vite. Open issues: `gh issue list -R floomhq/floom`.

Foundational reading (read before any work):
- `/root/floom/docs/FLOOM-ARCHITECTURE-DECISIONS.md` (33 ADRs locked, full architecture)
- `/root/floom/docs/V26-IA-SPEC.md` (UI/IA spec — for context only, don't touch UI)
- `/root/floom/CLAUDE.md` (the bar: 10/10 or keep working)
- `/root/.claude/projects/-root/memory/feedback_floom_demo_apps_cap_10s.md` (every demo app must run <10s)

---

## Workstream 1 — Demo apps (DONE — codex shipped 2026-04-27, commit `23bf660`)

Six launch demos verified on preview, input-native:

- `https://preview.floom.dev/p/linkedin-roaster` (URL input, Apify-backed)
- `https://preview.floom.dev/p/yc-pitch-deck-critic` (file input — text/Markdown)
- `https://preview.floom.dev/p/floom-this` (repo URL input)
- `https://preview.floom.dev/p/claude-wrapped` (file input)
- `https://preview.floom.dev/p/session-recall` (file input)
- `https://preview.floom.dev/p/hook-stats` (file input)

Stretch task if you have bandwidth: **YC pitch-deck critic accepts text/Markdown export today, not PDF/PPTX**. Add real PDF/PPTX extraction (e.g., `pdfminer.six` for PDF, `python-pptx` for PPTX). Codex called it 9/10 launch quality on this gap; 10/10 needs PDF/PPTX. Owner acceptance: Federico runs his real YC deck PDF and the critic returns useful feedback.

---

## Workstream 2 — Backend / agent-flow gaps

GitHub-tracked. Pick whichever is open + unassigned. All parallel-safe with the UI track.

| Issue | What | Where |
|---|---|---|
| #71 (Wave A) | Agent-token quick-mint flow + Copy-for-Claude bug | `apps/server/src/routes/agent_keys.ts` + `/install/:slug` |
| #75 | Backend cleanup: `/embed/:slug`, `LAUNCH_LISTED_SLUGS`, URL cleanup | `apps/server/src/routes/` (pick one cleanup task per PR) |
| #76 | Wire `/studio/:slug/source` and `/feedback` server routes (currently 404) | `apps/server/src/routes/studio.ts` (or new file) |
| #91 | Re-verify OAuth + Resend on real prod creds | follow `/root/floom/docs/OAUTH-VERIFICATION.md` + `/root/floom/docs/EMAIL-VERIFICATION.md` |

ADRs 22-33 are the source of truth for any new backend code. If something's ambiguous, read those first; if still ambiguous, ask before coding.

**Deliverable**: One PR per issue. Closes the issue, includes test or curl-verified evidence, screenshot if user-visible.

**Verification rule** (Federico's iron law in `/root/CLAUDE.md`): No "done" without a fresh verification command + its full output + exit code. "Should work" is banned.

---

## Workstream 3 — End-to-end ICP testing via Claude Code

**Problem**: Federico's `feedback_verify_agent_completion.md` rule — UI/parity claims need human eyeballs. We've been doing this ourselves. You take it over: drive Claude Code as a real ICP would, find bugs, file them.

**Your job**:
Run 3 ICP scenarios end-to-end on `https://preview.floom.dev` using Claude Code (or Cursor / Codex CLI — whichever you prefer, all three are valid surfaces). File one GH issue per bug found.

### Scenario A — "Vibe-coder discovers Floom, installs first app via MCP"
1. Hit `https://preview.floom.dev/`. Sign up (Google or email/password).
2. Browse `/apps`. Pick a public demo. Click "Install in Claude".
3. Copy the MCP install snippet. Add to Claude Desktop / Codex config.
4. From Claude Code, ask the model to use the floom MCP server to run that app.
5. Verify: run completes <10s, output renders cleanly, you can find it again in `/run/runs`.

### Scenario B — "Creator publishes their first app from a GitHub repo"
1. Sign up. Click "+ New app" in Studio.
2. Paste `https://github.com/federicodeponte/openblog` (has a valid OpenAPI manifest — Federico's `feedback_ingestion_be_helpful.md` rule says ingest must auto-detect this).
3. Verify: ingest succeeds, app lands in `/studio/apps`, you can run it.
4. Click Publish. Verify it goes to `pending_review` (ADR-31).

### Scenario C — "Non-dev mints an agent token + uses it from curl"
1. Sign up. Go to `/settings/agent-tokens`.
2. Create a new token. Format MUST be `floom_agent_*` (ADR-28 + locked vocab — anything else is a bug).
3. Pick a public app. Run it via `curl -H "Authorization: Bearer floom_agent_*" https://preview.floom.dev/api/<slug>/run -d '{...}'`.
4. Verify: 200, valid JSON output, run row appears in `/run/runs` scoped to the right workspace.

**Deliverable**: GH issues filed for every bug. Target 15-30 real bugs surfaced across the three scenarios.

**Acceptance**:
- Each issue has: 1-line title, reproducer steps, screenshot or curl output, label (`launch-week` + `bug` + `mobile`/`design`/`ingest`/etc.).
- File against `floomhq/floom`, not `-internal`.
- One issue per bug — don't lump.

---

## Coordination

- **Don't touch**: `apps/web/src/components/`, `apps/web/src/pages/`, `/var/www/wireframes-floom/v26/` — those are claude+codex's UI track this week.
- **Do touch**: `apps/server/`, GH issues, demo app manifests.
- **Sync**: post a daily 5-line update in the team thread. Format: `[done] · [in flight] · [blocked]`.
- **Pair-mode**: if a backend change needs a UI follow-up, file the issue and tag `@claude` or `@codex` in the body. We pick it up.

## Open questions for Federico (ask if needed)

- Demo app branding: should authorship show "Floom team" or your real name?
- For Scenario A, do you have a Claude Desktop on your laptop to test the install snippet end-to-end?
- Bug threshold: do you want PRs for the small fixes you find, or just file issues and let the UI team handle?

— claude (drafted 2026-04-27, hand off to Federico for review)

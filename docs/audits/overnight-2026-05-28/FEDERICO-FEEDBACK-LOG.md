# the operator feedback log — 2026-05-28 (live review session)

This is the source of truth for outstanding UI/UX issues the operator has surfaced
across the overnight session. Every item is OPEN until I (Claude) ship a fix
AND the operator confirms on prod. No "looks good" without a screenshot from him.

**Owner of S29+ queue:** me (Claude). Backend = Codex (under my orchestration).
the operator is the reviewer + gate; he does not write code.

---

## ROUND 8 (12:20-12:30 UTC) — items just raised

### F8.1 — `/runs/<id>` still unaligned with other pages
**Status:** OPEN
**Severity:** P1
**Round:** my S27 attempt judged insufficient
**Notes:** Even after my "chrome aligned to /workers/<id>" S27 change, the operator
says it's still off. Need a side-by-side audit: open /workers/research_brief and
/runs/<run_id> in two windows, screenshot, diff every difference (container
width, padding, H1 size, status pill placement, subtitle format, action-button
slot, sticky header z-index, scroll behavior).
**Fix path:** explicit side-by-side audit doc before any code. List every
divergence with screenshot. Then ONE PR that aligns them.

### F8.2 — Settings → "Setup commands" card is ugly (Image #48)
**Status:** OPEN
**Severity:** P2
**Notes:** Tabs (CLI / MCP / API) feel small + uneven against the card. Card
has a faint blue glow border which looks accidental. Copy button at top-right.
The whole block reads as "designed by three different people".
**Fix path:** rebuild the SetupCommandsPanel with: clean shadcn Tabs row,
single ring border (no glow), Copy button INSIDE the code block (top-right
corner of the pre, not floating outside it).

### F8.3 — Token mask shows `924a. fe59` instead of `924a...fe59` (Image #49)
**Status:** OPEN
**Severity:** P2 (bug)
**Notes:** The S21 token-mask fix uses 4-and-4 pattern but the join character
is being rendered as ". " (period + space) instead of "..." (3 dots).
**Fix path:** trace the mask function (`maskSecret` in `CliCommandPanel.tsx`),
verify the separator is exactly `…` or `...`, render in a non-mono-but-stable
font so the dots align.

### F8.4 — Worker card hover behavior wrong (Image #50)
**Status:** OPEN
**Severity:** P1
**Notes:** S26 made sparkline/trigger/extended-stats hover-only, but on hover
the card GROWS (height changes). the operator wants:
  - Card size MUST NOT CHANGE on hover.
  - On hover, the sparkline/trigger/stats REPLACE the description+tags (not
    appear in addition).
  - OR show the chart instead of labels by default + labels on hover.
  - "I honestly don't know what's best" — explore both options + pick the
    cleaner one.
**Fix path:** rebuild WorkerCard with fixed dimensions + a CSS crossfade
between two layers (default = description+tags+timestamp, hover = sparkline+
trigger+stats). Same h-full bounding box.

### F8.5 — Tag filter row missing from top of /workers (Image #50)
**Status:** OPEN
**Severity:** P1
**Notes:** S26 added click-to-filter on individual card tags, but the operator
expected a top-level FILTER ROW showing all available tags as togglable
pills (like the "Operations / Recruiting / Research" category row that
currently exists for folders). The category row IS folder, not tag.
**Fix path:** add a "Tags" pill row above the card grid (same visual style
as folders row) showing all unique tags across workers, click-to-toggle
multi-select filter. Persists in URL.

### F8.6 — /workers/resume_helper skeleton outdated
**Status:** OPEN
**Severity:** P2
**Notes:** The worker detail page (separate from the workers list) has a
skeleton that doesn't match the new tabs+configuration layout.
**Fix path:** rebuild WorkerDetailSkeleton to match the actual rendered
shape (H1 + status pill + tabs row + Configuration card + Worker guide).

### F8.7 — /workers/resume_helper Overview content "hard to digest" (Image #51)
**Status:** OPEN
**Severity:** P1
**Notes:** Configuration block (Trigger/Runtime/Runner/Inputs/Outputs) + Worker
guide block (Description/Use cases) is dense + cramped. the operator: "wtf is this
layout and content? so hard to digest? who is our ICP?"

ICP question is fair: who reads this? A developer wants config first. A
non-developer wants "what does this do? what inputs?" first.
**Fix path:** restructure Overview tab:
  - Big readable description at top (h2 + paragraph, not a code-style row)
  - "What it does" — bulleted use cases in plain text
  - "How it works" — 1-paragraph plain English
  - Config block moves to a collapsible "Technical details" section at bottom
    (Trigger / Runtime / Runner go there)
  - Inputs + Outputs stay visible but as labeled chips, not raw key-value rows

### F8.8 — Triggers tab "ugly asf" (Image #52)
**Status:** OPEN
**Severity:** P1
**Notes:** Even after my S22g radio-cards-with-subtitles refresh. the operator still
hates it. The card border + "TRIGGER" / "TRIGGER TYPE" double labels feel
redundant. The Save/Discard footer is awkwardly placed.
**Fix path:** strip down to:
  - Single H2 "Triggers" + brief subtitle
  - Trigger type picker as inline segmented control (not big radio cards)
  - Type-specific config below the picker
  - Save button on the same line as "Add trigger" (compact action bar)

### F8.9 — Custom dropdown ugly (Image #53)
**Status:** OPEN
**Severity:** P2
**Notes:** branded_markdown / plain_summary / two_pager dropdown is a custom
floating menu, not shadcn Select. "literally just take what shadcn has".
**Fix path:** replace with `<Select>` from `@/components/ui/select` (we already
import it elsewhere). Match the rest of the form fields.

### F8.10 — "Use sample input" placement awkward
**Status:** OPEN
**Severity:** P2
**Notes:** The "Use sample input" affordance sits under a dropdown. Should be
a clear button NEAR the input fields it affects, with explicit text
"Fill with example".
**Fix path:** move to top of the Run form, label it "Fill with sample input"
+ trash icon next to it to clear inputs.

### F8.11 — Source tab unreadable (Image #54)
**Status:** OPEN
**Severity:** P1
**Notes:** worker.yml content rendered in dark blue/black with extremely poor
contrast. "who on earth can read this?"

Looking at the screenshot: YAML has syntax highlighting in dark navy blue on
dark background — both backgrounds AND text in light mode.
**Fix path:** use proper theme-aware syntax highlighting. Either:
  - Drop highlight.js' github-dark theme + use github-light in light, dark in
    dark
  - OR no syntax highlighting at all — plain mono with comfortable contrast
  - Default to NO highlighting if I can't get theme-aware right in 1 iteration

### F8.12 — Generating panel "0 engagement, I leave the page" (Image #55)
**Status:** OPEN
**Severity:** P1
**Notes:** My S25 honest indeterminate bar + elapsed counter is still empty.
"0 progress showing, 0 engagement for me I leave the page".

Honest read: indeterminate bars are honest but boring. Users want either
(a) a real progress estimate OR (b) entertaining diversion (what's being
generated visualized, sample output preview, "fun facts" cycling).

The right answer is (a) but requires the async-draft backend (S22d-like SSE
for /workers/drafts) — which is the brief queued for Codex.
**Fix path:**
  - Short term (this round): add a streaming "current step" line that
    cycles through 5-6 stages (Understanding... → Calling LLM... → Drafting
    worker.yml... → Writing run.py... → Validating... → Opening editor),
    EACH stage shows for a believable duration (3-5s) and the bar
    actually animates with the stages instead of pure indeterminate.
    Honest disclaimer: stages are best-guess timing, not backend-driven.
  - Long term: real SSE from /workers/drafts/<id>/stream (Codex async-draft
    brief queued).

### F8.13 — Overall design alignment
**Status:** standing rule
**Notes:** "Want all UI to be super aligned." This is the umbrella concern
behind F8.1, F8.2, F8.7, F8.8, F8.11. Each page should use the same:
  - Container width (max-w-7xl)
  - Header pattern (back-nav → H1 + status pill → subtitle → right-side actions)
  - Card style (single border-line border, no extra glow rings)
  - Tab style (shadcn Tabs, no custom rolls)
  - Form style (shadcn Input/Select/Textarea, no custom dropdowns)
  - Code/preview style (consistent theme-aware highlighting OR uniform plain mono)
  - Empty state style (centered + icon + headline + subtitle + CTA)
**Fix path:** S29 needs a "design alignment sweep" subtask that visits every
page and checks against this checklist. Diff and fix.

---

## ROUND 7 (earlier today) — the operator's items, status updated

### F7.1 — /connections Connected too tall (5+ rows wouldn't fit)
**Status:** DONE (S27 row table)
**Verified by the operator:** Yes (Round 8: "this is actually good. simply add a search bar")
**Follow-up:** Search bar added in S28 (live).

### F7.2 — /runs didn't change at all
**Status:** DONE (S27 real columnar table with Worker/Trigger/Duration/Status/Started)
**Verified by the operator:** Not yet confirmed in Round 8 (he saw it but moved on)

### F7.3 — /runs/<id> not aligned with other pages
**Status:** ATTEMPTED (S27) but the operator flagged again in Round 8 → see F8.1
**Re-open** as F8.1.

### F7.4 — Connections grid like Browse
**Status:** REVERTED (the operator said "row is good, add search" in Round 8)
**Lesson learned:** I should have asked before assuming "same design as Browse"
meant grid. He meant "tabs + chrome consistency".

---

## ROUND 6 backend findings (your audit) — status

| ID | Finding | Status | Fix PR |
|---|---|---|---|
| CRIT-3 | DELETE /connections IDOR | FIXED | #82 (merged) |
| CRIT-4 | GET /connections PII | FIXED | #82 (merged) |
| HIGH-6 | DoS input reflection | PARTIAL → FIXED in R7 | #89 (merged) |

## My adversarial probe findings (post R6) — status

| ID | Finding | Status | Fix PR |
|---|---|---|---|
| NEW-1 P0 | POST /workers validation echo | FIXED | #89 (merged) |
| NEW-2 P1 | /cli-auth/devices phishing | FIXED | #89 (merged) |
| NEW-3 P1 | Secret length cap | FIXED | #89 (merged) |
| NEW-4 P1 | CF-IP for ratelimit | FIXED | #89 (merged) |

## Round 7 (the operator's audit) — status

| ID | Finding | Status | Fix PR |
|---|---|---|---|
| MED-8 | /runs/{id}/logs PII | FIXED | #89 (merged) |
| MED-9 | /connections/{id}/account-info PII | FIXED | #89 (merged) |
| MED-10 | /connections/auth-configs/{id} internal | FIXED | #89 (merged) |

**Live verification status:** Adversarial probe agent currently running against
prod (background task `a8c1d405dd6358839`). Output → `docs/audits/kimi-adversarial-r7-verify-2026-05-28.md`.
Until that report lands, treat the merged status as "fixed in code" not
"verified live on prod".

---

## Cumulative pattern recognition (honest)

the operator has surfaced 30+ UI issues across S22-S28 in real-time review. Each
round I shipped surgical fixes; each round he found more. The pattern says:

1. I am too quick to claim "done" without walking the surface like a user.
2. Piecemeal fixes leave drift between pages — F8.13 is the natural result.
3. The UI test matrix exists but I have not walked it (0/412 ticked).

**Course correction for S29:**
- For every fix, click through 3 adjacent pages to verify alignment.
- Drop any item from "done" if I can't show a the operator-visible screenshot
  of the fix.
- Walk the highest-traffic D rows of the matrix BEFORE shipping S29 — find
  drift first, then fix in one pass.

---

## S29 plan (sub-PRs) — all shipped, awaiting the operator verification

Each PR was built in an isolated worktree, built clean, merged, deployed
to prod (workers.floom.dev), and verified via deployed-bundle grep of
distinctive markers.

| # | Scope | PR | Status |
|---|---|---|---|
| S29a | F8.3 token-mask glyph + F8.9 humanize Select labels | #92 | LIVE |
| S29b | F8.4 fixed-size card hover + F8.5 tag filter row + footer profile | #93 | LIVE |
| S29c | F8.11 Source tab theme-aware highlighting | #94 | LIVE |
| S29d | F8.7 Overview tab restructure (description-first) | #95 | LIVE |
| S29e | F8.8 Triggers strip-down + F8.10 sample-input placement | #96 | LIVE |
| S29f | F8.2 Setup commands rebuild + F8.6 worker-detail skeleton | #97 | LIVE |
| S29g | F8.12 staged Generating panel | #98 | LIVE |
| S29h | F8.1 /runs/<id> chrome alignment to /workers/<id> | #99 | LIVE |
| S29i | F8.13 design alignment sweep (cron + file editor + exec mode + callback) | #100 | LIVE |

All F8.x items have a shipped fix. the operator verification gate is now open:
he reviews on prod, I patch any drift.

**Still pending (not in this S29 wave):**
- F8.1 may need a second pass after the operator's eye on the new /runs/<id> chrome
- Pending Codex async-draft backend (S29 timer is interim for F8.12)
- RequirementsEditor + badge.tsx hex literals (low-visibility, not done in S29i)

---

## Standing instructions (mine, for the rest of this session)

1. **Document every the operator complaint here BEFORE writing code.** No more
   tactical fixes that lose track.
2. **Click 3 adjacent pages per fix** before claiming done.
3. **Save screenshot evidence to `/root/workeros/docs/audits/overnight-2026-05-28/round-N-screenshots/`** per round.
4. **Push back honestly** if a fix conflicts with a prior fix (S26 vs S27
   Connected grid was this exact pattern — I should have asked).
5. **Acknowledge skill ceiling** on visual design: my taste is bounded; offer
   options when uncertain rather than picking and shipping.

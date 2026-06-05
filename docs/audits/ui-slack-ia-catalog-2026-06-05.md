# Slack IA + Catalog UI Audit — 2026-06-05

Gap items M41, M43, M44, M45, M46. Verify-first approach: each item checked
against live prod (workers.floom.dev) before any code change.

---

## M43 — Slack in /connections nav tab (P1)

**Status: VERIFIED-DONE (already fixed by PR #415)**

Before screenshot: `before-connections-2026-06-05.png`

The Connections nav shows exactly four tabs: `Connected | Browse | MCP | Secrets`.
No Slack tab is present. PR #414 moved Slack to Settings → Slack tab; PR #415
removed the Connections nav tab. Both merged to origin/main before this audit.

The comment in `ConnectionsTabs.tsx` explicitly documents: "Slack is the HUMAN
INTERFACE (DM assistant, @mention, approvals) — NOT a worker OAuth connection.
It lives at Settings → Slack (#slack). /connections/slack redirects there. DO NOT
add a Slack tab here."

**No code change needed.**

---

## M44 — "Connect to Slack" CTA buried below tutorial (P1)

**Status: BUILT**

Before screenshot: `before-settings-slack-2026-06-05.png`

Before: layout was heading → description → tutorial (3 steps) → CTA button.
The "Add to Slack" button sat below 3 tutorial lines.

Fix in `apps/web/components/assistant/SlackConnect.tsx`:
Moved the CTA button + connected-status row ABOVE the tutorial. Order is now:
1. Heading + description (always visible)
2. Add to Slack button (first actionable element, visible on load)
3. Platform-not-ready warning (conditional)
4. Tutorial steps (below CTA for reference)
5. Connected teams list (when connected)

The CTA is now the first interactive element after the heading — no scrolling
required on any screen size where the Settings page content is visible.

**File changed:** `apps/web/components/assistant/SlackConnect.tsx`

---

## M45 — No step-by-step Slack setup tutorial (P2)

**Status: VERIFIED-DONE (already present)**

Before screenshot: `before-settings-slack-2026-06-05.png`

The 3-step tutorial (`<ol>`) was already in the component prior to this audit:
1. Click Add to Slack and pick a workspace.
2. Approve the requested permissions.
3. DM the bot or @mention it in a channel.

The M44 fix preserved the tutorial and updated step 3 to name Emily directly
("DM Emily or @mention her") for better persona clarity.

**No additional code change needed beyond M44 reorder.**

---

## M41 — Emily Slack intro/bio confusing ("I help run this workspace") (P2)

**Status: PARTIAL BUILT (web layer) + BACKEND-DEP-FLAGGED**

**Web-layer fix** in `apps/web/components/assistant/SlackConnect.tsx`:

The Settings → Slack page description was:
> "Talk to your assistant from Slack — DM the bot or @mention it in a channel."

Updated to:
> "Your personal AI assistant — DM Emily or @mention her in a channel. She can run workers, surface approvals, and answer questions."

This positions Emily as a personal assistant (Chief-of-Staff framing), not a
generic workspace tool.

**Backend-dep part (DO NOT TOUCH apps/api):**

The "I help run this workspace" copy Federico flagged lives in the Slack bot's
`assistant_description` field — configured via the Slack API app dashboard or the
app manifest (not editable from `apps/web`). The backend greeting handler at
`apps/api/main.py` line 14450 currently sends:
> "I am ready. Ask me to inspect workers, draft an action, or list approvals."

This is already better than the old "I help run this workspace" (changed in an
earlier backend pass). To fully fix M41 the backend lane should update the Slack
app manifest's `assistant_description` to something like:
> "Your personal AI Chief-of-Staff — I route tasks to a swarm of always-on workers. DM me or @mention me."

**File changed:** `apps/web/components/assistant/SlackConnect.tsx`
**Needs backend follow-up:** Slack app manifest `assistant_description` + optionally the greeting text in `apps/api/main.py:_handle_slack_assistant_thread_started`.

---

## M46 — Catalog card "expand" is scroll-hell (P2)

**Status: VERIFIED-DONE (already fixed)**

The browse catalog page (`apps/web/app/connections/browse/page.tsx`) already uses
a `ToolsModal` component backed by the shadcn `Dialog` primitive. When a user
clicks the "N tools" chip on a catalog card, a modal opens with:
- Scrollable tool list (max-h-[80vh], overflow-y-auto)
- Search filter
- Connect CTA in footer

No in-card expand blowup occurs. The modal approach was implemented in a prior
sprint and is already on origin/main.

**No code change needed.**

---

## Summary table

| Item | Status | File changed |
|------|--------|-------------|
| M43 Slack not in /connections | VERIFIED-DONE | none |
| M44 CTA at top of Slack page | BUILT | `apps/web/components/assistant/SlackConnect.tsx` |
| M45 Step-by-step tutorial | VERIFIED-DONE | none (M44 reorder preserved + improved) |
| M41 Emily bio — web layer | BUILT | `apps/web/components/assistant/SlackConnect.tsx` |
| M41 Emily bio — Slack manifest | BACKEND-DEP-FLAGGED | needs `apps/api` backend lane |
| M46 Catalog modal not in-card | VERIFIED-DONE | none |

**One file changed total:** `apps/web/components/assistant/SlackConnect.tsx`

Before screenshots: `before-settings-slack-2026-06-05.png`, `before-connections-2026-06-05.png`
After screenshots: taken post-deploy when PR is merged.

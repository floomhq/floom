# Workeros UI design spec — 2026-06-06 (the operator live-walk)

Design direction from the operator's walkthrough. Bar: Workeros-native (workers.floom.dev design language), ChatGPT-simplicity, no AI-slop, real brand logos. This is ONE coherent UI pass (run after the convergence deploy clears apps/web). Status: DESIGN — discuss before build.

## 1. Connections — "Connecting" needs a live progress indicator
- Problem: connection rows stuck on a static amber "Connecting" pill (e.g. Gmail fede@rocketlist.ai, 12 scopes) — looks frozen, low trust.
- Design: animate the connecting state — inline spinner + thin determinate-or-indeterminate progress on the row while OAuth resolves. Resolve to Active/Failed with a clear transition.
- Related (separate, backend): M81 connection account label + M82 "Connecting" that never finishes + the ⋯ actions (Test/Refresh/Disconnect) — being fixed in the connections-detail lane.
- DECISION: progress style — indeterminate shimmer/bar vs a stepped checklist (OAuth → scopes → ready)?

## 2. Worker share page — Workeros-native, NOT a literal floom.dev copy
- Problem: current /w/[id] (and #455) copied floom.dev/s pixels too literally — the "Copy install command" + `npx floom add <token>` artifact is Floom-skill semantics, wrong for a Workeros worker.
- Design: keep the standalone noindex page CONCEPT; re-skin to workers.floom.dev. Show the worker AS A WORKER: name, one-line what-it-does, trigger, tools (with brand logos), last/example result. Workeros styling + tokens. Drop the install-command artifact.
- DECISION: primary CTA — "Run this worker" (try live) vs "Add to your workspace" (clone into their Workeros) vs both. Sender strip: keep "shared by <name>"?

## 3. Brain file & pack share — content-first, not abstract cards
- Problem: file/pack share UI "makes no sense" — a card-with-download wrapper.
- Design: a shared FILE renders the actual file CONTENT inline (markdown/text/doc rendered), with a quiet download + title/source. A shared PACK = the pack's files listed with real content previews (not abstract tiles). noindex standalone.
- DECISION: non-text files (PDF/xlsx/image) — inline viewer vs thumbnail+download? (probably: render text/md inline, thumbnail+download for binary.)

## 4. Run page — lead with content, kill the vertical stack/scroll
- Problem: Output + Files + Recent-logs stacked vertically = scroll-pile. Plus status/duration repeated 3x, "Floom" branding, lowercase "completed".
- Design: lead with the RESULT CONTENT rendered inline (the audit.md IS the main view). Files + Logs secondary — a right rail or the existing tabs, not three stacked blocks. One status line (chip + facts), no duplicate pill, no redundant stat strip. Workeros branding (not Floom). Title-case statuses.
- DECISION: result content as the default tab vs a 2-pane (content left, files/logs rail right)?

## 5. Prompt box — unified tool+capability highlighting everywhere
- Problem: tools (Granola/HubSpot) not detected/highlighted in the prompt box; inconsistent across surfaces.
- Design: ONE shared detector used on the landing hero box, /workers/new box, example cards, and the assistant prompt. Detect connection-apps AND capabilities (web search/browser, schedule, email-send). Since a textarea can't render rich inline highlights, show DETECTED items as a chip row (icon + name, pre-selected) directly under the prompt box.
- Landing prompt box → prefill + route to /workers/new + Generate.
- DECISION: chips-under-the-box (pre-selected, removable) — confirm that's the right pattern vs inline highlight on a contenteditable.

## 6. Approval share page — MISSING, build it
- Gap: /approvals/review is public in middleware but no page exists. Build the approval standalone share to the same Workeros-native /s/<token> pattern (what's being approved, the action, approve/deny if authorized, noindex).

## Build order (after convergence deploy)
Connections progress → run page → worker share re-skin → file/pack content → prompt-box detector + landing route → approval share page. One PR per surface or one stacked branch; visual-verify each against this spec.

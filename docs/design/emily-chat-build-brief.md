# Emily real web chat — build brief (2026-06-05)

Goal: ship the REAL Emily chat (not a prototype). This is the flagship. Two parts; THIS brief is the BACKEND part (frontend follows once the SSE contract is verified live).

## Source of truth
- Protocol design: docs/design/emily-agentic-chat-2026-06-05.md (async tool-card model: enriched SSE events chat.meta, tool-progress, tool-resource, tool-action-required, plus the normal token stream).
- Existing backend WIP: PR #437 ("Implement Emily chat Phase 1 backend protocol") — OPEN, unverified.
- Persona: EMILY_BASE_PERSONA (v5, already live) assembled by _build_system_prompt in apps/api/chat_service.py.

## Backend deliverable
1. Assess PR #437 vs the design doc: what of the enriched SSE protocol is implemented vs missing on the /chat endpoint. Report a gap list.
2. Finish the backend so the FULL documented SSE contract is served by the live /chat endpoint: the token stream PLUS the async tool-card events (chat.meta on start, tool-progress as tools run, tool-resource for produced artifacts, tool-action-required for approvals). Tools must run async without blocking the token stream (the async tool-card model — same lesson as the M73 create-timeout fix: never block the HTTP request on long work).
3. Conversations persist fully (Federico wants all conversations stored for Emily — no eviction; the _maybe_evict_conversation 50-cap was flagged for no-evict). Verify storage is durable.
4. Tests for the protocol (event ordering, tool-card lifecycle, approval round-trip).
5. Verify LIVE: curl the /chat SSE endpoint with a real prompt that triggers a tool call, capture the event stream, and CONFIRM each documented event type appears in the right order.

## Output (critical for the frontend)
Report the EXACT live SSE contract: every event name + its JSON payload shape, the ordering guarantees, and how the frontend maps each to a UI element (token -> message text, tool-progress -> Tool card state, tool-resource -> artifact, tool-action-required -> approval/confirmation card). The frontend lane builds against THIS, so it must be precise and match what the live endpoint actually emits.

## Discipline
- Worktree off origin/main, commit+push each step, open/merge PR (admin if GH Actions billing-blocks the runner, after local tests pass — document it).
- Do NOT deploy to prod without running ops/smoke-routes.sh and confirming non-508/5xx.
- No secret values. No em dashes in any user-facing strings.

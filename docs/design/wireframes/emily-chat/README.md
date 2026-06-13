# Emily Agentic Chat — Wireframes

Static HTML wireframes for the operator to review before implementation. Open `index.html` in any browser.

## Screens

| File | Screen | Rationale |
|------|--------|-----------|
| `01-dock-collapsed.html` | Dock collapsed — floating Emily FAB bottom-right on /overview | Entry point: unobtrusive, no label, solid blue circle per spec |
| `02-dock-open.html` | Dock open (400px) — full card flow | The agentic richness showcase: worker creation mid-build → created, run card, approval card, connection-needed card |
| `03-fullpage.html` | Full-page /assistant with Chat / Instructions / Final prompt tabs | Same conversation, wider, centred at 760px max-width; cards breathe more |
| `04-mobile.html` | Mobile 375px — dock as full-screen overlay | Chat-native layout; identical card renderer; bottom-safe input area |
| `05-empty-states.html` | Three-panel: empty state, streaming, live run card | Shows all transient states: suggestion pills, typing indicator, tool working inline, queued cards |

## Card model rationale

Cards are the primary output unit. Each async tool call (worker creation, run, approval, connection) gets its own structured card with:
- A status pill (building / passed / running / needs-action / queued)
- Stage dots for multi-step operations (drafting → generating → smoke → ready)
- Inline actions (Open, Run, Approve, Reject, Download) — no navigation required
- Live state that updates via run event streams without re-rendering the message

This matches the async tool-card model in `emily-agentic-chat-2026-06-05.md` while keeping the visual language at ChatGPT-level simplicity: no colored left borders, no gradient cards, one blue accent (Emily's avatar + pill highlights).

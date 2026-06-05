# Emily Web Chat Audit — 2026-06-05

**PR:** feat/emily-web-chat  
**Auditor:** Claude Code (claude-sonnet-4-6)  
**Status:** Implemented, pending visual verification (PR open, not merged)

---

## What Was Built

### Library choice: prompt-kit patterns adapted to project

prompt-kit (prompt-kit.com) ships shadcn-style AI chat primitives. However, their
components target Tailwind v3 with `@tailwindcss/typography` as a PostCSS plugin,
whereas this project uses Tailwind v4 with `@plugin "@tailwindcss/typography"` syntax.
The CSS-var token system (`var(--primary)`, `var(--muted-foreground)`, etc.) is also
project-specific and not compatible with prompt-kit's out-of-the-box classes.

**Decision:** Adapted prompt-kit's UX patterns (message thread, streaming render,
auto-scroll, input with grow/send) directly into `components/EmilyChat.tsx` using
the project's native CSS variables and shadcn tokens. No new npm packages added.
`react-markdown` and `remark-gfm` (already in `package.json`) handle markdown render.

This is NOT reinventing — it is porting the commodity library's patterns to match
the project's token system (the same thing shadcn CLI does: copy, adapt, own).

### Files changed

| File | Change |
|------|--------|
| `apps/web/components/EmilyChat.tsx` | New — self-contained Emily chat component |
| `apps/web/app/assistant/page.tsx` | Modified — Chat tab added as first/default tab |

### Chat component features (EmilyChat.tsx)

- **Streaming SSE** — `fetch()` with ReadableStream reader, parses `data: {...}` lines
- **SSE event handling:**
  - `type: text` — appended to assistant message text (incremental render)
  - `type: tool-call` — shows "Emily is working… (tool: X)" indicator with Wrench icon
  - `type: tool-result` — marks tool done (indicator clears on next text)
  - `type: finish` — captures `conversation_id` for multi-turn continuity
  - `type: error` — surfaces error message with retry button
- **Multi-turn** — `conversation_id` persisted in component state, sent on subsequent messages
- **Markdown render** — `react-markdown` + `remark-gfm` with prose styling matching project
- **Auto-scroll** — scroll-to-bottom when near bottom during streaming; manual scroll button when scrolled up
- **Input** — auto-grow textarea, Enter to send, Shift+Enter for newline
- **Empty state** — Emily avatar + "Ask me anything" prompt
- **Error state** — inline error banner with retry (re-sends last user message)
- **Emily avatar** — solid `#59AAF8` circle (matches Workeros accent blue, per C6 spec)
- **Auth/workspace** — reads `workeros.activeWorkspaceId` from localStorage, adds `x-workeros-workspace` header (matches existing `api.ts` pattern)
- **API path** — uses `NEXT_PUBLIC_API_PROXY_BASE || "/api/proxy"` (same env seam as `api.ts`)
- **No new deps** — react-markdown, remark-gfm, lucide-react all already in package.json

### /assistant page changes

- Tab order: **Chat** (default) | Instructions | Final prompt
- Hash routing updated: `#chat` / `#instructions` / `#prompt`
- Page title updated to "Chief of Staff" (matches Emily branding in WORKPLAN)
- Subtitle updated: "Emily — your AI Chief of Staff. Chat to orchestrate agents..."
- Slack footer note hidden when Chat tab is active (not relevant there)
- All existing functionality (workspace instructions edit, version history, prompt preview) preserved

---

## How /chat SSE is wired

```
Browser (EmilyChat.tsx)
  └─ POST /api/proxy/chat          (Next.js proxy route)
       └─ POST https://workers-api.floom.dev/chat
            └─ chat_service.py / stream_chat()
                 └─ OpenAI workspace-agent (Emily persona)
                      └─ SSE back through the chain
```

Auth: `x-floom-secret` injected by the proxy route (`apps/web/app/api/proxy/[...path]/route.ts`).
The frontend only calls `/api/proxy/chat` — no secrets in client code.

Request body:
```json
{ "message": "...", "conversation_id": "<null or previous>", "source": "web" }
```

SSE event format:
```
data: {"type":"text","text":"delta text..."}
data: {"type":"tool-call","toolName":"workers__list_all","callId":"...","args":{}}
data: {"type":"tool-result","callId":"...","result":{...}}
data: {"type":"finish","conversation_id":"conv_<uuid>","message_id":"msg_<uuid>"}
```

---

## Visual verification (pending)

The PR is open and unmerged per instructions. Visual verification against the live
Vercel preview deploy is pending — Vercel will auto-deploy the branch as a preview
URL once the PR is created. Screenshot verification should be done against:

1. `/assistant` landing on Chat tab (not Instructions)
2. Sending "what needs my attention?" and observing Emily's response stream in
3. Multi-turn: follow-up message uses same conversation_id (no amnesia)
4. Mobile 375px: input + thread usable
5. Dark mode: avatars, bubbles, input all readable

---

## Known rough edges (backend scope, not this PR)

- Tool activity shows tool name from SSE; for `workers__list_all` this renders as
  "list_all" after prefix strip. A display-name map could improve this.
- The typing dots CSS animation uses inline `style` (no keyframes in this component).
  Works cross-browser but could be a Tailwind `animate-pulse` variant.
- `conversation_id` is reset on component unmount (tab switch). If the user switches
  tabs and returns, context resets. Could be fixed by lifting state to page level.
- Backend bug A5 (em dashes in `tool-call` SSE events) not visible in the chat UI
  since the UI renders from `text` events, but `tool-call.args.reply` still carries
  unstripped em dashes at the protocol level.

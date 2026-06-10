# Emily Chat v2 — Research Findings

Date: 2026-06-05

## The Dominant Pattern (2026)

A **full-height right rail, ~1/3 of viewport width, resizable, collapsible to an icon strip** is the canonical AI chat placement for power-tool SaaS. Not a floating FAB. Not a bottom sheet. Not a modal. A permanent docked panel that users can resize or minimize without losing state.

---

## Primary References

### 1. prompt-kit (prompt-kit.com · github.com/ibelick/prompt-kit)

The closest design target. Built on shadcn/ui + Tailwind CSS. Key components:

- **ChatContainerRoot**: `StickToBottom` wrapper, `flex overflow-y-auto`, role=`"log"`. Auto-sticks to bottom as messages arrive.
- **ChatContainerContent**: `StickToBottom.Content`, `flex w-full flex-col` — the message column.
- **ChatContainerScrollAnchor**: `h-px w-full shrink-0 scroll-mt-4` scroll pin at bottom.
- **PromptInput**: `border-input bg-background cursor-text rounded-3xl border p-2 shadow-xs` — the distinctive pill-shaped input container.
- **PromptInputTextarea**: `min-h-[44px] resize-none border-none bg-transparent shadow-none focus-visible:ring-0` — transparent, auto-sizing, Enter submits.
- **PromptInputActions**: `flex items-center gap-2` — attachment, context, send buttons below textarea.
- **Message**: `flex gap-3` with `MessageAvatar` (h-8 w-8) and `MessageContent` (`rounded-lg p-2 text-foreground bg-secondary`).
- **Loader**: 3-dot animation with `scale: [1, 1.3, 1], opacity: [0.5, 1, 0.5]` staggered at 0 / 0.15 / 0.3s + "Thinking..." text.
- **ScrollButton**: Floating `h-10 w-10 rounded-full` with ChevronDown, slides in on `isAtBottom: false`.

**What we copy**: exact PromptInput border-radius (`rounded-3xl`), the `bg-secondary` message bubble, the transparent textarea with no border, the 3-dot loader, the `h-8 w-8` avatar sizing, the message `flex gap-3` layout.

### 2. Cursor IDE (forum.cursor.com · hamsterstack.com)

- **Layout**: fixed left sidebar (nav) + editor center + AI chat right panel.
- **Rail width**: resizable, default ~350–450px (drag the vertical border).
- **Collapse**: Cmd+L toggles. Collapsed state removes the panel entirely or shrinks to a button.
- **Why right**: AI is "peripheral" — present but not dominant. Users stay focused on the center canvas while the assistant is always accessible without a context switch.
- **Agentic era (2026)**: Cursor 2.3 introduced a "panel positioning system" — right panel is now the agents pane (not just chat history), reinforcing the agentic rail pattern.

**What we copy**: the "right panel = always-present, collapsible" philosophy; the resize handle on the left edge of the panel; the keyboard shortcut to toggle.

### 3. shadcn/ui Sidebar + AI Chat block (ui.shadcn.com · shadcn.io)

- Official `SidebarRail` component supports `side="right"` and `dir="rtl"` for right-rail layouts.
- `SidebarProvider` + `SidebarInset` compose into the full-width layout (left nav + center content + right rail).
- `ResizablePanelGroup` (from `@shadcn/resizable`) composes with Sidebar for drag-to-resize.
- The "AI Chat with Sidebar" block on shadcn.io uses a collapsible left sidebar for conversation history, center for the chat. For Workeros the pattern flips: app nav left, Emily right.
- Chat uses container queries (`@2xl/chat:`) to adapt layout based on available width — relevant when the rail is very narrow after resizing.

**What we copy**: the `SidebarProvider`/`SidebarRail` API for implementation; the `ResizablePanelGroup` for the resize handle; shadcn's neutral card/border/muted token system throughout.

### 4. Vercel v0 (v0.dev · v0.app)

- v0's own interface: left sidebar (history/projects) + center prompt + right preview panel.
- The preview panel is a ~40% right rail that shows rendered output as the AI generates it.
- Width behavior: right panel can expand/collapse; hover-expand variants exist in the template gallery.
- The "hover-to-expand sidebar" pattern (from `v0.app/templates/ai-chat-panel-with-hover-expand-sidebar-next-js`) is a common v0-generated pattern for AI tools.

**What we copy**: the "app content left, AI output right" split; the smooth collapse transition.

### 5. Vercel Dashboard (vercel.com/try/new-dashboard)

- Sidebar collapses to a narrow icon strip — the same "collapsed = icon strip, not hidden" UX.
- Verified: collapse to ~48px strip is the standard. You can use any tab in full screen.
- The sticky sidebar rail pattern is explicit in their redesign.

**What we copy**: the 48px collapsed strip width; icons-only mode with tooltip labels.

### 6. UX Collective: "Where should AI sit in your UI?" (uxdesign.cc)

- Catalogues: right-panel (Cursor, GitHub Copilot, Gmail Gemini, Microsoft Copilot), inline (Notion), floating (chatbots, intercom).
- The **right collapsible panel** is recommended for "deep-context expert" AI that assists users in complex primary tasks — exactly Emily's role.
- "Unlike proactive overlays, it respects user pacing." The AI is invoked at specific moments.
- Cited products: Cursor, GitHub Copilot Chat, Gmail Gemini sidebar, Linear AI, Notion AI side panel.

**What we copy**: validation that the right rail is the correct archetype for Emily's role.

---

## Key Layout Decisions Adopted

| Decision | Value | Rationale |
|---|---|---|
| Rail width (open) | 460px (~32% of 1440px canvas) | Matches Cursor/Copilot range of 350–480px; leaves 2/3 for content |
| Rail width (collapsed) | 48px icon strip | Vercel dashboard convention; not hidden, not a FAB |
| Rail position | Docked to right edge, full height | Standard for "peripheral assistant" pattern; never floating |
| Collapse behavior | Thin 48px strip showing avatar + action icons | State is preserved; Cmd+L to toggle |
| Resize | Drag handle on left edge of rail | shadcn ResizablePanelGroup / CSS resize handle |
| Message layout | prompt-kit `flex gap-3`, `h-8 w-8` avatars | Faithful to local component in `/root/openchat-v2/components/prompt-kit/message.tsx` |
| Message bubble | `rounded-lg p-2 bg-secondary` (assistant) · `bg-primary text-primary-foreground` (user) | Exact prompt-kit MessageContent classes |
| PromptInput | `rounded-3xl border p-2 shadow-xs` pill shape | Exact prompt-kit PromptInput class |
| Textarea | Transparent, no border, no ring, auto-height | Exact prompt-kit PromptInputTextarea |
| Send button | 32px round, `bg-primary`, disabled = `bg-muted` | prompt-kit PromptInputAction pattern |
| Loader | 3 dots `scale+opacity` stagger + "Thinking…" text | Exact `/root/openchat-v2/components/prompt-kit/loader.tsx` |
| Tool cards | shadcn `border border-radius-lg bg-card` — no colored borders, no gradients | Federico's design rules |
| Palette | shadcn defaults: `--secondary` for bubbles, `--muted` for cards, `--border` for dividers | No gradients, max 1 accent (Emily blue #59AAF8) |
| Emily avatar | 28px blue (#59AAF8) pill with "E" | Consistent across rail header, message rows, collapsed strip |
| Mobile | Full-screen chat, iOS-style input bar, approval cards full-width | No split layout on mobile |
---

## Local Components Referenced

- `/root/openchat-v2/components/prompt-kit/prompt-input.tsx` — PromptInput, PromptInputTextarea, PromptInputActions
- `/root/openchat-v2/components/prompt-kit/message.tsx` — Message, MessageAvatar, MessageContent, MessageActions
- `/root/openchat-v2/components/prompt-kit/chat-container.tsx` — ChatContainerRoot, ChatContainerContent, ChatContainerScrollAnchor
- `/root/openchat-v2/components/prompt-kit/loader.tsx` — Loader (3-dot animation)
- `/root/openchat-v2/components/prompt-kit/scroll-button.tsx` — ScrollButton (rounded-full ChevronDown)
- `/root/workeros/docs/design/emily-agentic-chat-2026-06-05.md` — card taxonomy (worker creation, run, approval, connect-app)

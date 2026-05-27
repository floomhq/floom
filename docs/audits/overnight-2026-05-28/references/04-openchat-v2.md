# 04 - openchat-v2 (local) — Workeros lift candidate

**Path:** `/root/openchat-v2/`
**License:** local Floom property
**Status:** matte palette + Geist already ported into Workeros S20

## Surfaces openchat-v2 has

- Chat list (sidebar, grouped by date)
- Conversation pane (message bubbles + code blocks)
- Model selector (multi-model picker)
- Settings dialog (theme, profile, preferences)
- Cmd+K history search
- Header chrome (branding, theme toggle, user menu, status indicators)
- Sidebar (collapsible offcanvas on mobile)

## Component inventory by directory

| Dir | Files of interest |
|---|---|
| `components/prompt-kit/` | `message.tsx`, `code-block.tsx`, `chat-container.tsx`, `prompt-input.tsx`, `markdown.tsx`, `file-upload.tsx`, `loader.tsx`, `prompt-suggestion.tsx`, `scroll-button.tsx` — ibelick/prompt-kit MIT, vendored |
| `components/motion-primitives/` | `text-morph.tsx`, `morphing-dialog.tsx`, `morphing-popover.tsx`, `progressive-blur.tsx` |
| `components/common/` | `button-copy.tsx`, `feedback-form.tsx`, `model-selector/`, `multi-model-selector/` |
| `components/console/` | `ready-indicator.tsx` (status dot ready/processing/error/disconnected, with variants) |
| `components/ui/` | full shadcn/ui set: button, card, input, textarea, select, tabs, badge, dialog, drawer, sidebar, command, tooltip, popover, scroll-area, sheet, checkbox, switch |
| `app/components/layout/` | `layout-app.tsx`, `header.tsx`, `theme-toggle.tsx`, `sidebar/app-sidebar.tsx` |
| `app/components/history/` | `command-history.tsx` (Cmd+K modal reference) |

## Wholesale-port targets

| Workeros surface | openchat-v2 source | Notes |
|---|---|---|
| Global sidebar | `app/components/layout/sidebar/app-sidebar.tsx` + `ui/sidebar.tsx` (SidebarProvider) | Mobile offcanvas baked in |
| Global header + theme toggle | `app/components/layout/header.tsx` + `theme-toggle.tsx` | next-themes provider |
| Cmd+K palette | `app/components/history/command-history.tsx` + `ui/command.tsx` + `ui/dialog.tsx` | Strip chat-history bindings |
| Status pill / dot | `components/console/ready-indicator.tsx` | Pulse animations, variant prop |
| Run transcript scroll | `prompt-kit/chat-container.tsx` pattern | Scrollable viewport + sticky scroll |
| /workers/new spec textarea | `prompt-kit/prompt-input.tsx` | Auto-grow textarea + actions |
| Form fields | `ui/input.tsx`, `select.tsx`, `textarea.tsx`, `tabs.tsx` | Base primitives |
| Card grids (/workers, /connections) | `ui/card.tsx` + `badge.tsx` | Composition pattern |
| Motion polish | `motion-primitives/text-morph.tsx`, `morphing-dialog.tsx` | Use sparingly on key transitions |

## Already-ported into Workeros (S20)

- Matte oklch palette (warm off-white + pure black/white borders)
- Geist + Geist_Mono via next/font/google
- Theme toggle (Light/Dark/System) — synced via `floom-theme-change` CustomEvent

## Anti-ports (skip)

- `prompt-kit/message.tsx` AI/user bubbles — not the shape of a run transcript
- `prompt-kit/prompt-input.tsx` as "chat send" — repurpose for `/workers/new` only
- `common/model-selector/` + `multi-model-selector/` — no model picker in Workeros
- chat-history pinning/favoriting — keep the Cmd+K shell, drop the bindings

## Concrete file paths

```
/root/openchat-v2/components/ui/{button,card,input,textarea,select,tabs,dialog,command,sidebar,badge,tooltip,scroll-area}.tsx
/root/openchat-v2/components/console/ready-indicator.tsx
/root/openchat-v2/components/motion-primitives/{text-morph,morphing-dialog,morphing-popover}.tsx
/root/openchat-v2/app/globals.css                    # matte palette tokens
/root/openchat-v2/app/components/layout/{layout-app,header,theme-toggle}.tsx
/root/openchat-v2/app/components/layout/sidebar/app-sidebar.tsx
/root/openchat-v2/app/components/history/command-history.tsx
/root/openchat-v2/lib/utils.ts
```

## Role in S22

**Plumbing layer**, not whole-page source. openchat-v2 supplies the chrome (sidebar, header, theme), the primitives (shadcn/ui), the motion library, and the prompt-kit vendoring. Whole pages come from skills-neo and Trigger.dev; openchat-v2 makes them feel cohesive.

# Agent Loop UI — References

Workeros runs an LLM-tool loop with transcript + artifacts. Patterns below are from systems that already solved live agent run display. Skip chat-styled refs — Workeros runs are **executions**, not conversations.

## Best ref: live in-progress run view — Vercel AI SDK `useChat` + AI Elements

Five-part render loop (`text` / `tool-call` / `tool-result` / `reasoning` / `source`) over SSE, with a 4-state machine (`ready` / `submitted` / `streaming` / `error`) driving header pill and input lock. Each tool gets a typed part (`tool-TOOLNAME`) so renderers stay type-safe across the streaming lifecycle. `step-start` parts mark loop iterations — maps to our "step N" concept.
Why: canonical agentic-stream contract today, and AI Elements ships matching shadcn/ui components (MIT, copy-into-repo registry).
<https://sdk.vercel.ai/docs/ai-sdk-ui/chatbot-with-tool-calling>, <https://github.com/vercel/ai-elements>

## Best ref: tool-call card — Vercel AI Elements `<Tool>`

Compound: `Tool` (collapsible root) → `ToolHeader` (name + state badge + animated chevron) → `ToolInput` (JSON args in `CodeBlock`) → `ToolOutput` (result/error). Auto-opens on `result` and `error`, collapsed for `input-streaming` / `input-available`. Handles approval-gated tools too.
Why: matches our "collapsible card per tool invocation with args + result" 1:1.
<https://elements.ai-sdk.dev/components/tool>, <https://deepwiki.com/vercel/ai-elements/4.3.2-tool-component>
Also lift: `<Task>` (collapsible task list + status), `<StackTrace>` (clickable frames, internal-frame dimming), `<Terminal>` (ANSI + streaming + auto-scroll) — direct fit for logs/artifacts tabs and error display.

## Best ref: status timeline — LangGraph Studio Trace Mode

Vertical timeline: every node = clickable row with input, output, token usage, latency, sub-step nesting. Production traces replay locally with mid-run edit-and-rerun. Interrupt + step-debug controls in header.
Why: timeline rows beat chat bubbles for agent loops — they encode duration, hierarchy, and tool/LLM-call distinction. Studio is closed-source but the pattern is documented and replicable.
<https://www.langchain.com/blog/langgraph-studio-the-first-agent-ide>, <https://docs.langchain.com/oss/python/langgraph/studio>

## Top 3 to lift (OSS, license OK)

1. **`vercel/ai-elements`** (MIT, shadcn registry) — `Tool`, `Task`, `Terminal`, `StackTrace`, `TestResults`. `npx ai-elements add tool task terminal` lands in repo, not as dep.
2. **`assistant-ui/assistant-ui`** (MIT) — `useToolArgsStatus` hook for per-field streaming-arg highlighting + `ToolGroup` for collapsing consecutive tool calls. Use primitives without adopting full runtime.
3. **AI SDK `useChat` part-protocol** — adopt the part-type union (`text` / `tool-call` / `tool-result` / `reasoning` / `step-start`) as wire format. No custom event schema needed.

## Files to point a port PR at

- `vercel/ai-elements`: `packages/elements/src/{tool,task,terminal,stack-trace}.tsx`
- `vercel/chatbot` ref app: `components/{message,messages}.tsx` — production switch on `part.type`
- `assistant-ui`: `packages/react/src/api/tool-ui`, `useToolArgsStatus`

## Do NOT copy

- Avatars, "User/Assistant" labels — Workeros runs have one actor
- Multi-turn bubbles — use timeline rows, not speech bubbles
- "Regenerate / edit message" — replace with "retry from step N"
- Markdown-prose on tool output — use mono `CodeBlock`
- Suggested-prompt chips, conversation-starters — irrelevant to execution view
- Sticky composer at bottom — replace with "rerun / stop / retry-from-step" action bar

Sources:
- [Vercel AI SDK: Chatbot Tool Usage](https://sdk.vercel.ai/docs/ai-sdk-ui/chatbot-with-tool-calling)
- [Vercel AI Elements](https://github.com/vercel/ai-elements)
- [AI Elements: Tool component](https://elements.ai-sdk.dev/components/tool)
- [DeepWiki: AI Elements Tool](https://deepwiki.com/vercel/ai-elements/4.3.2-tool-component)
- [assistant-ui: Tool UI guide](https://www.assistant-ui.com/docs/guides/tool-ui)
- [assistant-ui (GitHub)](https://github.com/assistant-ui/assistant-ui)
- [LangGraph Studio: first agent IDE](https://www.langchain.com/blog/langgraph-studio-the-first-agent-ide)
- [LangSmith Studio docs](https://docs.langchain.com/oss/python/langgraph/studio)

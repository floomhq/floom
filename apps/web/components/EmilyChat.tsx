"use client";

/**
 * EmilyChat — streaming chat UI for the Emily Chief-of-Staff assistant.
 *
 * Wires to the existing POST /chat SSE endpoint:
 *   data: {"type":"text","text":"..."}                 — streamed text delta
 *   data: {"type":"tool-call","toolName":"...","args":{}} — tool invocation
 *   data: {"type":"tool-result","callId":"...","result":{}} — tool result
 *   data: {"type":"finish","conversation_id":"..."}    — end-of-turn
 *
 * Components follow the project's shadcn + Tailwind v4 CSS-var patterns.
 * Markdown rendered via react-markdown (already in package.json).
 * No new npm packages needed.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ArrowUp, ChevronDown, Wrench } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type MessageRole = "user" | "assistant";

interface ToolActivity {
  toolName: string;
  callId: string;
  done: boolean;
}

interface ChatMessage {
  id: string;
  role: MessageRole;
  /** Assembled streamed text (grows as deltas arrive). */
  text: string;
  /** Tool calls observed during this turn. */
  tools: ToolActivity[];
}

// ---------------------------------------------------------------------------
// Emily avatar — solid #59AAF8 dot (matches Workeros accent blue)
// ---------------------------------------------------------------------------

function EmilyDot({ size = "size-7" }: { size?: string }) {
  return (
    <div
      aria-label="Emily avatar"
      className={cn(
        "shrink-0 rounded-full",
        size,
      )}
      style={{ backgroundColor: "#59AAF8" }}
    />
  );
}

// ---------------------------------------------------------------------------
// Individual message bubbles
// ---------------------------------------------------------------------------

function UserBubble({ text }: { text: string }) {
  return (
    <div className="flex justify-end">
      <div
        className="max-w-[80%] rounded-2xl rounded-tr-sm bg-muted px-4 py-2.5 text-sm text-foreground"
      >
        <p className="whitespace-pre-wrap break-words">{text}</p>
      </div>
    </div>
  );
}

function AssistantBubble({
  text,
  tools,
  isStreaming,
}: {
  text: string;
  tools: ToolActivity[];
  isStreaming: boolean;
}) {
  const activeTool = tools.find((t) => !t.done);

  return (
    <div className="flex items-start gap-2.5">
      <EmilyDot size="size-7" />
      <div className="min-w-0 flex-1 space-y-2">
        {/* Tool activity indicator */}
        {activeTool && (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Wrench className="size-3 shrink-0 animate-pulse" />
            <span>
              Emily is working&hellip;{" "}
              <span className="font-mono font-medium">
                {activeTool.toolName.replace(/^workers__/, "")}
              </span>
            </span>
          </div>
        )}

        {/* Message body */}
        {text ? (
          <div
            className={cn(
              "prose prose-sm dark:prose-invert max-w-none break-words",
              "prose-p:my-1.5 prose-ul:my-1.5 prose-ol:my-1.5",
              "prose-headings:font-semibold prose-headings:tracking-tight",
              "prose-code:rounded prose-code:bg-muted prose-code:px-1 prose-code:py-0.5 prose-code:font-mono prose-code:text-[0.8em]",
              "prose-pre:bg-muted prose-pre:rounded-lg prose-pre:p-3",
              "prose-a:text-[#59AAF8] prose-a:no-underline hover:prose-a:underline",
            )}
          >
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
          </div>
        ) : isStreaming && !activeTool ? (
          // Typing indicator dots when no text yet
          <div className="flex items-center gap-1 py-1">
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                className="block size-1.5 rounded-full bg-muted-foreground/50"
                style={{
                  animation: `pulse 1.2s ease-in-out ${i * 0.2}s infinite`,
                }}
              />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chat message input
// ---------------------------------------------------------------------------

function ChatInput({
  onSend,
  disabled,
}: {
  onSend: (message: string) => void;
  disabled: boolean;
}) {
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  function handleSend() {
    const trimmed = value.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setValue("");
    // Reset textarea height
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  function handleInput(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setValue(e.target.value);
    // Auto-grow
    const el = e.target;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 160) + "px";
  }

  return (
    <div className="flex items-end gap-2 rounded-2xl border border-input bg-background px-3 py-2 shadow-sm transition-shadow focus-within:shadow-md">
      <textarea
        ref={textareaRef}
        value={value}
        onChange={handleInput}
        onKeyDown={handleKeyDown}
        placeholder="Ask Emily anything&hellip;"
        disabled={disabled}
        rows={1}
        className="max-h-40 min-h-[1.5rem] flex-1 resize-none bg-transparent text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
        aria-label="Message Emily"
      />
      <Button
        size="icon-sm"
        onClick={handleSend}
        disabled={!value.trim() || disabled}
        aria-label="Send message"
        className="mb-0.5 shrink-0"
      >
        <ArrowUp className="size-3.5" />
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Scroll-to-bottom button
// ---------------------------------------------------------------------------

function ScrollToBottomButton({
  visible,
  onClick,
}: {
  visible: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      aria-label="Scroll to bottom"
      className={cn(
        "absolute bottom-4 right-4 flex size-8 items-center justify-center rounded-full border border-input bg-background shadow-md transition-all duration-200",
        visible ? "opacity-100 translate-y-0" : "pointer-events-none opacity-0 translate-y-2",
      )}
    >
      <ChevronDown className="size-4 text-muted-foreground" />
    </button>
  );
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

function EmptyState() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 py-12 text-center">
      <EmilyDot size="size-12" />
      <div>
        <p className="text-sm font-medium text-foreground">Hi, I&apos;m Emily</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Ask me anything, I run your agents and surface what needs attention.
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Error state
// ---------------------------------------------------------------------------

function ErrorBanner({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="mx-auto flex max-w-md items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-xs text-destructive">
      <span className="flex-1">{message}</span>
      <button onClick={onRetry} className="shrink-0 font-medium underline underline-offset-2">
        Retry
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main EmilyChat component
// ---------------------------------------------------------------------------

const API_BASE = process.env.NEXT_PUBLIC_API_PROXY_BASE || "/api/proxy";

function getActiveWorkspaceId(): string | null {
  if (typeof window === "undefined") return null;
  const value = window.localStorage.getItem("workeros.activeWorkspaceId");
  return value && value !== "local-default" ? value : null;
}

export function EmilyChat({ className }: { className?: string }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showScrollBtn, setShowScrollBtn] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // ---------------------------------------------------------------------------
  // Scroll management
  // ---------------------------------------------------------------------------

  const isNearBottom = useCallback(() => {
    const el = scrollAreaRef.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }, []);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    const el = scrollAreaRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior });
  }, []);

  // Auto-scroll when new content arrives (only if already near bottom)
  useLayoutEffect(() => {
    if (!streaming) return;
    if (isNearBottom()) scrollToBottom("instant");
  });

  function handleScroll() {
    setShowScrollBtn(!isNearBottom());
  }

  // ---------------------------------------------------------------------------
  // Send a message and stream the response
  // ---------------------------------------------------------------------------

  const sendMessage = useCallback(
    async (userText: string) => {
      setError(null);
      const userMsgId = crypto.randomUUID();
      const assistantMsgId = crypto.randomUUID();

      setMessages((prev) => [
        ...prev,
        { id: userMsgId, role: "user", text: userText, tools: [] },
        { id: assistantMsgId, role: "assistant", text: "", tools: [] },
      ]);
      setStreaming(true);
      // Scroll down after new messages appended
      requestAnimationFrame(() => scrollToBottom("smooth"));

      abortRef.current?.abort();
      const abort = new AbortController();
      abortRef.current = abort;

      try {
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        };
        const wsId = getActiveWorkspaceId();
        if (wsId) headers["x-workeros-workspace"] = wsId;

        const res = await fetch(`${API_BASE}/chat`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            message: userText,
            conversation_id: conversationId,
            source: "web",
          }),
          signal: abort.signal,
        });

        if (!res.ok) {
          let errMsg = `HTTP ${res.status}`;
          try {
            const body = await res.json() as { detail?: string };
            if (body.detail) errMsg = body.detail;
          } catch { /* ignore */ }
          throw new Error(errMsg);
        }

        if (!res.body) throw new Error("No response body");

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";

        function patch(updater: (msg: ChatMessage) => ChatMessage) {
          setMessages((prev) =>
            prev.map((m) => (m.id === assistantMsgId ? updater(m) : m)),
          );
        }

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });

          const lines = buf.split("\n");
          buf = lines.pop() ?? "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const raw = line.slice(6).trim();
            if (!raw || raw === "[DONE]") continue;

            let part: Record<string, unknown>;
            try {
              part = JSON.parse(raw) as Record<string, unknown>;
            } catch {
              continue;
            }

            const type = part.type as string;

            if (type === "text") {
              patch((m) => ({ ...m, text: m.text + (part.text as string) }));
              // Scroll down as text streams in
              requestAnimationFrame(() => {
                if (isNearBottom()) scrollToBottom("instant");
              });
            } else if (type === "tool-call") {
              patch((m) => ({
                ...m,
                tools: [
                  ...m.tools,
                  {
                    toolName: (part.toolName as string) || "tool",
                    callId: (part.callId as string) || crypto.randomUUID(),
                    done: false,
                  },
                ],
              }));
            } else if (type === "tool-result") {
              const callId = part.callId as string;
              patch((m) => ({
                ...m,
                tools: m.tools.map((t) =>
                  t.callId === callId ? { ...t, done: true } : t,
                ),
              }));
            } else if (type === "finish") {
              if (part.conversation_id) {
                setConversationId(part.conversation_id as string);
              }
            } else if (type === "error") {
              throw new Error((part.error as string) || "Stream error");
            }
          }
        }
      } catch (err: unknown) {
        if ((err as { name?: string }).name === "AbortError") return;
        const msg = err instanceof Error ? err.message : "Something went wrong";
        setError(msg);
        // Remove the empty assistant placeholder on error
        setMessages((prev) => prev.filter((m) => m.id !== assistantMsgId));
      } finally {
        setStreaming(false);
        // Ensure final scroll
        requestAnimationFrame(() => scrollToBottom("smooth"));
      }
    },
    [conversationId, isNearBottom, scrollToBottom],
  );

  // Cleanup on unmount
  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  return (
    <div
      ref={containerRef}
      className={cn("flex flex-col", className)}
      style={{ height: "calc(100vh - 14rem)", minHeight: "400px" }}
    >
      {/* Message thread */}
      <div
        ref={scrollAreaRef}
        onScroll={handleScroll}
        className="relative flex-1 overflow-y-auto px-1 py-4"
      >
        {messages.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="mx-auto max-w-2xl space-y-6 px-2">
            {messages.map((msg) =>
              msg.role === "user" ? (
                <UserBubble key={msg.id} text={msg.text} />
              ) : (
                <AssistantBubble
                  key={msg.id}
                  text={msg.text}
                  tools={msg.tools}
                  isStreaming={streaming && msg.id === messages[messages.length - 1]?.id}
                />
              ),
            )}
          </div>
        )}

        <ScrollToBottomButton
          visible={showScrollBtn}
          onClick={() => scrollToBottom("smooth")}
        />
      </div>

      {/* Error banner */}
      {error ? (
        <div className="px-2 pb-2">
          <ErrorBanner
            message={error}
            onRetry={() => {
              const lastUser = [...messages].reverse().find((m) => m.role === "user");
              setError(null);
              if (lastUser) void sendMessage(lastUser.text);
            }}
          />
        </div>
      ) : null}

      {/* Input area */}
      <div className="mx-auto w-full max-w-2xl px-2 pb-2">
        <ChatInput onSend={sendMessage} disabled={streaming} />
        <p className="mt-1.5 text-center text-[10px] text-muted-foreground">
          Enter to send, Shift+Enter for newline
        </p>
      </div>
    </div>
  );
}

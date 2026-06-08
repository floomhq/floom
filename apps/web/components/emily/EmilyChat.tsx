"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronRight, ChevronLeft, ChevronDown, Maximize2, PenSquare, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import Link from "next/link";

import { EmilyAvatar } from "./EmilyAvatar";
import { MarkdownText } from "./MarkdownText";
import { PromptInput } from "./PromptInput";
import { FileChip } from "./FileChip";
import { ToolCardRenderer } from "./cards/ToolCardRenderer";
import { useChatStream } from "@/lib/useChatStream";
import { exportConversationMarkdown } from "@/lib/emily-chat-export";
import type { AttachedFile, ChatMessage } from "@/lib/emily-chat-types";

// ── Chat controls (New chat + Export) ─────────────────────────────────────────

function ChatControls({
  onNew,
  onExport,
  canExport,
}: {
  onNew: () => void;
  onExport: () => void;
  canExport: boolean;
}) {
  return (
    <div className="flex items-center gap-1">
      <Button
        size="sm"
        variant="ghost"
        className="h-7 gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground"
        onClick={onNew}
        title="Start a new conversation"
        aria-label="New chat"
      >
        <PenSquare className="size-3.5" />
        <span className="hidden sm:inline">New chat</span>
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="h-7 gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground"
        onClick={onExport}
        disabled={!canExport}
        title="Export this conversation as Markdown"
        aria-label="Export conversation"
      >
        <Download className="size-3.5" />
        <span className="hidden sm:inline">Export</span>
      </Button>
    </div>
  );
}

// ── Suggestion pills ──────────────────────────────────────────────────────────

const SUGGESTIONS = [
  "What workers do I have?",
  "Create a Stripe alert worker",
  "Show me yesterday's runs",
];

// ── Typing indicator ──────────────────────────────────────────────────────────

function TypingIndicator() {
  return (
    <div className="flex items-start gap-2.5">
      <EmilyAvatar size="sm" />
      <div className="flex gap-1 py-2 px-1">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="size-1.5 rounded-full bg-muted-foreground/40 animate-bounce"
            style={{ animationDelay: `${i * 150}ms` }}
          />
        ))}
      </div>
    </div>
  );
}

// ── Message renderer ──────────────────────────────────────────────────────────

function MessageRow({ msg }: { msg: ChatMessage }) {
  if (msg.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] space-y-1.5">
          {msg.text && (
            <div className="rounded-2xl rounded-tr-sm bg-muted/60 px-3.5 py-2.5 text-sm text-foreground">
              <p className="whitespace-pre-wrap leading-relaxed">{msg.text}</p>
            </div>
          )}
          {msg.files && msg.files.length > 0 && (
            <div className="flex flex-wrap gap-1.5 justify-end">
              {msg.files.map((f) => (
                <FileChip key={f.id} file={f} />
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  // assistant
  return (
    <div className="flex items-start gap-2.5">
      <EmilyAvatar size="sm" />
      <div className="flex-1 min-w-0 space-y-2.5">
        {msg.parts?.map((part, i) => {
          if (part.type === "text") {
            return <MarkdownText key={i} text={part.text} />;
          }
          if (part.type === "tool-card") {
            return <ToolCardRenderer key={i} card={part.card} />;
          }
          return null;
        })}
      </div>
    </div>
  );
}

// ── Empty state ───────────────────────────────────────────────────────────────

function EmptyState({ onSuggest }: { onSuggest: (text: string) => void }) {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-4 px-6 text-center">
      <EmilyAvatar size="md" />
      <div>
        <p className="text-sm font-medium">I am Emily, your Chief of Staff</p>
        <p className="text-xs text-muted-foreground mt-1">
          Ask me to create workers, check runs, or manage connections.
        </p>
      </div>
      <div className="flex flex-wrap gap-1.5 justify-center">
        {SUGGESTIONS.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => onSuggest(s)}
            className="rounded-full border border-border bg-muted/40 px-3 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

// ── EmilyChat core (shared by dock and full-page) ────────────────────────────

interface EmilyChatCoreProps {
  fullPage?: boolean;
}

function EmilyChatCore({ fullPage = false }: EmilyChatCoreProps) {
  const { messages, conversationId, isStreaming, isHydrating, sendMessage, newSession } =
    useChatStream();
  const [input, setInput] = useState("");
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  // Start true so the first message load scrolls to bottom automatically.
  const isNearBottomRef = useRef(true);
  const [showScrollButton, setShowScrollButton] = useState(false);

  // Track whether the user is near the bottom of the scroll container.
  // We use a ref (not state) so the scroll handler doesn't trigger re-renders.
  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    isNearBottomRef.current = nearBottom;
    setShowScrollButton(!nearBottom);
  }, []);

  // Scroll the container to the very bottom. Uses direct scrollTop manipulation
  // (not scrollIntoView) so it is instant and synchronous — no smooth animation
  // that would fight the user's own scroll gesture during streaming.
  const scrollToBottom = useCallback((smooth = false) => {
    const el = scrollContainerRef.current;
    if (!el) return;
    if (smooth) {
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    } else {
      el.scrollTop = el.scrollHeight;
    }
    isNearBottomRef.current = true;
    setShowScrollButton(false);
  }, []);

  // Auto-scroll when streaming — ONLY if the user is already near the bottom.
  // If they've scrolled up to read history, stop and show the jump button.
  // Uses instant scroll (no smooth animation) so it never fights user input.
  useEffect(() => {
    if (isNearBottomRef.current) {
      const el = scrollContainerRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    }
  }, [messages, isStreaming]);

  // Always jump to bottom when the USER sends a new message so Emily's reply
  // is immediately visible — regardless of current scroll position.
  const prevLengthRef = useRef(messages.length);
  useEffect(() => {
    const grew = messages.length > prevLengthRef.current;
    prevLengthRef.current = messages.length;
    if (grew && messages[messages.length - 1]?.role === "user") {
      scrollToBottom();
    }
  }, [messages, scrollToBottom]);

  const handleSubmit = useCallback(() => {
    const text = input.trim();
    if (!text && attachedFiles.length === 0) return;
    sendMessage(text, attachedFiles.length > 0 ? attachedFiles : undefined);
    setInput("");
    setAttachedFiles([]);
  }, [input, attachedFiles, sendMessage]);

  const handleExport = useCallback(() => {
    exportConversationMarkdown(messages, conversationId);
  }, [messages, conversationId]);

  const hasMessages = messages.length > 0;

  return (
    <div className={cn("flex flex-col h-full", fullPage && "max-w-2xl mx-auto w-full")}>
      {/* Controls: New chat + Export — reachable in both dock and full-page */}
      <div
        className={cn(
          "flex shrink-0 items-center justify-end gap-1 border-b border-border/60",
          fullPage ? "px-6 py-2" : "px-3 py-1.5"
        )}
      >
        <ChatControls
          onNew={() => {
            newSession();
            // Reset scroll state for the fresh conversation
            isNearBottomRef.current = true;
            setShowScrollButton(false);
          }}
          onExport={handleExport}
          canExport={hasMessages}
        />
      </div>

      {/* Message list */}
      <div
        ref={scrollContainerRef}
        className="relative flex-1 overflow-y-auto"
        onScroll={handleScroll}
      >
        {!hasMessages ? (
          isHydrating ? (
            <div className="flex h-full items-center justify-center px-6 text-center">
              <p className="text-xs text-muted-foreground">Loading conversation...</p>
            </div>
          ) : (
            <EmptyState onSuggest={(text) => { setInput(text); }} />
          )
        ) : (
          <div className={cn("py-5 space-y-5", fullPage ? "px-6" : "px-4")}>
            {messages.map((msg) => (
              <MessageRow key={msg.id} msg={msg} />
            ))}
            {isStreaming && <TypingIndicator />}
            <div ref={bottomRef} />
          </div>
        )}

        {/* Scroll-to-bottom button — visible when user has scrolled up and
            Emily is still typing. Matches ChatGPT / Claude UX. */}
        {showScrollButton && (
          <button
            type="button"
            onClick={() => scrollToBottom(true)}
            aria-label="Scroll to bottom"
            className="sticky bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-1.5 rounded-full border border-border bg-background px-3 py-1.5 text-xs text-muted-foreground shadow-md hover:text-foreground hover:shadow-lg transition-all"
          >
            <ChevronDown className="size-3.5" />
            Scroll to bottom
          </button>
        )}
      </div>

      {/* Input */}
      <div className={cn("shrink-0", fullPage ? "px-6 pb-6 pt-3" : "px-3 pb-3 pt-0")}>
        <Separator className="mb-3" />
        <PromptInput
          value={input}
          onChange={setInput}
          onSubmit={handleSubmit}
          onFilesChange={setAttachedFiles}
          attachedFiles={attachedFiles}
          disabled={isStreaming}
          placeholder="Message Emily..."
        />
        <p className="mt-1.5 text-center text-[10px] text-muted-foreground">
          Emily can make mistakes. Verify important results.
        </p>
      </div>
    </div>
  );
}

// ── Dock component (right-side persistent rail) ───────────────────────────────

export function EmilyDock({ className }: { className?: string }) {
  const [open, setOpen] = useState(true);

  return (
    <div
      className={cn(
        "flex h-full flex-col border-l border-border bg-background shrink-0",
        // Width collapses to 48px strip when closed; full rail when open
        open ? "w-full md:w-[380px] md:max-w-[30vw]" : "w-12",
        className
      )}
      aria-label={open ? "Emily dock" : "Emily dock (collapsed)"}
    >
      {/* Collapsed strip — shown only when closed */}
      {!open && (
        <div className="flex flex-col items-center justify-start pt-4 gap-3">
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="flex flex-col items-center gap-1.5 group"
            title="Open Emily"
            aria-label="Open Emily"
          >
            <EmilyAvatar size="sm" />
            <ChevronLeft className="size-3.5 text-muted-foreground group-hover:text-foreground transition-colors" />
          </button>
        </div>
      )}

      {/* Full header — shown only when open */}
      {open && (
        <div className="flex h-12 shrink-0 items-center gap-2.5 border-b border-border px-4">
          <EmilyAvatar size="sm" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold leading-none truncate">Emily</p>
            <p className="text-[11px] text-muted-foreground leading-none mt-0.5">Chief of Staff</p>
          </div>
          <Badge
            variant="secondary"
            className="text-[10px] px-1.5 py-0.5 bg-green-500/10 text-green-600 border-green-500/20 shrink-0 font-normal"
          >
            Online
          </Badge>
          <Link
            href="/chat"
            title="Full-page chat"
            aria-label="Open full-page Emily chat"
            className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          >
            <Maximize2 className="size-3.5" />
          </Link>
          <Button
            size="sm"
            variant="ghost"
            className="size-7 p-0"
            onClick={() => setOpen(false)}
            title="Collapse Emily"
            aria-label="Collapse Emily"
          >
            <ChevronRight className="size-4" />
          </Button>
        </div>
      )}

      {/* Chat content — ALWAYS mounted so useChatStream state survives collapse */}
      <div className={cn("flex-1 min-h-0 overflow-hidden", !open && "hidden")}>
        <EmilyChatCore />
      </div>
    </div>
  );
}

// ── Full-page chat (used by /chat route) ──────────────────────────────────────

export function EmilyChatPage() {
  return (
    <div className="flex h-[calc(100vh-4rem)] flex-col">
      <div className="flex items-center gap-3 border-b border-border px-6 py-4">
        <EmilyAvatar size="md" />
        <div>
          <p className="text-base font-semibold leading-none">Emily</p>
          <p className="text-xs text-muted-foreground mt-0.5">Chief of Staff</p>
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-hidden">
        <EmilyChatCore fullPage />
      </div>
    </div>
  );
}

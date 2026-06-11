"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, ChevronRight, ChevronLeft, ChevronDown, Maximize2, Minimize2, PenSquare, Download, History, MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useRouter } from "next/navigation";

import { EmilyAvatar } from "./EmilyAvatar";
import { MarkdownText } from "./MarkdownText";
import { PromptInput } from "./PromptInput";
import { FileChip } from "./FileChip";
import { ToolCardRenderer } from "./cards/ToolCardRenderer";
import {
  getAutoOpenRunDetailsHref,
  shouldAutoOpenRunDetails,
  useChatStream,
} from "@/lib/useChatStream";
import { exportConversationMarkdown } from "@/lib/emily-chat-export";
import { api } from "@/lib/api";
import type { ConversationSummary } from "@/lib/types";
import type { AttachedFile, ChatMessage } from "@/lib/emily-chat-types";

// ── Chat controls (New chat + Export) ─────────────────────────────────────────

// Recent chats — browse + reopen past Emily conversations (SPEC §12). Backed by
// GET /conversations (BACKEND-MAP: WORKS).
function RecentChats({
  activeConversationId,
  onLoadConversation,
}: {
  activeConversationId: string | null;
  onLoadConversation: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<ConversationSummary[] | null>(null);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    api.conversations
      .list(20)
      .then((rows) => alive && setItems(rows))
      .catch(() => alive && setItems([]));
    return () => {
      alive = false;
    };
  }, [open]);

  return (
    <div className="relative">
      <Button
        size="sm"
        variant="ghost"
        className="h-7 gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground"
        onClick={() => setOpen((v) => !v)}
        title="Recent chats"
        aria-label="Recent chats"
        aria-expanded={open}
      >
        <History className="size-3.5" />
        <span className="hidden sm:inline">Recent</span>
      </Button>
      {open && (
        <div
          role="menu"
          onMouseLeave={() => setOpen(false)}
          className="absolute right-0 top-full z-30 mt-1 max-h-72 w-64 overflow-auto rounded-[12px] border border-border bg-[var(--bg-card)] p-1 shadow-[var(--shadow-pop)]"
        >
          {items === null && <div className="px-2 py-3 text-xs text-muted-foreground">Loading…</div>}
          {items?.length === 0 && (
            <div className="px-2 py-3 text-xs text-muted-foreground">No past chats yet.</div>
          )}
          {items?.map((c) => (
            <button
              key={c.id}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onLoadConversation(c.id);
              }}
              className={cn(
                "flex w-full items-center gap-2 rounded-[8px] px-2 py-1.5 text-left text-xs hover:bg-[var(--bg-2)]",
                c.id === activeConversationId && "bg-[var(--bg-2)]"
              )}
            >
              <span className="flex-1 truncate text-[var(--ink-soft)]">
                {c.title?.trim() || "Untitled chat"}
              </span>
              {c.message_count != null && (
                <span className="shrink-0 text-[10.5px] text-muted-foreground">{c.message_count}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ChatControls({
  onNew,
  onExport,
  canExport,
  activeConversationId,
  onLoadConversation,
}: {
  onNew: () => void;
  onExport: () => void;
  canExport: boolean;
  activeConversationId: string | null;
  onLoadConversation: (id: string) => void;
}) {
  return (
    <div className="flex items-center gap-1">
      <RecentChats
        activeConversationId={activeConversationId}
        onLoadConversation={onLoadConversation}
      />
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
      {/* min-w-0 + overflow-hidden prevent long URLs and code from blowing out the rail */}
      <div className="flex-1 min-w-0 overflow-hidden space-y-2.5">
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

interface ChatCoreActions {
  newSession: () => void;
  exportChat: () => void;
  loadConversation: (id: string) => void;
  conversationId: string | null;
  // hasMessages is tracked via state in the host to avoid reading ref during render
}

interface EmilyChatCoreProps {
  fullPage?: boolean;
  onOpenRunDetails?: () => void;
  /** When provided, the core omits its own controls row (host renders them in the header). */
  hideControls?: boolean;
  /** Mutable ref that receives action callbacks so the host header can drive them. */
  actionsRef?: React.MutableRefObject<ChatCoreActions | null>;
  /** Called whenever hasMessages changes so host can update disabled state without reading a ref in render. */
  onHasMessagesChange?: (has: boolean) => void;
  /** Called whenever conversationId changes so host can highlight active chat without reading a ref in render. */
  onConversationIdChange?: (id: string | null) => void;
}

const WORKER_MUTATION_TOOLS = new Set(["workers__create", "workers__update", "workers__delete"]);

function EmilyChatCore({ fullPage = false, onOpenRunDetails, hideControls = false, actionsRef, onHasMessagesChange, onConversationIdChange }: EmilyChatCoreProps) {
  const {
    messages,
    conversationId,
    isStreaming,
    isHydrating,
    error,
    sendMessage,
    newSession,
    loadConversation,
  } = useChatStream();
  const router = useRouter();
  const [input, setInput] = useState("");
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  // Start true so the first message load scrolls to bottom automatically.
  const isNearBottomRef = useRef(true);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const openedRunDetailsRef = useRef(new Set<string>());
  const runDetailsNavReadyRef = useRef(false);

  // Track whether the user is near the bottom of the scroll container.
  // We use a ref (not state) so the scroll handler doesn't trigger re-renders.
  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    // Tight threshold: even a small scroll up (> 20px from bottom) disengages
    // auto-scroll immediately. A large threshold like 120px caused fighting
    // because small scrolls still read as "near bottom" and got overridden.
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 20;
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
      runDetailsNavReadyRef.current = true;
      scrollToBottom();
    }
  }, [messages, scrollToBottom]);

  // Refresh the workers page whenever Emily completes a create/update/delete
  // so the user sees the new worker immediately without a manual refresh.
  const seenCardIds = useRef(new Set<string>());
  useEffect(() => {
    for (const msg of messages) {
      if (msg.role !== "assistant" || !msg.parts) continue;
      for (const part of msg.parts) {
        if (part.type !== "tool-card") continue;
        const card = part.card;
        const cardId = card.card_id;
        if (seenCardIds.current.has(cardId)) continue;
        if (
          "toolName" in card &&
          typeof card.toolName === "string" &&
          WORKER_MUTATION_TOOLS.has(card.toolName) &&
          (card.status === "completed" || card.status === "failed")
        ) {
          seenCardIds.current.add(cardId);
          router.refresh();
        }
      }
    }
  }, [messages, router]);

  useEffect(() => {
    if (!runDetailsNavReadyRef.current || isHydrating) return;
    if (fullPage) return;
    for (const msg of messages) {
      if (msg.role !== "assistant" || !msg.parts) continue;
      for (const part of msg.parts) {
        if (part.type !== "tool-card") continue;
        const card = part.card;
        if (!shouldAutoOpenRunDetails(card)) continue;
        const href = getAutoOpenRunDetailsHref(card);
        if (!href) continue;
        const runId = card.runId;
        if (!runId) continue;
        if (openedRunDetailsRef.current.has(runId)) continue;
        openedRunDetailsRef.current.add(runId);
        onOpenRunDetails?.();
        router.push(href);
        return;
      }
    }
  }, [messages, router, fullPage, isHydrating, onOpenRunDetails]);

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

  const handleNew = useCallback(() => {
    newSession();
    isNearBottomRef.current = true;
    setShowScrollButton(false);
    openedRunDetailsRef.current.clear();
    runDetailsNavReadyRef.current = false;
  }, [newSession]);

  const hasMessages = messages.length > 0;

  // Expose actions to host (e.g. dock header) via ref
  useEffect(() => {
    if (actionsRef) {
      actionsRef.current = {
        newSession: handleNew,
        exportChat: handleExport,
        loadConversation: (id: string) => {
          loadConversation(id);
          isNearBottomRef.current = true;
          setShowScrollButton(false);
        },
        conversationId,
      };
    }
  });

  // Propagate hasMessages to host so it can update disabled state in render
  useEffect(() => {
    onHasMessagesChange?.(hasMessages);
  }, [hasMessages, onHasMessagesChange]);

  // Propagate conversationId to host so it can highlight active chat in render
  useEffect(() => {
    onConversationIdChange?.(conversationId);
  }, [conversationId, onConversationIdChange]);
  const errorAlreadyVisible = Boolean(
    error &&
      messages.some((message) =>
        message.role === "assistant" &&
        message.parts?.some((part) => part.type === "text" && part.text === error)
      )
  );

  return (
    <div className={cn("flex flex-col h-full", fullPage && "max-w-2xl mx-auto w-full")}>
      {/* Controls: New chat + Export — shown on full-page; dock header renders them when hideControls */}
      {!hideControls && (
        <div
          className={cn(
            "flex shrink-0 items-center justify-end gap-1 border-b border-border/60",
            fullPage ? "px-6 py-2" : "px-3 py-1.5"
          )}
        >
          <ChatControls
            onNew={handleNew}
            onExport={handleExport}
            canExport={hasMessages}
            activeConversationId={conversationId}
            onLoadConversation={(id) => {
              loadConversation(id);
              isNearBottomRef.current = true;
              setShowScrollButton(false);
            }}
          />
        </div>
      )}

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
            {error && !errorAlreadyVisible && (
              /* Quiet inline system note — muted, no alarming red. SPEC §9: "calm, not alarmed". */
              <div className="flex items-start gap-2 rounded-lg bg-[var(--bg-2)] px-3 py-2.5 text-xs text-[var(--ink-soft)]">
                <AlertTriangle className="mt-0.5 size-3 shrink-0 opacity-60" />
                <p className="leading-relaxed break-words min-w-0">{error}</p>
              </div>
            )}
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

      {/* Input — error intentionally NOT repeated here; it already shows as an
          inline system note in the message thread (errorAlreadyVisible guard above). */}
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

// Emily dock width progression (SPEC §12): collapsed ↔ rail ↔ wide ↔ full-screen
// overlay, via the expand control + collapse button.
type DockMode = "collapsed" | "rail" | "wide" | "full";

// Widths per APP-UI-V4-SPEC §2: rail 330px (collapse 46px), widen 560px, full.
const DOCK_WIDTH: Record<DockMode, string> = {
  collapsed: "w-[46px]",
  rail: "w-full md:w-[330px] md:max-w-[30vw]",
  wide: "w-full md:w-[560px] md:max-w-[52vw]",
  full: "fixed inset-0 z-50 w-full", // full-screen overlay
};

export function EmilyDock({ className }: { className?: string }) {
  const [mode, setMode] = useState<DockMode>("rail");
  const open = mode !== "collapsed";
  const cycleExpand = () =>
    setMode((m) => (m === "rail" ? "wide" : m === "wide" ? "full" : "rail"));
  const collapseForRunDetails = useCallback(() => setMode("collapsed"), []);
  // actionsRef lets the dock header drive new/export/recent without prop-drilling
  const coreActionsRef = useRef<ChatCoreActions | null>(null);
  // hasMessages as state so the Export menu item disables correctly (can't read ref in render)
  const [coreHasMessages, setCoreHasMessages] = useState(false);
  // Active conversation ID as state for recent-chats active highlight (can't read ref in render)
  const [coreConversationId, setCoreConversationId] = useState<string | null>(null);
  // Local state for recent chats popover in the header ⋯ menu
  const [recentItems, setRecentItems] = useState<import("@/lib/types").ConversationSummary[] | null>(null);

  return (
    <div
      className={cn(
        "flex h-full flex-col bg-background shrink-0 overflow-hidden",
        mode !== "full" && "border-l border-border",
        DOCK_WIDTH[mode],
        className
      )}
      aria-label={open ? `Emily dock (${mode})` : "Emily dock (collapsed)"}
    >
      {/* Collapsed strip — shown only when collapsed */}
      {!open && (
        <div className="flex flex-col items-center justify-start pt-4 gap-3">
          <button
            type="button"
            onClick={() => setMode("rail")}
            className="flex flex-col items-center gap-1.5 group"
            title="Open Emily"
            aria-label="Open Emily"
          >
            <EmilyAvatar size="sm" />
            <ChevronLeft className="size-3.5 text-muted-foreground group-hover:text-foreground transition-colors" />
          </button>
        </div>
      )}

      {/* V4 SPEC §Emily rail: 56px header — avatar + Emily + green dot + fullscreen + ⋯ menu */}
      {open && (
        <div className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-3">
          <EmilyAvatar size="sm" />
          <div className="flex-1 min-w-0 flex items-center gap-1.5">
            <p className="text-sm font-semibold leading-none truncate">Emily</p>
            {/* Green presence dot */}
            <span
              className="size-2 shrink-0 rounded-full bg-green-500"
              aria-label="Online"
            />
          </div>
          {/* Fullscreen toggle */}
          <Button
            size="sm"
            variant="ghost"
            className="size-7 p-0 text-muted-foreground hover:text-foreground"
            onClick={cycleExpand}
            title={mode === "full" ? "Shrink Emily" : "Expand Emily"}
            aria-label={mode === "full" ? "Shrink Emily" : "Expand Emily"}
          >
            {mode === "full" ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
          </Button>
          {/* ⋯ menu: New chat / Export / Recent chats */}
          <DropdownMenu onOpenChange={(open) => {
            if (open) {
              api.conversations.list(20)
                .then((rows) => setRecentItems(rows))
                .catch(() => setRecentItems([]));
            }
          }}>
            <DropdownMenuTrigger
              className="inline-flex size-7 items-center justify-center rounded-[var(--radius-button)] text-muted-foreground hover:bg-[var(--active-nav-bg)] hover:text-foreground transition-colors"
              title="More"
              aria-label="More options"
            >
              <MoreHorizontal className="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" side="bottom" sideOffset={6} className="w-44 p-1">
              <DropdownMenuItem
                onClick={() => coreActionsRef.current?.newSession()}
                className="flex items-center gap-2 text-[var(--ink-soft)] focus:bg-[var(--active-nav-bg)] focus:text-ink"
              >
                <PenSquare className="size-4" />
                New chat
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => coreActionsRef.current?.exportChat()}
                disabled={!coreHasMessages}
                className="flex items-center gap-2 text-[var(--ink-soft)] focus:bg-[var(--active-nav-bg)] focus:text-ink"
              >
                <Download className="size-4" />
                Export
              </DropdownMenuItem>
              {recentItems && recentItems.length > 0 && (
                <>
                  <DropdownMenuSeparator className="-mx-1 my-1" />
                  <div className="px-2 pt-1 pb-0.5 text-[10px] font-medium uppercase tracking-wider text-[var(--ink-mute)]">
                    Recent chats
                  </div>
                  {recentItems.slice(0, 8).map((c) => (
                    <DropdownMenuItem
                      key={c.id}
                      onClick={() => coreActionsRef.current?.loadConversation(c.id)}
                      className={cn(
                        "flex items-center gap-2 text-[var(--ink-soft)] focus:bg-[var(--active-nav-bg)] focus:text-ink",
                        c.id === coreConversationId && "bg-[var(--active-nav-bg)]"
                      )}
                    >
                      <History className="size-3.5 shrink-0 opacity-60" />
                      <span className="flex-1 truncate text-xs">{c.title?.trim() || "Untitled chat"}</span>
                      {c.message_count != null && (
                        <span className="shrink-0 text-[10px] text-muted-foreground">{c.message_count}</span>
                      )}
                    </DropdownMenuItem>
                  ))}
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
          {/* Collapse button */}
          <Button
            size="sm"
            variant="ghost"
            className="size-7 p-0 text-muted-foreground hover:text-foreground"
            onClick={() => setMode("collapsed")}
            title="Collapse Emily"
            aria-label="Collapse Emily"
          >
            <ChevronRight className="size-4" />
          </Button>
        </div>
      )}

      {/* Chat content — ALWAYS mounted so useChatStream state survives collapse */}
      <div className={cn("flex-1 min-h-0 overflow-hidden", !open && "hidden")}>
        <EmilyChatCore
          onOpenRunDetails={collapseForRunDetails}
          hideControls
          actionsRef={coreActionsRef}
          onHasMessagesChange={setCoreHasMessages}
          onConversationIdChange={setCoreConversationId}
        />
      </div>
    </div>
  );
}

// ── Mobile bottom-sheet (SPEC §8c: Emily becomes a bottom sheet on mobile) ────

export function EmilyMobileSheet() {
  const [open, setOpen] = useState(false);
  return (
    <>
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Open Emily"
          className="fixed bottom-4 right-4 z-40 flex size-12 items-center justify-center rounded-full bg-background shadow-lg border border-border"
        >
          <EmilyAvatar size="sm" />
        </button>
      )}
      {open && (
        <div className="fixed inset-0 z-50 flex flex-col justify-end" role="dialog" aria-label="Emily">
          <button
            type="button"
            aria-label="Close Emily"
            className="absolute inset-0 bg-black/40"
            onClick={() => setOpen(false)}
          />
          <div className="relative flex h-[85vh] flex-col rounded-t-2xl border-t border-border bg-background">
            <div className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-3">
              <EmilyAvatar size="sm" />
              <div className="flex-1 min-w-0 flex items-center gap-1.5">
                <p className="text-sm font-semibold leading-none truncate">Emily</p>
                <span className="size-2 shrink-0 rounded-full bg-green-500" aria-label="Online" />
              </div>
              <Button
                size="sm"
                variant="ghost"
                className="size-7 p-0"
                onClick={() => setOpen(false)}
                title="Close Emily"
                aria-label="Close Emily"
              >
                <ChevronDown className="size-4" />
              </Button>
            </div>
            {/* Mounted only while open → no second background chat instance */}
            <div className="flex-1 min-h-0 overflow-hidden">
              <EmilyChatCore />
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ── Full-page chat (used by /chat route) ──────────────────────────────────────

export function EmilyChatPage() {
  return (
    <div className="flex h-[calc(100vh-4rem)] flex-col">
      <div className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-4">
        <EmilyAvatar size="sm" />
        <div className="flex-1 min-w-0 flex items-center gap-1.5">
          <p className="text-sm font-semibold leading-none">Emily</p>
          <span className="size-2 shrink-0 rounded-full bg-green-500" aria-label="Online" />
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-hidden">
        <EmilyChatCore fullPage />
      </div>
    </div>
  );
}

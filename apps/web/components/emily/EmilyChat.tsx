"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { AlertTriangle, Check, ChevronRight, ChevronLeft, ChevronDown, Copy, Maximize2, Minimize2, PenSquare, Download, History, MoreHorizontal, X } from "lucide-react";
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

import { useEmilyFullscreen } from "./emily-fullscreen";
import { EmilyAvatar } from "./EmilyAvatar";
import { MarkdownText } from "./MarkdownText";
import { PromptInput } from "./PromptInput";
import { CreateSourcePills } from "@/components/CreateSourcePills";
import { FileChip } from "./FileChip";
import { ToolCardRenderer } from "./cards/ToolCardRenderer";
import {
  Message,
  MessageAction,
  MessageActions,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message";
import {
  getAutoOpenRunDetailsHref,
  shouldAutoOpenRunDetails,
  useChatStream,
} from "@/lib/useChatStream";
import { exportConversationMarkdown } from "@/lib/emily-chat-export";
import { readStoredConversationId } from "@/lib/emily-chat-storage";
import { buildCreateWorkerMessage } from "@/lib/emily-create-intent";
// Re-export so the create-mode wiring + its tests share one source of truth.
export { buildCreateWorkerMessage } from "@/lib/emily-create-intent";
import { useAssistantName } from "@/lib/workspace/assistant-name";
import { api } from "@/lib/api";
import { reportError, logError } from "@/lib/notify";
import type { ConversationSummary } from "@/lib/types";
import type { AttachedFile, ChatMessage } from "@/lib/emily-chat-types";

// ── Chat controls (New chat + Export) ─────────────────────────────────────────

// Recent chats — browse + reopen past Emily conversations (SPEC §12). Backed by
// GET /conversations (BACKEND-MAP: WORKS).
function RecentChats({
  activeConversationId,
  onLoadConversation,
  openSignal,
}: {
  activeConversationId: string | null;
  onLoadConversation: (id: string) => void;
  /** Increment to programmatically open the popover (e.g. the create-mode
   *  "find it in Recent chats" link). */
  openSignal?: number;
}) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<ConversationSummary[] | null>(null);

  // Open when the host bumps openSignal (skip the initial mount value of 0).
  useEffect(() => {
    if (openSignal) setOpen(true);
  }, [openSignal]);

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
          className="absolute right-0 top-full z-30 mt-1 max-h-72 w-64 overflow-auto rounded-[var(--radius-card)] [border:var(--bd-card)] bg-[var(--bg-card)] p-1 shadow-[var(--shadow-pop)]"
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
                "flex w-full items-center gap-2 rounded-[var(--radius-button)] px-2 py-1.5 text-left text-xs hover:bg-[var(--bg-2)]",
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
  recentOpenSignal,
}: {
  onNew: () => void;
  onExport: () => void;
  canExport: boolean;
  activeConversationId: string | null;
  onLoadConversation: (id: string) => void;
  recentOpenSignal?: number;
}) {
  return (
    <div className="flex items-center gap-1">
      <RecentChats
        activeConversationId={activeConversationId}
        onLoadConversation={onLoadConversation}
        openSignal={recentOpenSignal}
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

// #1363 — Action-oriented suggestions shown when the workspace has no workers yet.
const FIRST_RUN_SUGGESTIONS = [
  "Build me a worker that sends a daily email digest",
  "Build me a worker that posts Slack alerts for new HubSpot deals",
];

/** Compact pill row — shown above the composer when chat is active (not streaming). */
function SuggestionPills({
  onSuggest,
  hidden,
  pills = SUGGESTIONS,
}: {
  onSuggest: (text: string) => void;
  hidden: boolean;
  pills?: readonly string[];
}) {
  if (hidden) return null;
  return (
    <div className="flex flex-wrap gap-1.5 px-1 pb-1">
      {pills.map((s) => (
        <button
          key={s}
          type="button"
          onClick={() => onSuggest(s)}
          className="rounded-[var(--radius-pill)] [border:var(--bd-card)] bg-muted/40 px-2.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
        >
          {s}
        </button>
      ))}
    </div>
  );
}

// ── Typing indicator ──────────────────────────────────────────────────────────

function TypingIndicator() {
  return (
    <div className="flex items-start gap-2">
      <EmilyAvatar size="sm" />
      <div className="flex gap-1 py-1.5 px-1">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="size-1.5 rounded-[var(--radius-pill)] bg-muted-foreground/40 animate-bounce"
            style={{ animationDelay: `${i * 150}ms` }}
          />
        ))}
      </div>
    </div>
  );
}

// ── Message renderer ──────────────────────────────────────────────────────────

function assistantMessageText(msg: ChatMessage): string {
  return (msg.parts ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n\n")
    .trim();
}

function MessageCopyAction({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(() => {
    if (!text) return;
    const write = navigator.clipboard?.writeText
      ? navigator.clipboard.writeText(text)
      : new Promise<void>((resolve, reject) => {
          const textarea = document.createElement("textarea");
          textarea.value = text;
          textarea.setAttribute("readonly", "");
          textarea.style.position = "fixed";
          textarea.style.opacity = "0";
          document.body.appendChild(textarea);
          textarea.select();
          const ok = document.execCommand("copy");
          document.body.removeChild(textarea);
          if (ok) {
            resolve();
          } else {
            reject(new Error("Copy failed"));
          }
        });
    write
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1200);
      })
      .catch((err) => reportError("Could not copy to clipboard.", err));
  }, [text]);

  if (!text) return null;
  return (
    <MessageAction label={copied ? "Copied" : "Copy"} tooltip={copied ? "Copied" : "Copy"} onClick={copy}>
      {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
    </MessageAction>
  );
}

function MessageRow({ msg }: { msg: ChatMessage }) {
  if (msg.role === "user") {
    return (
      <Message from="user">
        <div className="flex max-w-[85%] flex-col items-end gap-1">
          {msg.text && (
            <MessageContent className="rounded-[var(--radius-button)] bg-muted/60 px-3 py-2 text-foreground">
              <MessageResponse className="whitespace-pre-wrap">
                <p>{msg.text}</p>
              </MessageResponse>
            </MessageContent>
          )}
          {msg.files && msg.files.length > 0 && (
            <div className="flex flex-wrap gap-1 justify-end">
              {msg.files.map((f) => (
                <FileChip key={f.id} file={f} />
              ))}
            </div>
          )}
          {/* C-03: copy on a SENT message is hover-only (like most chat UIs).
              Revealed on hover/focus of the message row; focus-within keeps it
              keyboard-accessible (tab to the button via focus-visible). */}
          <MessageActions className="justify-end pr-1 opacity-0 focus-within:opacity-100 group-hover/message:opacity-100">
            <MessageCopyAction text={msg.text ?? ""} />
          </MessageActions>
        </div>
      </Message>
    );
  }

  // assistant
  const text = assistantMessageText(msg);
  return (
    <Message from="assistant" className="flex-row items-start gap-2">
      <EmilyAvatar size="sm" />
      {/* min-w-0 + overflow-hidden prevent long URLs and code from blowing out the rail */}
      <div className="flex-1 min-w-0 overflow-hidden space-y-2">
        {msg.parts?.map((part, i) => {
          if (part.type === "text") {
            return (
              <MessageContent key={i}>
                <MessageResponse>
                  <MarkdownText text={part.text} streaming={!!part.streaming} />
                </MessageResponse>
              </MessageContent>
            );
          }
          if (part.type === "tool-card") {
            return <ToolCardRenderer key={i} card={part.card} />;
          }
          return null;
        })}
        {/* #1219: copy on an Emily message is hover-only (matches the user
            message). Revealed on hover/focus of the message row; focus-within
            keeps it keyboard-accessible. */}
        <MessageActions className="opacity-0 focus-within:opacity-100 group-hover/message:opacity-100">
          <MessageCopyAction text={text} />
        </MessageActions>
      </div>
    </Message>
  );
}

// ── Empty state (general chat) ────────────────────────────────────────────────

function ChatEmptyState({
  onSuggest,
  isNewWorkspace = false,
}: {
  onSuggest: (text: string) => void;
  isNewWorkspace?: boolean;
}) {
  const assistantName = useAssistantName();
  // #1363 — First-run opener: proactive builder message + action-oriented pills
  const headline = isNewWorkspace
    ? "Hi, describe what you want to automate and I’ll build the worker for you right now."
    // Brand call made by Federico (2026-06-16): the assistant is the "chief of
    // staff", not "COO". Greeting follows the persona ("I'm Emily, your chief of
    // staff") instead of the old hardcoded COO string.
    : `I am ${assistantName}, your chief of staff`;
  const sub = isNewWorkspace
    ? null
    : "Ask me to create workers, check runs, or manage connections.";
  const pills = isNewWorkspace ? FIRST_RUN_SUGGESTIONS : SUGGESTIONS;

  return (
    <div className="flex flex-col items-center justify-center h-full gap-4 px-6 text-center">
      <EmilyAvatar size="md" />
      <div>
        <p className="text-sm font-medium">{headline}</p>
        {sub && <p className="text-xs text-muted-foreground mt-1">{sub}</p>}
      </div>
      <div className="flex flex-wrap gap-1.5 justify-center">
        {pills.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => onSuggest(s)}
            className="rounded-[var(--radius-pill)] [border:var(--bd-card)] bg-muted/40 px-3 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Create-worker hero (full-width hero for create mode, no messages) ─────────

// Round-09 (Federico 2026-06-18): "The new worker should literally just be an
// Emily chat with some pills. It's literally an Emily chat. That's it. Don't make
// it anything more." Earlier rounds kept layering chrome on top (a greeting card,
// then example CARDS with integration badges + an "Or start from an example"
// section) which made it read as a launcher, not a chat. Stripped to: heading +
// one-line subtext + 2-3 suggestion PILLS + the previous-chat note (when a prior
// chat exists) + the SAME Emily composer the thread uses. Clicking a pill primes
// the composer with that prompt. Nothing more.
const CREATE_EXAMPLES = [
  "Summarise my Granola meetings → HubSpot daily",
  "Send me a GitHub PR digest at 9am",
  "Score new CRM contacts against a job brief",
] as const;

function CreateWorkerHeroState({
  input,
  onInput,
  onSubmit,
  onAddSource,
  attachedFiles,
  onFilesChange,
  hasPreviousChat,
  onOpenRecent,
}: {
  input: string;
  onInput: (v: string) => void;
  onSubmit: () => void;
  onAddSource: (source: string) => void;
  attachedFiles: AttachedFile[];
  onFilesChange: (files: AttachedFile[]) => void;
  /** True when a non-create Emily chat is still active (its id is persisted). */
  hasPreviousChat: boolean;
  /** Opens the Recent chats popover so the user can jump back to that chat. */
  onOpenRecent: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center min-h-full w-full px-6 py-12 gap-6">
      {/* Heading + one-line subtext — it IS the Emily chat, primed for create */}
      <div className="flex flex-col items-center text-center space-y-2 max-w-xl">
        <EmilyAvatar size="md" />
        <h1 className="text-xl font-semibold tracking-tight text-foreground leading-tight">
          Hire a new worker
        </h1>
        <p className="text-sm text-muted-foreground leading-relaxed">
          Describe the job in one sentence. I&apos;ll draft the worker, wire the
          tools and brain, then open it for your review.
        </p>
      </div>

      {/* The SAME Emily composer the chat thread uses (auto-resize, attachments,
          source pills, Enter-to-submit). Indistinguishable from chatting. */}
      <div className="w-full max-w-2xl space-y-2">
        <PromptInput
          value={input}
          onChange={onInput}
          onSubmit={onSubmit}
          onFilesChange={onFilesChange}
          attachedFiles={attachedFiles}
          placeholder="Create me: a worker that…"
        />
        {/* Suggestion pills — click to prime the composer with that prompt */}
        <div className="flex flex-wrap justify-center gap-1.5 px-1 pt-1">
          {CREATE_EXAMPLES.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => onInput(s)}
              className="rounded-[var(--radius-pill)] [border:var(--bd-card)] bg-muted/40 px-3 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            >
              {s}
            </button>
          ))}
        </div>
        <div className="px-1">
          <CreateSourcePills onPick={onAddSource} />
        </div>
      </div>

      {/* Previous-chat note (Federico spec): if the user was chatting with Emily
          before, the create-mode chat is a fresh ephemeral thread — tell them the
          old one is still there. */}
      {hasPreviousChat && (
        <p className="text-xs text-muted-foreground">
          Your previous chat is still running —{" "}
          <button
            type="button"
            onClick={onOpenRecent}
            className="font-medium text-foreground underline-offset-2 hover:underline"
          >
            find it in Recent chats
          </button>
          .
        </p>
      )}
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
  /** #902 create-worker mode: create-primed composer placeholder (wireframe
   *  newWorker(): Emily full-screen, placeholder "Create me: a worker that…"). */
  createMode?: boolean;
  /** #902: pre-fill the composer (legacy /workers/new?prompt= deep links). */
  primeInput?: string;
  onOpenRunDetails?: () => void;
  /** When provided, the core omits its own controls row (host renders them in the header). */
  hideControls?: boolean;
  /** Mutable ref that receives action callbacks so the host header can drive them. */
  actionsRef?: React.MutableRefObject<ChatCoreActions | null>;
  /** Called whenever hasMessages changes so host can update disabled state without reading a ref in render. */
  onHasMessagesChange?: (has: boolean) => void;
  /** Called whenever conversationId changes so host can highlight active chat without reading a ref in render. */
  onConversationIdChange?: (id: string | null) => void;
  /** #1363 — when true, show a proactive first-run opener instead of the generic empty state. */
  isNewWorkspace?: boolean;
}

const WORKER_MUTATION_TOOLS = new Set(["workers__create", "workers__update", "workers__delete"]);

function EmilyChatCore({ fullPage = false, createMode = false, primeInput, onOpenRunDetails, hideControls = false, actionsRef, onHasMessagesChange, onConversationIdChange, isNewWorkspace = false }: EmilyChatCoreProps) {
  const assistantName = useAssistantName();
  const {
    messages,
    conversationId,
    isStreaming,
    isHydrating,
    error,
    sendMessage,
    newSession,
    loadConversation,
  } = useChatStream({ ephemeral: createMode });
  const router = useRouter();
  const [input, setInput] = useState(primeInput ?? "");
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  // Start true so the first message load scrolls to bottom automatically.
  const isNearBottomRef = useRef(true);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const openedRunDetailsRef = useRef(new Set<string>());
  const runDetailsNavReadyRef = useRef(false);
  // Create-mode is an ephemeral chat, so it never persists its own id. If a
  // non-create Emily chat was already running its id is in localStorage — detect
  // it (client-only, after mount) to show the "previous chat is still running"
  // note. `recentOpenSignal` bumps to pop the Recent chats list from that note.
  const [hasPreviousChat, setHasPreviousChat] = useState(false);
  const [recentOpenSignal, setRecentOpenSignal] = useState(0);
  useEffect(() => {
    if (createMode) setHasPreviousChat(Boolean(readStoredConversationId()));
  }, [createMode]);

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
    // Round-09 #2: the create-mode "Hire a worker" hero must DRAFT a worker, not
    // send a bare chat message Emily can answer as a query. Wrap the FIRST
    // create-mode message in an explicit worker-authoring directive so the
    // backend routes it to the drafting path. Only the opening message (the
    // hero) is wrapped; once a thread exists the user chats normally.
    const message =
      createMode && messages.length === 0 ? buildCreateWorkerMessage(text) : text;
    sendMessage(message, attachedFiles.length > 0 ? attachedFiles : undefined);
    setInput("");
    setAttachedFiles([]);
  }, [input, attachedFiles, sendMessage, createMode, messages.length]);

  // Create-mode source pill → append a natural "use my <source>" hint to the
  // composer so the assistant knows which context to wire into the new worker.
  const handleAddSource = useCallback((source: string) => {
    setInput((prev) => {
      const hint = `Use my ${source}.`;
      if (prev.toLowerCase().includes(source.toLowerCase())) return prev;
      const sep = prev.trim().length === 0 ? "" : prev.endsWith(" ") ? "" : " ";
      return `${prev}${sep}${hint}`;
    });
  }, []);

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

  // In full-page create mode with no messages, show the wide hero instead of the
  // narrow chat thread. The hero shares the same input/submit path so sending
  // from the hero immediately starts the conversation and reveals the thread.
  if (fullPage && createMode && !hasMessages && !isHydrating) {
    return (
      <div className="flex h-full flex-col">
        {/* Controls row carries Recent chats so the "previous chat is still
            running — find it in Recent chats" note has somewhere to point. The
            dock renders its own controls (hideControls), so only show here when
            this core owns its controls. */}
        {!hideControls && (
          <div className="flex shrink-0 items-center justify-end gap-1 [border-bottom:var(--bd-div)]/60 px-6 py-2">
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
              recentOpenSignal={recentOpenSignal}
            />
          </div>
        )}
        <div className="flex-1 overflow-y-auto">
          <CreateWorkerHeroState
            input={input}
            onInput={setInput}
            onSubmit={handleSubmit}
            onAddSource={handleAddSource}
            attachedFiles={attachedFiles}
            onFilesChange={setAttachedFiles}
            hasPreviousChat={hasPreviousChat}
            onOpenRecent={() => setRecentOpenSignal((n) => n + 1)}
          />
        </div>
      </div>
    );
  }

  return (
    <div className={cn("flex flex-col h-full", fullPage && "max-w-2xl mx-auto w-full")}>
      {/* Controls: New chat + Export — shown on full-page; dock header renders them when hideControls */}
      {!hideControls && (
        <div
          className={cn(
            "flex shrink-0 items-center justify-end gap-1 [border-bottom:var(--bd-div)]/60",
            fullPage ? "px-6 py-2" : "px-3 py-1.5"
          )}
        >
          <ChatControls
            onNew={() => {
              handleNew();
              isNearBottomRef.current = true;
              setShowScrollButton(false);
            }}
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
          // Only show the "Loading conversation…" spinner on the full-page chat
          // where the user explicitly navigated to Emily. In the dock the panel
          // is present on every page (Approvals, Connections, etc.) so showing a
          // loading status there is confusing — keep the empty/invite state instead
          // and let messages appear once hydration finishes (#1273).
          isHydrating && fullPage ? (
            <div className="flex h-full items-center justify-center px-6 text-center">
              <p className="text-xs text-muted-foreground">Loading conversation...</p>
            </div>
          ) : (
            <ChatEmptyState onSuggest={(text) => { setInput(text); }} isNewWorkspace={isNewWorkspace} />
          )
        ) : (
          <div className={cn("py-4 space-y-4", fullPage ? "px-6" : "px-4")}>
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
            className="sticky bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-1.5 rounded-[var(--radius-pill)] [border:var(--bd-card)] bg-background px-3 py-1.5 text-xs text-muted-foreground shadow-md hover:text-foreground hover:shadow-lg transition-all"
          >
            <ChevronDown className="size-3.5" />
            Scroll to bottom
          </button>
        )}
      </div>

      {/* Input — error intentionally NOT repeated here; it already shows as an
          inline system note in the message thread (errorAlreadyVisible guard above). */}
      <div className={cn("shrink-0", fullPage ? "px-6 pb-6 pt-3" : "px-3 pb-3 pt-0")}>
        <Separator className="mb-2" />
        {/* Suggestion pills: visible in active chat (not on empty state, not while streaming) */}
        <SuggestionPills
          onSuggest={(text) => { setInput(text); }}
          hidden={!hasMessages || isStreaming}
        />
        {/* B15: keep the textarea editable while Emily streams — only the SEND
            action is gated on isStreaming (sendDisabled), so the user can draft
            their next message during a response. */}
        <PromptInput
          value={input}
          onChange={setInput}
          onSubmit={handleSubmit}
          onFilesChange={setAttachedFiles}
          attachedFiles={attachedFiles}
          sendDisabled={isStreaming}
          placeholder={createMode ? "Create me: a worker that…" : `Message ${assistantName}...`}
        />
        <p className="mt-1 text-center text-[10px] text-muted-foreground">
          {assistantName} can make mistakes. Verify important results.
        </p>
      </div>
    </div>
  );
}

// ── Dock component (right-side persistent rail) ───────────────────────────────

// Emily dock width (SPEC §12): collapsed ↔ rail ↔ wide, an in-rail widen. TRUE
// fullscreen (Emily fills the main content area, sidebar stays) is a separate
// state owned by EmilyFullscreenContext (consumed by AppShell to hide the page
// pane). The `full` overlay mode was removed — it covered the nav too, which is
// not what Federico wanted.
type DockMode = "collapsed" | "rail" | "wide";

// Widths per APP-UI-V4-SPEC §2: rail 330px (collapse 46px), widen 560px.
const DOCK_WIDTH: Record<DockMode, string> = {
  collapsed: "w-[46px]",
  rail: "w-full md:w-[330px]",
  wide: "w-full md:w-[560px] md:max-w-[52vw]",
};

export function EmilyDock({ className }: { className?: string }) {
  const assistantName = useAssistantName();
  const [mode, setMode] = useState<DockMode>("rail");
  // True fullscreen lives in shared context (AppShell hides the page pane and
  // this dock flex-grows to fill the main area — the left sidebar stays put).
  const { fullscreen: isFull, setFullscreen } = useEmilyFullscreen();
  const open = mode !== "collapsed" || isFull;
  // Round-09 (Federico 2026-06-17): the PRIMARY expand control is TRUE
  // fullscreen — one click in (Emily takes over the main area, nav stays), one
  // click out (back to the right rail). No multi-step cycle through "wide".
  const enterFull = () => {
    setMode((m) => (m === "collapsed" ? "rail" : m));
    setFullscreen(true);
  };
  const exitFull = () => setFullscreen(false);
  const toggleFull = () => (isFull ? exitFull() : enterFull());
  // Secondary in-rail widen (rail ↔ wide), only when NOT fullscreen.
  const toggleWiden = () => setMode((m) => (m === "wide" ? "rail" : "wide"));
  // actionsRef lets the dock header drive new/export/recent without prop-drilling
  const coreActionsRef = useRef<ChatCoreActions | null>(null);
  // hasMessages as state so the Export menu item disables correctly (can't read ref in render)
  const [coreHasMessages, setCoreHasMessages] = useState(false);
  // Active conversation ID as state for recent-chats active highlight (can't read ref in render)
  const [coreConversationId, setCoreConversationId] = useState<string | null>(null);
  // Local state for recent chats popover in the header ⋯ menu
  const [recentItems, setRecentItems] = useState<import("@/lib/types").ConversationSummary[] | null>(null);
  // #1363 — detect empty workspace so Emily shows a proactive first-run opener.
  // Uses the existing overview stats endpoint (no new backend call).
  const [isNewWorkspace, setIsNewWorkspace] = useState(false);
  useEffect(() => {
    let alive = true;
    api.system.overview()
      .then((overview) => {
        if (!alive) return;
        const hasWorkers = (overview?.stats?.active_workers_count ?? 0) > 0 ||
          (overview?.stats?.paused_workers_count ?? 0) > 0;
        setIsNewWorkspace(!hasWorkers);
      })
      // #1446: only drives a cosmetic "new workspace" hint; log, no toast.
      .catch((err) => logError("Could not load workspace overview.", err));
    return () => { alive = false; };
  }, []);
  // #1141: reset the dock conversation when navigating away from /chat?mode=create
  // so the Overview Emily panel shows a fresh context instead of the create-mode thread.
  const pathname = usePathname();
  const prevPathname = useRef<string | null>(null);
  useEffect(() => {
    const prev = prevPathname.current;
    prevPathname.current = pathname;
    if (prev !== null && prev.startsWith("/chat") && !pathname.startsWith("/chat")) {
      coreActionsRef.current?.newSession();
    }
  }, [pathname]);

  return (
    <div
      className={cn(
        "flex h-full flex-col bg-background overflow-hidden [border-left:var(--bd-div)]",
        // Fullscreen: flex-grow to fill the main area (page pane is hidden by
        // AppShell), sidebar stays to the left. Otherwise: fixed-width rail.
        isFull ? "flex-1 min-w-0" : cn("shrink-0", DOCK_WIDTH[mode]),
        className
      )}
      aria-label={
        isFull
          ? "Emily dock (fullscreen)"
          : open
            ? `Emily dock (${mode})`
            : "Emily dock (collapsed)"
      }
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
        <div className="flex h-14 shrink-0 items-center gap-2 [border-bottom:var(--bd-div)] px-3">
          <EmilyAvatar size="sm" />
          <div className="flex-1 min-w-0 flex items-center gap-1.5">
            <p className="text-sm font-semibold leading-none truncate">{assistantName}</p>
            {/* Green presence dot */}
            <span
              className="size-2 shrink-0 rounded-[var(--radius-pill)] bg-green-500"
              aria-label="Online"
            />
          </div>
          {/* Secondary in-rail widen (rail ↔ wide) — only when NOT fullscreen.
              Lets Federico nudge the rail wider without taking over the page. */}
          {!isFull && (
            <Button
              size="sm"
              variant="ghost"
              className="hidden size-7 p-0 text-muted-foreground hover:bg-[var(--active-nav-bg)] hover:text-foreground md:inline-flex"
              onClick={toggleWiden}
              title={mode === "wide" ? `Narrow ${assistantName}` : `Widen ${assistantName}`}
              aria-label={mode === "wide" ? `Narrow ${assistantName}` : `Widen ${assistantName}`}
            >
              {mode === "wide" ? <ChevronRight className="size-4" /> : <ChevronLeft className="size-4" />}
            </Button>
          )}
          {/* PRIMARY make-fullscreen toggle — true one-click fullscreen: Emily
              takes over the main content area, the left nav stays (Federico
              2026-06-17). High-contrast so the affordance is clearly visible in
              BOTH light and night mode (the muted icon was hard to see). */}
          <Button
            size="sm"
            variant="ghost"
            className="size-7 p-0 text-[var(--text-primary)] hover:bg-[var(--active-nav-bg)] hover:text-foreground"
            onClick={toggleFull}
            title={isFull ? `Exit full screen` : `Full screen ${assistantName}`}
            aria-label={isFull ? `Shrink ${assistantName}` : `Expand ${assistantName}`}
          >
            {isFull ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
          </Button>
          {/* Full-screen CLOSE control (Federico 2026-06-17): only in full mode,
              one click exits fullscreen straight back to the right rail. */}
          {isFull && (
            <Button
              size="sm"
              variant="ghost"
              className="size-7 p-0 text-[var(--text-primary)] hover:bg-[var(--active-nav-bg)] hover:text-foreground"
              onClick={exitFull}
              title="Close full screen"
              aria-label="Close full screen"
            >
              <X className="size-4" />
            </Button>
          )}
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
          {/* Collapse button — hidden in full screen (Close exits there). */}
          {!isFull && (
            <Button
              size="sm"
              variant="ghost"
              className="size-7 p-0 text-muted-foreground hover:text-foreground"
              onClick={() => setMode("collapsed")}
              title={`Collapse ${assistantName}`}
              aria-label={`Collapse ${assistantName}`}
            >
              <ChevronRight className="size-4" />
            </Button>
          )}
        </div>
      )}

      {/* Chat content — ALWAYS mounted so useChatStream state survives collapse.
          In full screen, render with fullPage layout so the message thread takes
          the full height and the composer is anchored to the bottom (fixes the
          dead whitespace below the prompt box Federico flagged 2026-06-17). */}
      <div className={cn("flex-1 min-h-0 overflow-hidden", !open && "hidden")}>
        <EmilyChatCore
          fullPage={isFull}
          hideControls
          actionsRef={coreActionsRef}
          onHasMessagesChange={setCoreHasMessages}
          onConversationIdChange={setCoreConversationId}
          isNewWorkspace={isNewWorkspace}
        />
      </div>
    </div>
  );
}

// ── Mobile bottom-sheet (SPEC §8c: Emily becomes a bottom sheet on mobile) ────

export function EmilyMobileSheet() {
  const assistantName = useAssistantName();
  const [open, setOpen] = useState(false);
  return (
    <>
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label={`Open ${assistantName}`}
          className="fixed bottom-4 right-4 z-40 flex size-12 items-center justify-center rounded-[var(--radius-pill)] bg-background shadow-lg [border:var(--bd-card)]"
        >
          <EmilyAvatar size="sm" />
        </button>
      )}
      {open && (
        <div className="fixed inset-0 z-50 flex flex-col justify-end" role="dialog" aria-label={assistantName}>
          <button
            type="button"
            aria-label={`Close ${assistantName}`}
            className="absolute inset-0 bg-black/40"
            onClick={() => setOpen(false)}
          />
          <div className="relative flex h-[85vh] flex-col rounded-t-2xl [border-top:var(--bd-div)] bg-background">
            <div className="flex h-14 shrink-0 items-center gap-2 [border-bottom:var(--bd-div)] px-3">
              <EmilyAvatar size="sm" />
              <div className="flex-1 min-w-0 flex items-center gap-1.5">
                <p className="text-sm font-semibold leading-none truncate">{assistantName}</p>
                <span className="size-2 shrink-0 rounded-[var(--radius-pill)] bg-green-500" aria-label="Online" />
              </div>
              <Button
                size="sm"
                variant="ghost"
                className="size-7 p-0"
                onClick={() => setOpen(false)}
                title={`Close ${assistantName}`}
                aria-label={`Close ${assistantName}`}
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

export function EmilyChatPage({
  createMode = false,
  primeInput,
}: {
  createMode?: boolean;
  primeInput?: string;
} = {}) {
  const assistantName = useAssistantName();
  return (
    <div className="flex h-[calc(100vh-4rem)] flex-col">
      <div className="flex h-14 shrink-0 items-center gap-2 [border-bottom:var(--bd-div)] px-4">
        <EmilyAvatar size="sm" />
        <div className="flex-1 min-w-0 flex items-center gap-1.5">
          <p className="text-sm font-semibold leading-none">
            {createMode ? "Hire a worker" : assistantName}
          </p>
          {!createMode && (
            <span className="size-2 shrink-0 rounded-[var(--radius-pill)] bg-green-500" aria-label="Online" />
          )}
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-hidden">
        <EmilyChatCore fullPage createMode={createMode} primeInput={primeInput} />
      </div>
    </div>
  );
}

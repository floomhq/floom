"use client";

import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { AlertTriangle, Check, ChevronRight, ChevronLeft, ChevronDown, Copy, Maximize2, Minimize2, MessageCircle, PenSquare, Download, History, MoreHorizontal, X } from "lucide-react";
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
import { QueryClientContext } from "@tanstack/react-query";

import { useEmilyFullscreen } from "./emily-fullscreen";
import { EmilyAvatar } from "./EmilyAvatar";
import { MarkdownText } from "./MarkdownText";
import { PromptInput } from "./PromptInput";
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
import { buildCreateWorkerMessage } from "@/lib/emily-create-intent";
// Re-export so the create-mode wiring + its tests share one source of truth.
export { buildCreateWorkerMessage } from "@/lib/emily-create-intent";
import { useAssistantName } from "@/lib/workspace/assistant-name";
import { api } from "@/lib/api";
import { reportError, logError } from "@/lib/notify";
import type { ConversationSummary, SystemOverview } from "@/lib/types";
import type { AttachedFile, ChatMessage } from "@/lib/emily-chat-types";
import { useMcpModal } from "@/components/mcp/mcp-modal-context";
import { EmilyHomeEmpty } from "@/components/home/EmilyHomeEmpty";

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
  /** When set with createMode, the primed prompt is auto-submitted once on
   *  mount — used by the Emily HOME drafting state so the home "becomes the
   *  conversation" without the user re-pressing send. */
  autoSubmitPrime?: boolean;
  /** HOME mode (Federico 2026-06-19): the home route shows this REAL Emily
   *  FULLSCREEN, and its empty state gets the home "stuff" — greeting + lean
   *  pulse + pills — rendered ABOVE the real composer. Not a parallel composer:
   *  the pulse/pills seed THIS composer. */
  homeMode?: boolean;
  /** Server-rendered overview, hydrates the home pulse without a round-trip. */
  homeInitialData?: SystemOverview | null;
}

const WORKER_MUTATION_TOOLS = new Set(["workers__create", "workers__update", "workers__delete"]);

// Exported so the Emily HOME (components/home/EmilyHome) can render the SAME
// real chat core inline for its drafting state — reusing the live conversation
// rendering + worker-drafting tool cards instead of rebuilding Emily.
export function EmilyChatCore({ fullPage = false, createMode = false, primeInput, onOpenRunDetails, hideControls = false, actionsRef, onHasMessagesChange, onConversationIdChange, isNewWorkspace = false, autoSubmitPrime = false, homeMode = false, homeInitialData = null }: EmilyChatCoreProps) {
  const assistantName = useAssistantName();
  const mcpModal = useMcpModal();
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
  // Read the query client via context (NOT useQueryClient) so it is `undefined`
  // when no QueryClientProvider is mounted — the targeted list refresh below is
  // then a no-op. In the app Emily is always under QueryProvider, so this is the
  // live path; the optionality only matters for isolated component tests.
  const queryClient = useContext(QueryClientContext);
  const [input, setInput] = useState(primeInput ?? "");
  // Seed the composer when primeInput ARRIVES after mount. The full-page chat
  // passes primeInput at mount (handled by useState above), but the dock core is
  // mounted once for the whole app, so a later `/?create=1&prime=<text>` deep
  // link delivers primeInput post-mount — sync it in once per new value (only
  // while the composer is still empty and the thread hasn't started, so it never
  // clobbers what the user is typing or an in-progress conversation).
  const seededPrimeRef = useRef<string | undefined>(primeInput ?? undefined);
  useEffect(() => {
    if (!primeInput || seededPrimeRef.current === primeInput) return;
    seededPrimeRef.current = primeInput;
    setInput((prev) => (prev.trim().length === 0 ? primeInput : prev));
  }, [primeInput]);
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

  // #1559: keep the workers/runs/overview lists in sync whenever Emily completes
  // a create/update/delete — WITHOUT the reload flicker the old per-card
  // `router.refresh()` caused. `router.refresh()` re-fetches the WHOLE RSC tree,
  // and firing it once per completed mutation card re-rendered the entire app on
  // every card = visible flicker. Instead we (a) only TARGET the affected
  // react-query lists (workers + overview + runs), and (b) debounce to ONE
  // invalidation that runs after streaming ENDS — not per card. The lists are
  // react-query backed (lib/query/hooks), so invalidating their keys revalidates
  // just those queries in place; nothing else re-renders.
  const seenCardIds = useRef(new Set<string>());
  const pendingListRefreshRef = useRef(false);
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
          // Mark a refresh as pending; the flush effect below runs it ONCE after
          // the stream settles, so a multi-mutation reply triggers a single
          // targeted revalidation instead of one full reload per card.
          pendingListRefreshRef.current = true;
        }
      }
    }
  }, [messages]);

  // Flush the pending list refresh ONCE streaming has finished. Targeted
  // invalidation only — workers list, system overview, and runs (the three
  // surfaces a create/update/delete can change). No full RSC refresh, no flicker.
  // Query keys mirror lib/query/hooks `qk` (workers/overview/runs); using the
  // key roots here revalidates every matching list variant in place. If there is
  // no query client (no provider), this is a no-op.
  useEffect(() => {
    if (isStreaming || !pendingListRefreshRef.current) return;
    pendingListRefreshRef.current = false;
    if (!queryClient) return;
    queryClient.invalidateQueries({ queryKey: ["workers"] });
    queryClient.invalidateQueries({ queryKey: ["system", "overview"] });
    queryClient.invalidateQueries({ queryKey: ["runs"] });
  }, [isStreaming, queryClient]);

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

  // HOME drafting: auto-submit the primed create prompt exactly once on mount so
  // the home seamlessly "becomes the conversation". Guarded by a ref so it never
  // re-fires (e.g. on re-render) and only when there are no messages yet.
  const autoSubmittedRef = useRef(false);
  useEffect(() => {
    if (!autoSubmitPrime || !createMode) return;
    if (autoSubmittedRef.current) return;
    const text = (primeInput ?? "").trim();
    if (!text || messages.length > 0 || isHydrating) return;
    autoSubmittedRef.current = true;
    sendMessage(buildCreateWorkerMessage(text));
    setInput("");
  }, [autoSubmitPrime, createMode, primeInput, messages.length, isHydrating, sendMessage]);

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

  // Create is now visually the SAME as home (consistent Emily chat, Federico
  // 2026-06-19): no bespoke "Hire a new worker" hero. Both home and create show
  // the home empty state (greeting + pills) ABOVE a CENTERED composer (U1) — no
  // separate bottom-anchored composer while empty. Once the thread has messages,
  // the composer anchors to the bottom (preserved below). `createMode` stays a
  // BEHAVIOR flag only (buildCreateWorkerMessage on first send + ephemeral thread).
  const emptyHomeLike = homeMode || createMode;
  const showCenteredComposer = emptyHomeLike && !hasMessages && !isHydrating;

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
          ) : emptyHomeLike ? (
            // HOME + CREATE empty state (Federico 2026-06-19): the SAME consistent
            // Emily empty — greeting + lean pulse + pills — with the REAL composer
            // CENTERED directly below them (U1), not anchored to the bottom. The
            // pulse/pills seed THIS composer via setInput; there is exactly one
            // composer. Create is indistinguishable from home here (createMode is
            // a behavior flag only — see handleSubmit/buildCreateWorkerMessage).
            <div className="flex h-full flex-col items-center justify-center py-10">
              <EmilyHomeEmpty
                initialData={homeInitialData}
                onSeed={(text) => setInput(text)}
                onPickMcp={() => mcpModal.open()}
              />
              <div className="mt-6 w-full max-w-2xl px-6">
                {/* #1557/P1-10: HOME/CREATE empty state uses the LANDING-style
                    composer (flat, borderless, labeled "Hire" send, no
                    Uses-row) so the in-app first prompt matches the marketing
                    landing prompt box. */}
                <PromptInput
                  value={input}
                  onChange={setInput}
                  onSubmit={handleSubmit}
                  onFilesChange={setAttachedFiles}
                  attachedFiles={attachedFiles}
                  sendDisabled={isStreaming}
                  placeholder={`Message ${assistantName}...`}
                  variant="landing"
                />
              </div>
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

      {/* Bottom-anchored composer — CONVERSATION state only. In the home/create
          empty state the composer is centered with the greeting/pills above
          (showCenteredComposer), so this bottom block is suppressed to avoid the
          dead-whitespace Federico previously flagged. */}
      {!showCenteredComposer && (
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
            placeholder={`Message ${assistantName}...`}
          />
          <p className="mt-1 text-center text-[10px] text-muted-foreground">
            {assistantName} can make mistakes. Verify important results.
          </p>
        </div>
      )}
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
  // #1141: reset the dock conversation when navigating away from the create flow
  // so the next page (or a fresh home visit) shows a clean context instead of the
  // ephemeral create-mode thread. The create flow now lives on the home route
  // (?create=1), so reset on leaving home too.
  const pathname = usePathname();
  const prevPathname = useRef<string | null>(null);
  useEffect(() => {
    const prev = prevPathname.current;
    prevPathname.current = pathname;
    const leftChat = prev !== null && prev.startsWith("/chat") && !pathname.startsWith("/chat");
    const leftHome = prev === "/" || prev === "/overview";
    const enteringHome = pathname === "/" || pathname === "/overview";
    if (leftChat || (leftHome && !enteringHome)) {
      coreActionsRef.current?.newSession();
    }
  }, [pathname]);

  // HOME (Federico 2026-06-19): "/" and "/overview" ARE the existing Emily shown
  // FULLSCREEN — no separate main-pane composer, no parallel home. On the home
  // route, force Emily into fullscreen so the dock fills the main area (the
  // AppShell hides the empty page pane, the sidebar stays). The empty state then
  // renders the home greeting + pulse + pills (homeMode below).
  const isHomeRoute = pathname === "/" || pathname === "/overview";

  // CREATE (Federico 2026-06-19): "New worker" / the old /chat?mode=create no
  // longer open a SEPARATE full-page Emily with its own header. They land on the
  // SAME dock-fullscreen Emily as the home, primed for create — `/?create=1`
  // (with an optional `&prime=<text>` seeding the composer, used by the
  // landing→app from-prompt handoff and the workers empty-state prompt). The
  // dock reads the param, forces fullscreen, and renders the create empty state
  // (the "Hire a new worker" hero + create pills) INSIDE this one Emily core.
  const searchParams = useSearchParams();
  const createParam = searchParams.get("create") === "1";
  const primeParam = searchParams.get("prime")?.trim() || undefined;
  // Latch create-mode once consumed so a later route change / param strip does
  // not yank the user out of the create thread mid-conversation.
  const [createLatched, setCreateLatched] = useState(false);
  // Primed text is consumed once on enter (so it seeds the create composer) and
  // then cleared — re-renders must not keep re-seeding it.
  const [primeText, setPrimeText] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (createParam && isHomeRoute) {
      setCreateLatched(true);
      if (primeParam) setPrimeText(primeParam);
      // Drop the params from the URL so create-prime is deep-linkable but not
      // sticky across refresh/back (history.replace, no Next reload).
      if (typeof window !== "undefined") {
        const url = new URL(window.location.href);
        url.searchParams.delete("create");
        url.searchParams.delete("prime");
        window.history.replaceState(window.history.state, "", url.pathname + url.search);
      }
    }
  }, [createParam, isHomeRoute, primeParam]);
  // Reset the create latch when the user navigates away from the home route so
  // the next visit shows the home greeting (not a stale create hero).
  useEffect(() => {
    if (!isHomeRoute) {
      setCreateLatched(false);
      setPrimeText(undefined);
    }
  }, [isHomeRoute]);
  const createMode = (createParam || createLatched) && isHomeRoute;

  // Round-09 batch2 (Federico 2026-06-18): the home fullscreen Emily must be
  // COLLAPSIBLE. Collapsing on home docks Emily to the right rail and shows the
  // user's Workers list in the main pane (HomePane renders WorkersCollection
  // when fullscreen is off). `userCollapsedHome` suppresses the auto-fullscreen
  // effect so a manual collapse STICKS; it resets on a genuine fresh home entry
  // (navigating INTO home from another route) so the next visit opens fullscreen.
  const [userCollapsedHome, setUserCollapsedHome] = useState(false);
  const prevHomeRef = useRef<boolean>(isHomeRoute);
  useEffect(() => {
    const wasHome = prevHomeRef.current;
    prevHomeRef.current = isHomeRoute;
    // Fresh entry into home from elsewhere → clear any prior manual collapse and
    // open fullscreen. Create mode always opens fullscreen too.
    if (isHomeRoute && !wasHome) {
      setUserCollapsedHome(false);
      setFullscreen(true);
      return;
    }
    // On the home route (no route change) only force fullscreen while the user
    // has NOT manually collapsed it; create mode overrides the collapse.
    if (isHomeRoute && (!userCollapsedHome || createMode)) {
      setFullscreen(true);
    }
    // Leaving home (home → non-home TRANSITION) docks Emily back to the rail so
    // the destination page (Workers/Library/Runs/…) is visible. Without this the
    // home auto-fullscreen latched on across navigation and AppShell hid <main>
    // on EVERY route → Emily covered the page (P0). This fires only on the
    // transition (guarded by `wasHome`), never on every render of a non-home
    // route, so a fullscreen the user MANUALLY opens later on a non-home page
    // (via the dock toggle) is not clobbered.
    if (wasHome && !isHomeRoute) {
      setFullscreen(false);
    }
  }, [isHomeRoute, setFullscreen, userCollapsedHome, createMode]);

  // Collapse the home fullscreen Emily into the right rail (shows the Workers
  // list in the main pane). Maximize returns to fullscreen Emily.
  const collapseHome = () => {
    setUserCollapsedHome(true);
    setMode((m) => (m === "collapsed" ? "rail" : m));
    setFullscreen(false);
  };
  const maximizeHome = () => {
    setUserCollapsedHome(false);
    setFullscreen(true);
  };

  return (
    <div
      className={cn(
        "flex h-full flex-col bg-background overflow-hidden",
        // Fullscreen: flex-grow to fill the main area (page pane is hidden by
        // AppShell), sidebar stays to the left. Otherwise: fixed-width rail.
        // Left divider only in docked mode; in fullscreen it would double up
        // against the sidebar's right border.
        isFull ? "flex-1 min-w-0" : cn("shrink-0 [border-left:var(--bd-div)]", DOCK_WIDTH[mode]),
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
              BOTH light and night mode (the muted icon was hard to see).
              On the HOME route this becomes the collapse/maximize control
              (Federico 2026-06-18): collapsing docks Emily to the rail and shows
              the Workers list in the main pane; maximizing returns to fullscreen. */}
          {!isHomeRoute ? (
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
          ) : (
            <Button
              size="sm"
              variant="ghost"
              className="size-7 p-0 text-[var(--text-primary)] hover:bg-[var(--active-nav-bg)] hover:text-foreground"
              onClick={isFull ? collapseHome : maximizeHome}
              title={isFull ? `Minimize ${assistantName}` : `Full screen ${assistantName}`}
              aria-label={isFull ? `Minimize ${assistantName}` : `Expand ${assistantName}`}
            >
              {isFull ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
            </Button>
          )}
          {/* Full-screen CLOSE control (Federico 2026-06-17): only in full mode,
              one click exits fullscreen straight back to the right rail. On the
              HOME route the X collapses to the rail (showing the Workers list)
              rather than closing to a non-existent page pane. */}
          {isFull && !isHomeRoute && (
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
          {isFull && isHomeRoute && (
            <Button
              size="sm"
              variant="ghost"
              className="size-7 p-0 text-[var(--text-primary)] hover:bg-[var(--active-nav-bg)] hover:text-foreground"
              onClick={collapseHome}
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
          // CREATE renders the SAME consistent Emily empty state as home (greeting
          // + pills + centered composer) — createMode is a behavior flag only
          // (wraps the first send via buildCreateWorkerMessage + ephemeral thread).
          createMode={createMode}
          primeInput={createMode ? primeText : undefined}
          homeMode={isHomeRoute && !createMode}
        />
      </div>
    </div>
  );
}

// ── Mobile bottom-sheet (SPEC §8c: Emily becomes a bottom sheet on mobile) ────

export function EmilyMobileSheet() {
  const assistantName = useAssistantName();
  const pathname = usePathname();
  const isHomeRoute = pathname === "/" || pathname === "/overview";
  // MOBILE Emily (Federico 2026-06-19): on mobile the page pane shows the
  // Workers list (the home pane) and Emily lives behind a clearly-labeled
  // floating "Ask <assistant>" FAB. We do NOT auto-open the sheet — an aggressive
  // auto-open hid the FAB and left no reliable affordance to reach Emily (#1544).
  // The user taps the FAB to open the SAME real Emily, sized for the sheet; on
  // the home route it opens in homeMode (greeting + pulse + pills + composer).
  // Closing returns to the Workers list behind it.
  const [open, setOpen] = useState(false);
  return (
    <>
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label={`Ask ${assistantName}`}
          className="fixed bottom-4 right-4 z-40 flex items-center gap-2 rounded-[var(--radius-pill)] bg-background py-2.5 pl-3 pr-4 shadow-lg [border:var(--bd-card)]"
        >
          <MessageCircle className="size-5 text-[var(--text-primary)]" />
          <span className="text-sm font-semibold leading-none text-[var(--text-primary)]">Ask {assistantName}</span>
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
            {/* Mounted only while open → no second background chat instance.
                homeMode on the home route renders the home greeting/pulse/pills
                in Emily's empty state (same as the desktop dock). */}
            <div className="flex-1 min-h-0 overflow-hidden">
              <EmilyChatCore homeMode={isHomeRoute} />
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ── Full-page chat (used by /chat route) ──────────────────────────────────────

// General "talk to Emily" full-page surface (the /chat route). Worker creation
// is NOT here anymore — it lands on the home dock-fullscreen Emily primed for
// create (?create=1); see app/chat/page.tsx + the EmilyDock create handling.
export function EmilyChatPage() {
  const assistantName = useAssistantName();
  return (
    <div className="flex h-[calc(100vh-4rem)] flex-col">
      <div className="flex h-14 shrink-0 items-center gap-2 [border-bottom:var(--bd-div)] px-4">
        <EmilyAvatar size="sm" />
        <div className="flex-1 min-w-0 flex items-center gap-1.5">
          <p className="text-sm font-semibold leading-none">{assistantName}</p>
          <span className="size-2 shrink-0 rounded-[var(--radius-pill)] bg-green-500" aria-label="Online" />
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-hidden">
        <EmilyChatCore fullPage />
      </div>
    </div>
  );
}

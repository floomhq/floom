"use client";

/**
 * Emily Rail — Chief of Staff AI chat prototype
 *
 * Built with REAL Vercel AI Elements components:
 *   - Conversation + ConversationContent + ConversationScrollButton (use-stick-to-bottom)
 *   - Message + MessageContent + MessageResponse
 *   - Tool + ToolHeader + ToolContent + ToolInput + ToolOutput (from ai-elements/tool.tsx)
 *   - Task (from ai-elements/task.tsx)
 *
 * Mock data illustrates the full agentic flow:
 *   Worker creation (Drafting → Generating → Smoke → Ready)
 *   Run card with output + artifact
 *   Approval card
 *   Connect-Gmail card
 *
 * Emily branding: #59AAF8 avatar, "Chief of Staff" identity.
 * Respects Workeros tokens (--background, --foreground, --border, --muted, --primary, etc.)
 *
 * Panel behaviour:
 *   Desktop: ~460px / ~32% right rail, collapsible to 48px strip
 *   Mobile: full-screen overlay
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import {
  ChevronRight,
  ChevronLeft,
  SendHorizonal,
  X,
  CheckCircle2,
  Clock,
  Loader2,
  Circle,
  Sparkles,
  Mail,
  Play,
  FileText,
  ExternalLink,
} from "lucide-react";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
  ConversationEmptyState,
} from "@/components/ai-elements/conversation";
import {
  Message,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message";
import {
  AiTool,
  ToolHeader,
  ToolContent,
  ToolInput,
  ToolOutput,
  type ToolState,
} from "@/components/ai-elements/ai-tool";
import { Task } from "@/components/ai-elements/task";

// ── Types ────────────────────────────────────────────────────────────────────

type Msg =
  | { id: string; role: "user"; text: string }
  | { id: string; role: "assistant"; parts: MsgPart[] };

type MsgPart =
  | { type: "text"; text: string; streaming?: boolean }
  | { type: "tool"; name: string; state: ToolState; input?: unknown; output?: unknown }
  | { type: "worker-creation"; workerName: string; step: "drafting" | "generating" | "smoke" | "ready" }
  | { type: "run-card"; workerName: string; duration: string; lines: number; artifact?: string }
  | { type: "approval-card"; workerName: string; action: string; approved: boolean | null }
  | { type: "connect-gmail" };

// ── Mock conversation ─────────────────────────────────────────────────────────

const MOCK_MESSAGES: Msg[] = [
  {
    id: "1",
    role: "user",
    text: "Hey Emily, create a worker that sends me a weekly digest of my top GitHub PRs every Monday at 9am.",
  },
  {
    id: "2",
    role: "assistant",
    parts: [
      {
        type: "text",
        text: "On it. I'm drafting a Weekly GitHub Digest worker for you. This will pull your open PRs every Monday morning and email you a summary.",
      },
      {
        type: "worker-creation",
        workerName: "Weekly GitHub Digest",
        step: "ready",
      },
    ],
  },
  {
    id: "3",
    role: "user",
    text: "Great! Run it now so I can see what the email looks like.",
  },
  {
    id: "4",
    role: "assistant",
    parts: [
      {
        type: "text",
        text: "Running Weekly GitHub Digest now...",
      },
      {
        type: "tool",
        name: "github.listPullRequests",
        state: "output-available",
        input: { owner: "floomhq", state: "open", per_page: 10 },
        output: [
          { number: 433, title: "feat(queue): in-process run-execution queue", author: "fede" },
          { number: 431, title: "fix: replay persisted logs on SSE stream", author: "fede" },
          { number: 429, title: "fix: auto-dedupe worker id on draft-and-create", author: "fede" },
        ],
      },
      {
        type: "tool",
        name: "email.send",
        state: "output-available",
        input: { to: "depontefede@gmail.com", subject: "Weekly GitHub Digest — 5 open PRs" },
        output: { messageId: "msg_01ABCD", status: "sent" },
      },
      {
        type: "run-card",
        workerName: "Weekly GitHub Digest",
        duration: "4.2s",
        lines: 87,
        artifact: "weekly-github-digest-2026-06-05.md",
      },
    ],
  },
  {
    id: "5",
    role: "user",
    text: "Nice! Now create a worker that monitors Stripe for failed payments and pings me on Slack immediately.",
  },
  {
    id: "6",
    role: "assistant",
    parts: [
      {
        type: "text",
        text: "I'd like to connect to your Stripe account to set up that worker. I'll also need your Slack workspace connected — let me check.",
      },
      {
        type: "approval-card",
        workerName: "Stripe Failure Monitor",
        action: "Connect Stripe + read payment events",
        approved: null,
      },
    ],
  },
  {
    id: "7",
    role: "user",
    text: "Can you also hook it up to my Gmail to send a backup email?",
  },
  {
    id: "8",
    role: "assistant",
    parts: [
      { type: "text", text: "Sure — I just need you to connect Gmail first:" },
      { type: "connect-gmail" },
    ],
  },
  {
    id: "9",
    role: "user",
    text: "What workers do I currently have?",
  },
  {
    id: "10",
    role: "assistant",
    parts: [
      {
        type: "text",
        text: "You have 3 active workers:\n\n1. **Weekly GitHub Digest** — runs every Monday at 9am, sends email\n2. **Stripe Failure Monitor** — waiting for approval to connect Stripe\n3. **Daily Standup** — posts to Slack at 8:30am weekdays\n\nAll are healthy. Last run: 4 hours ago.",
      },
    ],
  },
];

// ── Sub-components ────────────────────────────────────────────────────────────

function WorkerCreationCard({
  workerName,
  step,
}: {
  workerName: string;
  step: "drafting" | "generating" | "smoke" | "ready";
}) {
  const steps: Array<{ key: string; label: string; status: "pending" | "running" | "completed" | "failed" }> = [
    { key: "drafting", label: "Drafting manifest", status: step === "drafting" ? "running" : "completed" },
    {
      key: "generating",
      label: "Generating worker code",
      status: step === "drafting" ? "pending" : step === "generating" ? "running" : "completed",
    },
    {
      key: "smoke",
      label: "Smoke test",
      status: step === "smoke" ? "running" : step === "ready" ? "completed" : "pending",
    },
    {
      key: "ready",
      label: "Worker ready",
      status: step === "ready" ? "completed" : "pending",
    },
  ];

  return (
    <div className="rounded-lg border border-border bg-card p-3 space-y-2">
      <div className="flex items-center gap-2">
        <Sparkles className="size-4 text-[#59AAF8]" />
        <span className="font-medium text-sm">{workerName}</span>
        {step === "ready" && (
          <Badge variant="secondary" className="ml-auto text-xs bg-green-500/10 text-green-600 border-green-500/20">
            Ready
          </Badge>
        )}
      </div>
      <div className="space-y-1">
        {steps.map((s) => (
          <Task key={s.key} title={s.label} status={s.status} />
        ))}
      </div>
      {step === "ready" && (
        <div className="flex gap-2 pt-1">
          <Button size="sm" variant="outline" className="h-7 text-xs gap-1.5">
            <Play className="size-3" /> Run now
          </Button>
          <Button size="sm" variant="outline" className="h-7 text-xs gap-1.5">
            <ExternalLink className="size-3" /> Open
          </Button>
        </div>
      )}
    </div>
  );
}

function RunCard({
  workerName,
  duration,
  lines,
  artifact,
}: {
  workerName: string;
  duration: string;
  lines: number;
  artifact?: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-3 space-y-2">
      <div className="flex items-center gap-2">
        <CheckCircle2 className="size-4 text-green-600" />
        <span className="font-medium text-sm">{workerName}</span>
        <span className="ml-auto text-xs text-muted-foreground">{duration}</span>
      </div>
      <div className="text-xs text-muted-foreground">
        {lines} log lines · Run completed
      </div>
      {artifact && (
        <div className="flex items-center gap-1.5 rounded-md bg-muted/50 px-2.5 py-1.5">
          <FileText className="size-3.5 text-muted-foreground shrink-0" />
          <span className="text-xs font-mono truncate">{artifact}</span>
          <Button size="sm" variant="ghost" className="ml-auto h-5 w-5 p-0 shrink-0">
            <ExternalLink className="size-3" />
          </Button>
        </div>
      )}
    </div>
  );
}

function ApprovalCard({
  workerName,
  action,
  approved,
  onApprove,
  onDeny,
}: {
  workerName: string;
  action: string;
  approved: boolean | null;
  onApprove: () => void;
  onDeny: () => void;
}) {
  return (
    <div
      className={cn(
        "rounded-lg border p-3 space-y-2",
        approved === null
          ? "border-amber-500/30 bg-amber-500/5"
          : approved
          ? "border-green-500/30 bg-green-500/5"
          : "border-red-500/30 bg-red-500/5"
      )}
    >
      <div className="flex items-center gap-2">
        <Clock className="size-4 text-amber-600 shrink-0" />
        <div className="min-w-0">
          <p className="font-medium text-sm">{workerName}</p>
          <p className="text-xs text-muted-foreground truncate">{action}</p>
        </div>
      </div>
      {approved === null ? (
        <div className="flex gap-2">
          <Button size="sm" className="h-7 text-xs" onClick={onApprove}>
            Approve
          </Button>
          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={onDeny}>
            Deny
          </Button>
        </div>
      ) : (
        <Badge
          variant="secondary"
          className={cn(
            "text-xs",
            approved ? "bg-green-500/10 text-green-600" : "bg-red-500/10 text-red-600"
          )}
        >
          {approved ? "Approved" : "Denied"}
        </Badge>
      )}
    </div>
  );
}

function ConnectGmailCard() {
  const [connected, setConnected] = useState(false);

  return (
    <div className="rounded-lg border border-border bg-card p-3 space-y-2">
      <div className="flex items-center gap-2">
        <Mail className="size-4 text-[#59AAF8]" />
        <span className="font-medium text-sm">Connect Gmail</span>
        {connected && (
          <Badge variant="secondary" className="ml-auto text-xs bg-green-500/10 text-green-600 border-green-500/20">
            Connected
          </Badge>
        )}
      </div>
      {!connected ? (
        <>
          <p className="text-xs text-muted-foreground">
            Allow Emily to send emails from your Gmail account.
          </p>
          <Button
            size="sm"
            className="h-7 text-xs gap-1.5"
            onClick={() => setConnected(true)}
          >
            <Mail className="size-3" />
            Connect Gmail
          </Button>
        </>
      ) : (
        <p className="text-xs text-muted-foreground">
          depontefede@gmail.com — ready to send
        </p>
      )}
    </div>
  );
}

function MsgParts({ parts, msgId }: { parts: MsgPart[]; msgId: string }) {
  const [approvalStates, setApprovalStates] = useState<Record<string, boolean | null>>({});

  return (
    <div className="space-y-3">
      {parts.map((part, i) => {
        const key = `${msgId}-${i}`;
        if (part.type === "text") {
          return (
            <MessageResponse key={key} isAnimating={part.streaming}>
              {part.text}
            </MessageResponse>
          );
        }
        if (part.type === "tool") {
          return (
            <AiTool key={key} defaultOpen={part.state !== "output-available"}>
              <ToolHeader
                title={part.name}
                state={part.state}
              />
              <ToolContent>
                {part.input !== undefined && <ToolInput input={part.input} />}
                <ToolOutput output={part.output} />
              </ToolContent>
            </AiTool>
          );
        }
        if (part.type === "worker-creation") {
          return (
            <WorkerCreationCard
              key={key}
              workerName={part.workerName}
              step={part.step}
            />
          );
        }
        if (part.type === "run-card") {
          return (
            <RunCard
              key={key}
              workerName={part.workerName}
              duration={part.duration}
              lines={part.lines}
              artifact={part.artifact}
            />
          );
        }
        if (part.type === "approval-card") {
          const state = approvalStates[key] ?? part.approved;
          return (
            <ApprovalCard
              key={key}
              workerName={part.workerName}
              action={part.action}
              approved={state}
              onApprove={() => setApprovalStates((s) => ({ ...s, [key]: true }))}
              onDeny={() => setApprovalStates((s) => ({ ...s, [key]: false }))}
            />
          );
        }
        if (part.type === "connect-gmail") {
          return <ConnectGmailCard key={key} />;
        }
        return null;
      })}
    </div>
  );
}

// ── Emily avatar ──────────────────────────────────────────────────────────────

function EmilyAvatar({ size = "md" }: { size?: "sm" | "md" }) {
  const sz = size === "sm" ? "size-6" : "size-8";
  return (
    <div
      className={cn(
        sz,
        "shrink-0 rounded-full flex items-center justify-center text-white font-semibold text-xs shadow-sm"
      )}
      style={{ background: "#59AAF8" }}
      aria-label="Emily, Chief of Staff"
    >
      E
    </div>
  );
}

// ── PromptInput ───────────────────────────────────────────────────────────────
// Minimal but real — textarea + send button. The full AI Elements PromptInput
// requires InputGroup which isn't in this project's shadcn install yet; this
// matches its visual contract with the real deps (Button, Textarea).

function PromptInput({
  value,
  onChange,
  onSubmit,
  placeholder,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  placeholder?: string;
  disabled?: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSubmit();
    }
  };

  useEffect(() => {
    if (ref.current) {
      ref.current.style.height = "auto";
      ref.current.style.height = `${Math.min(ref.current.scrollHeight, 140)}px`;
    }
  }, [value]);

  return (
    <div className="flex items-end gap-2 rounded-lg border border-border bg-background px-3 py-2.5 shadow-sm focus-within:ring-1 focus-within:ring-[#59AAF8]/40">
      <textarea
        ref={ref}
        className="flex-1 resize-none bg-transparent text-sm outline-none placeholder:text-muted-foreground min-h-[20px] max-h-[140px] overflow-auto"
        placeholder={placeholder || "Message Emily..."}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKey}
        rows={1}
        disabled={disabled}
      />
      <Button
        size="sm"
        className="h-7 w-7 p-0 shrink-0"
        onClick={onSubmit}
        disabled={!value.trim() || disabled}
        style={{ background: "#59AAF8", color: "white" }}
        type="button"
      >
        <SendHorizonal className="size-3.5" />
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

// ── Main Rail component ───────────────────────────────────────────────────────

export function EmilyRail({ className }: { className?: string }) {
  const [open, setOpen] = useState(true);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [isTyping, setIsTyping] = useState(false);

  // Load mock conversation after mount (simulates streamed history)
  useEffect(() => {
    const timer = setTimeout(() => {
      setMessages(MOCK_MESSAGES);
    }, 400);
    return () => clearTimeout(timer);
  }, []);

  const sendMessage = useCallback(
    (text?: string) => {
      const content = (text ?? input).trim();
      if (!content) return;
      setInput("");

      const userMsg: Msg = { id: `u-${Date.now()}`, role: "user", text: content };
      setMessages((m) => [...m, userMsg]);
      setIsTyping(true);

      setTimeout(() => {
        const reply: Msg = {
          id: `a-${Date.now()}`,
          role: "assistant",
          parts: [
            {
              type: "text",
              text: `Got it. I'm on it — "${content}". Give me a moment to work on this.`,
            },
          ],
        };
        setMessages((m) => [...m, reply]);
        setIsTyping(false);
      }, 1200);
    },
    [input]
  );

  // ── Collapsed strip ──────────────────────────────────────────────────────
  if (!open) {
    return (
      <div
        className={cn(
          "flex h-full w-12 flex-col items-center justify-start border-l border-border bg-background pt-4 gap-3",
          className
        )}
      >
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="flex flex-col items-center gap-1.5 group"
          title="Open Emily"
        >
          <EmilyAvatar size="sm" />
          <ChevronLeft className="size-3.5 text-muted-foreground group-hover:text-foreground transition-colors" />
        </button>
      </div>
    );
  }

  // ── Open rail ────────────────────────────────────────────────────────────
  return (
    <div
      className={cn(
        "flex h-full flex-col border-l border-border bg-background",
        "w-full md:w-[460px] md:max-w-[32vw]",
        className
      )}
    >
      {/* Header */}
      <div className="flex h-12 shrink-0 items-center gap-2.5 border-b border-border px-4">
        <EmilyAvatar size="sm" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold leading-none truncate">Emily</p>
          <p className="text-[11px] text-muted-foreground leading-none mt-0.5">Chief of Staff</p>
        </div>
        <Badge
          variant="secondary"
          className="text-[10px] px-1.5 py-0.5 bg-green-500/10 text-green-600 border-green-500/20 shrink-0"
        >
          Online
        </Badge>
        <Button
          size="sm"
          variant="ghost"
          className="size-7 p-0 ml-1"
          onClick={() => setOpen(false)}
          title="Collapse"
        >
          <ChevronRight className="size-4" />
        </Button>
      </div>

      {/* Conversation — real AI Elements component */}
      {messages.length === 0 ? (
        <div className="flex-1 flex flex-col">
          <ConversationEmptyState
            icon={<EmilyAvatar />}
            title="I'm Emily, your Chief of Staff"
            description="Ask me to create workers, check runs, or manage your connections."
          />
        </div>
      ) : (
        <Conversation className="flex-1">
          <ConversationContent>
            {messages.map((msg) =>
              msg.role === "user" ? (
                <Message key={msg.id} from="user">
                  <MessageContent>
                    <p className="whitespace-pre-wrap">{msg.text}</p>
                  </MessageContent>
                </Message>
              ) : (
                <Message key={msg.id} from="assistant">
                  <div className="flex items-start gap-2.5">
                    <EmilyAvatar size="sm" />
                    <MessageContent>
                      <MsgParts parts={msg.parts} msgId={msg.id} />
                    </MessageContent>
                  </div>
                </Message>
              )
            )}

            {isTyping && (
              <Message from="assistant">
                <div className="flex items-start gap-2.5">
                  <EmilyAvatar size="sm" />
                  <MessageContent>
                    <div className="flex gap-1 py-1">
                      {[0, 1, 2].map((i) => (
                        <div
                          key={i}
                          className="size-1.5 rounded-full bg-muted-foreground animate-bounce"
                          style={{ animationDelay: `${i * 150}ms` }}
                        />
                      ))}
                    </div>
                  </MessageContent>
                </div>
              </Message>
            )}
          </ConversationContent>
          <ConversationScrollButton />
        </Conversation>
      )}

      {/* Suggestions */}
      {messages.length === 0 && (
        <div className="px-4 pb-2 flex flex-wrap gap-1.5">
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => sendMessage(s)}
              className="rounded-full border border-border bg-muted/50 px-3 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            >
              {s}
            </button>
          ))}
        </div>
      )}

      <Separator />

      {/* Prompt input */}
      <div className="p-3">
        <PromptInput
          value={input}
          onChange={setInput}
          onSubmit={() => sendMessage()}
          disabled={isTyping}
        />
        <p className="mt-1.5 text-center text-[10px] text-muted-foreground">
          Emily can make mistakes. Check important info.
        </p>
      </div>
    </div>
  );
}

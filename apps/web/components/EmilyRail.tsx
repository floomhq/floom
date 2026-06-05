"use client";

/**
 * Emily Rail — Chief of Staff AI chat prototype
 *
 * Built with REAL Vercel AI Elements components:
 *   - Conversation + ConversationContent + ConversationScrollButton
 *   - Message + MessageContent + MessageResponse
 *   - AiTool + ToolHeader + ToolContent + ToolInput + ToolOutput (collapsed by default)
 *   - Task (worker-creation steps)
 *
 * v2 changes:
 *   - More digestible cards: extra breathing room, quieter hierarchy
 *   - Tool calls collapsed by default (expand on click)
 *   - File attachment: Paperclip button + file chip previews above input
 *   - File validation: max 10 MB, common types only
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
  CheckCircle2,
  Clock,
  Sparkles,
  Mail,
  Play,
  FileText,
  ExternalLink,
  Paperclip,
  X,
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
  | { id: string; role: "user"; text: string; files?: AttachedFile[] }
  | { id: string; role: "assistant"; parts: MsgPart[] };

type MsgPart =
  | { type: "text"; text: string; streaming?: boolean }
  | { type: "tool"; name: string; state: ToolState; input?: unknown; output?: unknown }
  | { type: "worker-creation"; workerName: string; step: "drafting" | "generating" | "smoke" | "ready" }
  | { type: "run-card"; workerName: string; duration: string; lines: number; artifact?: string }
  | { type: "approval-card"; workerName: string; action: string; approved: boolean | null }
  | { type: "connect-gmail" };

interface AttachedFile {
  id: string;
  name: string;
  size: number;
  type: string;
}

// ── File helpers ──────────────────────────────────────────────────────────────

const ACCEPTED_TYPES = [
  "image/*",
  "text/*",
  "application/pdf",
  "application/json",
  "application/zip",
  "application/vnd.openxmlformats-officedocument.*",
  "application/msword",
];

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getFileIcon(type: string): React.ReactNode {
  if (type.startsWith("image/")) {
    return (
      <span className="text-[10px] font-mono text-muted-foreground uppercase tracking-wide">
        IMG
      </span>
    );
  }
  return <FileText className="size-3 text-muted-foreground" />;
}

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
        text: "On it. I'm drafting a Weekly GitHub Digest worker for you — it'll pull your open PRs every Monday morning and email you a summary.",
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
        text: "I need to connect to your Stripe account first. I'll also check Slack.",
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
      { type: "text", text: "Sure — connect Gmail first:" },
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
        text: "You have 3 active workers:\n\n1. **Weekly GitHub Digest** — runs every Monday at 9am\n2. **Stripe Failure Monitor** — waiting for Stripe approval\n3. **Daily Standup** — posts to Slack at 8:30am weekdays\n\nAll healthy. Last run: 4 hours ago.",
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
      label: "Generating code",
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
    <div className="rounded-xl border border-border bg-card/60 overflow-hidden">
      {/* Card header */}
      <div className="flex items-center gap-2.5 px-4 py-3 border-b border-border/50">
        <Sparkles className="size-3.5 text-[#59AAF8] shrink-0" />
        <span className="text-sm font-medium flex-1 min-w-0 truncate">{workerName}</span>
        {step === "ready" && (
          <Badge variant="secondary" className="text-[11px] px-2 py-0.5 bg-green-500/10 text-green-600 border-green-500/20 font-normal">
            Ready
          </Badge>
        )}
      </div>
      {/* Steps */}
      <div className="px-3 py-3 space-y-1.5">
        {steps.map((s) => (
          <Task key={s.key} title={s.label} status={s.status} />
        ))}
      </div>
      {/* Actions */}
      {step === "ready" && (
        <div className="flex gap-2 px-3 pb-3">
          <Button size="sm" variant="outline" className="h-7 text-xs gap-1.5 font-normal">
            <Play className="size-3" /> Run now
          </Button>
          <Button size="sm" variant="outline" className="h-7 text-xs gap-1.5 font-normal">
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
    <div className="rounded-xl border border-border bg-card/60 overflow-hidden">
      <div className="flex items-center gap-2.5 px-4 py-3">
        <CheckCircle2 className="size-3.5 text-green-600 shrink-0" />
        <span className="text-sm font-medium flex-1 min-w-0 truncate">{workerName}</span>
        <span className="text-xs text-muted-foreground shrink-0">{duration}</span>
      </div>
      <div className="px-4 pb-3 space-y-2">
        <p className="text-xs text-muted-foreground">{lines} log lines · Run completed</p>
        {artifact && (
          <div className="flex items-center gap-2 rounded-lg bg-muted/50 px-3 py-2">
            <FileText className="size-3.5 text-muted-foreground shrink-0" />
            <span className="text-xs font-mono flex-1 min-w-0 truncate text-foreground/80">{artifact}</span>
            <Button size="sm" variant="ghost" className="h-5 w-5 p-0 shrink-0 ml-auto">
              <ExternalLink className="size-3" />
            </Button>
          </div>
        )}
      </div>
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
        "rounded-xl border overflow-hidden",
        approved === null
          ? "border-amber-400/30 bg-amber-50/40 dark:bg-amber-950/20"
          : approved
          ? "border-green-500/30 bg-green-50/40 dark:bg-green-950/20"
          : "border-red-500/30 bg-red-50/40 dark:bg-red-950/20"
      )}
    >
      <div className="flex items-start gap-2.5 px-4 py-3">
        <Clock className="size-3.5 text-amber-600 mt-0.5 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{workerName}</p>
          <p className="text-xs text-muted-foreground mt-0.5">{action}</p>
        </div>
      </div>
      {approved === null ? (
        <div className="flex gap-2 px-4 pb-3">
          <Button size="sm" className="h-7 text-xs font-normal" onClick={onApprove}>
            Approve
          </Button>
          <Button size="sm" variant="outline" className="h-7 text-xs font-normal" onClick={onDeny}>
            Deny
          </Button>
        </div>
      ) : (
        <div className="px-4 pb-3">
          <Badge
            variant="secondary"
            className={cn(
              "text-xs font-normal",
              approved ? "bg-green-500/10 text-green-600" : "bg-red-500/10 text-red-600"
            )}
          >
            {approved ? "Approved" : "Denied"}
          </Badge>
        </div>
      )}
    </div>
  );
}

function ConnectGmailCard() {
  const [connected, setConnected] = useState(false);

  return (
    <div className="rounded-xl border border-border bg-card/60 overflow-hidden">
      <div className="flex items-center gap-2.5 px-4 py-3">
        <Mail className="size-3.5 text-[#59AAF8] shrink-0" />
        <span className="text-sm font-medium flex-1">Connect Gmail</span>
        {connected && (
          <Badge variant="secondary" className="text-[11px] px-2 py-0.5 bg-green-500/10 text-green-600 border-green-500/20 font-normal">
            Connected
          </Badge>
        )}
      </div>
      <div className="px-4 pb-3 space-y-2">
        {!connected ? (
          <>
            <p className="text-xs text-muted-foreground">
              Allow Emily to send emails from your Gmail account.
            </p>
            <Button
              size="sm"
              className="h-7 text-xs gap-1.5 font-normal"
              onClick={() => setConnected(true)}
            >
              <Mail className="size-3" />
              Connect Gmail
            </Button>
          </>
        ) : (
          <p className="text-xs text-muted-foreground">depontefede@gmail.com — ready to send</p>
        )}
      </div>
    </div>
  );
}

function MsgParts({ parts, msgId }: { parts: MsgPart[]; msgId: string }) {
  const [approvalStates, setApprovalStates] = useState<Record<string, boolean | null>>({});

  return (
    <div className="space-y-2.5">
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
          // Completed tools collapsed by default; in-progress open
          const defaultOpen = part.state !== "output-available";
          return (
            <AiTool key={key} defaultOpen={defaultOpen}>
              <ToolHeader title={part.name} state={part.state} />
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

// ── File chip ─────────────────────────────────────────────────────────────────

function FileChip({ file, onRemove }: { file: AttachedFile; onRemove: () => void }) {
  return (
    <div className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/60 pl-2.5 pr-1.5 py-1 text-xs max-w-[200px]">
      {getFileIcon(file.type)}
      <span className="truncate flex-1 min-w-0 text-foreground/80">{file.name}</span>
      <span className="text-muted-foreground shrink-0">{formatBytes(file.size)}</span>
      <button
        type="button"
        onClick={onRemove}
        className="shrink-0 rounded-full p-0.5 hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
        aria-label={`Remove ${file.name}`}
      >
        <X className="size-3" />
      </button>
    </div>
  );
}

// ── PromptInput with file attachment ─────────────────────────────────────────

function PromptInput({
  value,
  onChange,
  onSubmit,
  onFilesChange,
  attachedFiles,
  placeholder,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  onFilesChange: (files: AttachedFile[]) => void;
  attachedFiles: AttachedFile[];
  placeholder?: string;
  disabled?: boolean;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSubmit();
    }
  };

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 140)}px`;
    }
  }, [value]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newFiles = Array.from(e.target.files ?? []);
    const valid: AttachedFile[] = [];

    for (const f of newFiles) {
      if (f.size > MAX_FILE_SIZE) continue; // skip oversized
      valid.push({ id: `${f.name}-${f.size}-${Date.now()}`, name: f.name, size: f.size, type: f.type });
    }

    onFilesChange([...attachedFiles, ...valid]);
    // reset so same file can be re-added after removal
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const removeFile = (id: string) => {
    onFilesChange(attachedFiles.filter((f) => f.id !== id));
  };

  return (
    <div className="space-y-2">
      {/* File chips */}
      {attachedFiles.length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-1">
          {attachedFiles.map((f) => (
            <FileChip key={f.id} file={f} onRemove={() => removeFile(f.id)} />
          ))}
        </div>
      )}

      {/* Input row */}
      <div className="flex items-end gap-2 rounded-xl border border-border bg-background px-3 py-2.5 shadow-sm focus-within:ring-1 focus-within:ring-[#59AAF8]/40 transition-shadow">
        {/* Attach button */}
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={disabled}
          className="shrink-0 mb-0.5 rounded-md p-1 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-40"
          title="Attach file"
          aria-label="Attach file"
        >
          <Paperclip className="size-4" />
        </button>

        {/* Hidden real file input */}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={ACCEPTED_TYPES.join(",")}
          className="hidden"
          onChange={handleFileChange}
          aria-hidden="true"
          tabIndex={-1}
        />

        {/* Textarea */}
        <textarea
          ref={textareaRef}
          className="flex-1 resize-none bg-transparent text-sm outline-none placeholder:text-muted-foreground min-h-[20px] max-h-[140px] overflow-auto"
          placeholder={placeholder || "Message Emily..."}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKey}
          rows={1}
          disabled={disabled}
        />

        {/* Send button */}
        <Button
          size="sm"
          className="h-7 w-7 p-0 shrink-0 mb-0.5"
          onClick={onSubmit}
          disabled={(!value.trim() && attachedFiles.length === 0) || disabled}
          style={{ background: "#59AAF8", color: "white" }}
          type="button"
          aria-label="Send message"
        >
          <SendHorizonal className="size-3.5" />
        </Button>
      </div>
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
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([]);
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
      if (!content && attachedFiles.length === 0) return;
      setInput("");
      const files = [...attachedFiles];
      setAttachedFiles([]);

      const userMsg: Msg = {
        id: `u-${Date.now()}`,
        role: "user",
        text: content,
        ...(files.length > 0 ? { files } : {}),
      };
      setMessages((m) => [...m, userMsg]);
      setIsTyping(true);

      setTimeout(() => {
        const reply: Msg = {
          id: `a-${Date.now()}`,
          role: "assistant",
          parts: [
            {
              type: "text",
              text: content
                ? `Got it — "${content}". Give me a moment.`
                : `Got it — I'll look at ${files.length === 1 ? "that file" : "those files"} now.`,
            },
          ],
        };
        setMessages((m) => [...m, reply]);
        setIsTyping(false);
      }, 1200);
    },
    [input, attachedFiles]
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
          className="text-[10px] px-1.5 py-0.5 bg-green-500/10 text-green-600 border-green-500/20 shrink-0 font-normal"
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

      {/* Conversation */}
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
          <ConversationContent className="gap-5 py-5 px-4">
            {messages.map((msg) =>
              msg.role === "user" ? (
                <Message key={msg.id} from="user">
                  <MessageContent>
                    <div className="space-y-2">
                      {msg.text && (
                        <p className="whitespace-pre-wrap text-sm">{msg.text}</p>
                      )}
                      {msg.files && msg.files.length > 0 && (
                        <div className="flex flex-wrap gap-1.5 mt-1">
                          {msg.files.map((f) => (
                            <div
                              key={f.id}
                              className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-background/50 pl-2.5 pr-3 py-1 text-xs"
                            >
                              {getFileIcon(f.type)}
                              <span className="truncate max-w-[140px]">{f.name}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
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

            {/* Typing indicator */}
            {isTyping && (
              <Message from="assistant">
                <div className="flex items-start gap-2.5">
                  <EmilyAvatar size="sm" />
                  <MessageContent>
                    <div className="flex gap-1 py-1.5 px-1">
                      {[0, 1, 2].map((i) => (
                        <div
                          key={i}
                          className="size-1.5 rounded-full bg-muted-foreground/50 animate-bounce"
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

      {/* Suggestion pills — only when no messages */}
      {messages.length === 0 && (
        <div className="px-4 pb-3 flex flex-wrap gap-1.5">
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => sendMessage(s)}
              className="rounded-full border border-border bg-muted/40 px-3 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
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
          onFilesChange={setAttachedFiles}
          attachedFiles={attachedFiles}
          disabled={isTyping}
        />
        <p className="mt-1.5 text-center text-[10px] text-muted-foreground">
          Emily can make mistakes. Check important info.
        </p>
      </div>
    </div>
  );
}

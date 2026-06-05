"use client";

/**
 * /prototype — Emily chat prototype page
 *
 * Shows a simulated Workeros workers list on the left and the Emily rail on
 * the right. Uses REAL Vercel AI Elements:
 *   - Conversation + ConversationContent + ConversationScrollButton
 *   - Message + MessageContent + MessageResponse
 *   - Tool + ToolHeader + ToolContent + ToolInput + ToolOutput
 *   - Task (worker-creation steps)
 *
 * Mock data only — no backend wiring needed.
 */

import { EmilyRail } from "@/components/EmilyRail";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  Activity,
  Box,
  CheckCircle2,
  Clock,
  Plus,
  Sparkles,
  XCircle,
} from "lucide-react";

// ── Mock workers data ─────────────────────────────────────────────────────────

const MOCK_WORKERS = [
  {
    id: "1",
    name: "Weekly GitHub Digest",
    trigger: "Every Monday 9am",
    status: "healthy" as const,
    lastRun: "2h ago",
  },
  {
    id: "2",
    name: "Stripe Failure Monitor",
    trigger: "On webhook",
    status: "pending" as const,
    lastRun: "Waiting for approval",
  },
  {
    id: "3",
    name: "Daily Standup",
    trigger: "Every weekday 8:30am",
    status: "healthy" as const,
    lastRun: "4h ago",
  },
];

const MOCK_RECENT_RUNS = [
  { id: "r1", worker: "Weekly GitHub Digest", status: "success" as const, duration: "4.2s", ago: "2h ago" },
  { id: "r2", worker: "Daily Standup", status: "success" as const, duration: "1.1s", ago: "4h ago" },
  { id: "r3", worker: "Stripe Failure Monitor", status: "blocked" as const, duration: "n/a", ago: "Pending" },
];

// ── Workers list (left pane) ──────────────────────────────────────────────────

function WorkerRow({
  name,
  trigger,
  status,
  lastRun,
}: {
  name: string;
  trigger: string;
  status: "healthy" | "error" | "pending";
  lastRun: string;
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3 hover:bg-muted/30 transition-colors cursor-pointer">
      <div
        className={cn(
          "size-2 shrink-0 rounded-full",
          status === "healthy" ? "bg-green-500" : status === "error" ? "bg-red-500" : "bg-amber-400"
        )}
      />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium truncate">{name}</p>
        <p className="text-xs text-muted-foreground truncate">{trigger}</p>
      </div>
      <div className="text-right shrink-0">
        <p className="text-xs text-muted-foreground">{lastRun}</p>
        <Badge
          variant="secondary"
          className={cn(
            "text-[10px] px-1.5 py-0",
            status === "healthy"
              ? "bg-green-500/10 text-green-600"
              : status === "error"
              ? "bg-red-500/10 text-red-600"
              : "bg-amber-500/10 text-amber-600"
          )}
        >
          {status}
        </Badge>
      </div>
    </div>
  );
}

function RunRow({
  worker,
  status,
  duration,
  ago,
}: {
  worker: string;
  status: "success" | "error" | "blocked";
  duration: string;
  ago: string;
}) {
  return (
    <div className="flex items-center gap-3 px-1 py-2 text-sm border-b border-border last:border-0">
      {status === "success" ? (
        <CheckCircle2 className="size-4 text-green-600 shrink-0" />
      ) : status === "error" ? (
        <XCircle className="size-4 text-red-600 shrink-0" />
      ) : (
        <Clock className="size-4 text-amber-500 shrink-0" />
      )}
      <span className="flex-1 truncate text-sm">{worker}</span>
      <span className="text-xs text-muted-foreground shrink-0">{duration}</span>
      <span className="text-xs text-muted-foreground shrink-0">{ago}</span>
    </div>
  );
}

// ── Stats bar ─────────────────────────────────────────────────────────────────

function Stat({ label, value, icon: Icon }: { label: string; value: string | number; icon: React.ElementType }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-4 py-3">
      <Icon className="size-4 text-muted-foreground shrink-0" />
      <div>
        <p className="text-xs text-muted-foreground leading-none">{label}</p>
        <p className="text-lg font-semibold leading-tight">{value}</p>
      </div>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function PrototypePage() {
  return (
    <div className="flex h-full">
      {/* Left: main content */}
      <div className="flex-1 min-w-0 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-6 py-8 space-y-8">
          {/* Header */}
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-2xl font-semibold tracking-tight">Workers</h1>
                <Badge variant="outline" className="text-xs">3 active</Badge>
              </div>
              <p className="mt-1 text-sm text-muted-foreground">
                Your AI workers, running on triggers, schedules, and webhooks.
              </p>
            </div>
            <Button size="sm" className="gap-1.5 shrink-0">
              <Plus className="size-3.5" />
              New worker
            </Button>
          </div>

          {/* Stats */}
          <div className="grid grid-cols-3 gap-3">
            <Stat label="Workers" value={3} icon={Box} />
            <Stat label="Runs today" value={12} icon={Activity} />
            <Stat label="Pending" value={1} icon={Clock} />
          </div>

          {/* Workers list */}
          <div className="space-y-3">
            <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
              Active Workers
            </h2>
            {MOCK_WORKERS.map((w) => (
              <WorkerRow key={w.id} {...w} />
            ))}
          </div>

          {/* Recent runs */}
          <div className="space-y-2">
            <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
              Recent Runs
            </h2>
            <div className="rounded-lg border border-border bg-card px-4">
              {MOCK_RECENT_RUNS.map((r) => (
                <RunRow key={r.id} {...r} />
              ))}
            </div>
          </div>

          {/* Emily CTA (if rail is somehow hidden) */}
          <div className="rounded-lg border border-[#59AAF8]/30 bg-[#59AAF8]/5 p-4 flex items-start gap-3">
            <Sparkles className="size-4 text-[#59AAF8] mt-0.5 shrink-0" />
            <div>
              <p className="text-sm font-medium">Emily is ready</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Ask Emily in the chat to create workers, check runs, or connect services.
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Right: Emily rail — real AI Elements */}
      <EmilyRail />
    </div>
  );
}

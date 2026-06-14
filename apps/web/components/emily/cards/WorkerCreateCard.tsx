"use client";

import { CheckCircle2, Circle, Loader2, XCircle, Play, ExternalLink } from "lucide-react";
import { StatusPill } from "@/components/collection/StatusPill";
import { cn } from "@/lib/utils";
import type { WorkerCreateCard as WorkerCreateCardType } from "@/lib/emily-chat-types";

type StepStatus = "pending" | "running" | "completed" | "failed";

interface Step {
  key: string;
  label: string;
  status: StepStatus;
}

function stepStatusFromCard(card: WorkerCreateCardType): Step[] {
  const { step } = card;
  const order = ["drafting", "generating", "smoke", "ready"] as const;
  const idx = order.indexOf(step as (typeof order)[number]);

  return [
    { key: "drafting", label: "Drafting manifest", status: idx > 0 ? "completed" : idx === 0 ? "running" : "pending" },
    { key: "generating", label: "Generating code", status: idx > 1 ? "completed" : idx === 1 ? "running" : "pending" },
    { key: "smoke", label: "Running smoke test", status: idx > 2 ? (card.smokeStatus === "failed" ? "failed" : "completed") : idx === 2 ? "running" : "pending" },
    { key: "ready", label: "Worker ready", status: step === "ready" ? "completed" : step === "failed" ? "failed" : "pending" },
  ];
}

function StepRow({ status, label }: { status: StepStatus; label: string }) {
  return (
    <div className="flex items-center gap-2.5 py-0.5">
      {status === "completed" && <CheckCircle2 className="size-3.5 shrink-0 text-green-600" />}
      {status === "running" && <Loader2 className="size-3.5 shrink-0 text-[var(--accent)] animate-spin" />}
      {status === "failed" && <XCircle className="size-3.5 shrink-0 text-destructive" />}
      {status === "pending" && <Circle className="size-3.5 shrink-0 text-muted-foreground/40" />}
      <span
        className={cn(
          "text-xs",
          status === "completed" ? "text-foreground/80" : "text-muted-foreground",
          status === "running" ? "text-foreground font-medium" : ""
        )}
      >
        {label}
      </span>
    </div>
  );
}

export function WorkerCreateCard({ card }: { card: WorkerCreateCardType }) {
  const steps = stepStatusFromCard(card);
  const isReady = card.step === "ready";
  const isFailed = card.step === "failed";

  return (
    <div className="rounded-[var(--radius-ui)] bg-card/60 overflow-hidden text-sm">
      {/* Header */}
      <div className="flex items-center gap-2.5 px-3.5 py-2.5 [border-bottom:var(--bd-div)]/50">
        <span
          className="size-2 rounded-[var(--radius-ui)] shrink-0"
          style={{ background: "var(--accent)" }}
          aria-hidden="true"
        />
        <span className="font-medium flex-1 min-w-0 truncate">{card.workerName}</span>
        {isReady && <StatusPill spec={{ tone: "ok", label: "Ready" }} />}
        {isFailed && <StatusPill spec={{ tone: "err", label: "Failed" }} />}
      </div>

      {/* Steps */}
      <div className="px-3.5 py-2.5 space-y-0.5">
        {steps.map((s) => (
          <StepRow key={s.key} status={s.status} label={s.label} />
        ))}
        {card.smokeStatus === "failed" && card.smokeReason && (
          <p className="text-xs text-destructive mt-1.5 pl-6">{card.smokeReason}</p>
        )}
      </div>

      {/* Actions */}
      {isReady && card.actions && card.actions.length > 0 && (
        <div className="flex gap-2 px-3.5 pb-3">
          {card.actions.map((action) => (
            <a
              key={action.id}
              href={action.href}
              className="inline-flex h-7 items-center gap-1.5 rounded-[var(--radius-ui)] bg-background px-2.5 text-xs font-normal text-foreground hover:bg-[var(--active-nav-bg)] transition-colors"
            >
              {action.id === "run_worker" && <Play className="size-3" />}
              {action.id === "open_worker" && <ExternalLink className="size-3" />}
              {action.label ?? action.id}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

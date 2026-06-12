"use client";

import { CheckCircle2, Loader2, XCircle, FileText, ExternalLink, Clock } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { RunCard as RunCardType } from "@/lib/emily-chat-types";

export function RunCard({ card }: { card: RunCardType }) {
  const { status, workerName, duration, logLines, artifact, actions } = card;
  const isRunning = status === "running" || status === "queued" || status === "starting";
  const isCompleted = status === "completed";
  const isFailed = status === "failed";
  const isPending = status === "pending_approval";

  return (
    <div className="rounded-[var(--radius-card)] [border:var(--bd-card)] bg-card/60 overflow-hidden text-sm">
      <div className="flex items-center gap-2.5 px-3.5 py-2.5">
        {isCompleted && <CheckCircle2 className="size-3.5 shrink-0 text-green-600" />}
        {isRunning && <Loader2 className="size-3.5 shrink-0 text-[#59AAF8] animate-spin" />}
        {isFailed && <XCircle className="size-3.5 shrink-0 text-destructive" />}
        {isPending && <Clock className="size-3.5 shrink-0 text-amber-600" />}

        <span className="font-medium flex-1 min-w-0 truncate">{workerName}</span>

        {duration && isCompleted && (
          <span className="text-xs text-muted-foreground shrink-0">{duration}</span>
        )}
        {isPending && (
          <Badge variant="secondary" className="text-[10px] px-1.5 py-0.5 bg-amber-500/10 text-amber-700 [border:var(--bd-pill)] font-normal">
            Needs approval
          </Badge>
        )}
        {isRunning && (
          <Badge variant="secondary" className="text-[10px] px-1.5 py-0.5 bg-blue-500/10 text-blue-700 [border:var(--bd-pill)] font-normal">
            Running
          </Badge>
        )}
      </div>

      {(logLines !== undefined || artifact) && (
        <div className="px-3.5 pb-2.5 space-y-2">
          {logLines !== undefined && (
            <p className="text-xs text-muted-foreground">{logLines} log lines</p>
          )}
          {artifact && (
            <div className="flex items-center gap-2 rounded-md bg-muted/50 px-2.5 py-1.5">
              <FileText className="size-3.5 text-muted-foreground shrink-0" />
              <span className="text-xs font-mono flex-1 min-w-0 truncate text-foreground/80">
                {artifact.name}
              </span>
              {actions?.find((a) => a.id === "download") && (
                <a
                  href={actions.find((a) => a.id === "download")!.href}
                  download
                  className="inline-flex h-5 w-5 shrink-0 ml-auto items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                >
                  <ExternalLink className="size-3" />
                </a>
              )}
            </div>
          )}
        </div>
      )}

      {actions && actions.filter((a) => a.id !== "download").length > 0 && (
        <div className="flex gap-2 px-3.5 pb-3">
          {actions.filter((a) => a.id !== "download").map((action) => (
            <a
              key={action.id}
              href={action.href}
              className="inline-flex h-7 items-center rounded-md [border:var(--bd-card)] bg-background px-2.5 text-xs font-normal text-foreground hover:bg-accent transition-colors"
            >
              {action.label ?? action.id}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

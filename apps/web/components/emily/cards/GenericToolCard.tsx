import { Loader2, CheckCircle2, XCircle, Wrench } from "lucide-react";
import { cn } from "@/lib/utils";
import type { GenericToolCard as GenericToolCardType } from "@/lib/emily-chat-types";

export function GenericToolCard({ card }: { card: GenericToolCardType }) {
  const { status, title, isError } = card;
  const isRunning = status === "running" || status === "starting";
  const isDone = status === "completed";
  const isFailed = status === "failed" || isError;

  return (
    <div className="rounded-lg border border-border bg-muted/30 px-3.5 py-2.5 text-sm flex items-center gap-2.5">
      {isRunning && <Loader2 className="size-3.5 shrink-0 text-[#59AAF8] animate-spin" />}
      {isDone && <CheckCircle2 className="size-3.5 shrink-0 text-green-600" />}
      {isFailed && <XCircle className="size-3.5 shrink-0 text-destructive" />}
      {!isRunning && !isDone && !isFailed && <Wrench className="size-3.5 shrink-0 text-muted-foreground" />}
      <span className={cn("text-xs", isFailed ? "text-destructive" : "text-muted-foreground")}>
        {title}
      </span>
    </div>
  );
}

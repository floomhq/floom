import { Clock, ExternalLink, Loader2, CheckCircle2, XCircle, Wrench } from "lucide-react";
import { cn } from "@/lib/utils";
import type { GenericToolCard as GenericToolCardType } from "@/lib/emily-chat-types";

export function GenericToolCard({ card }: { card: GenericToolCardType }) {
  const { status, title, isError, actions } = card;
  const isRunning = status === "running" || status === "starting";
  const isDone = status === "completed";
  const isFailed = status === "failed" || isError;
  const isPending = status === "pending_approval";

  return (
    <div className="rounded-lg border border-border bg-muted/30 px-3.5 py-2.5 text-sm">
      <div className="flex items-center gap-2.5">
        {isRunning && <Loader2 className="size-3.5 shrink-0 animate-spin text-[#59AAF8]" />}
        {isDone && <CheckCircle2 className="size-3.5 shrink-0 text-green-600" />}
        {isFailed && <XCircle className="size-3.5 shrink-0 text-destructive" />}
        {isPending && <Clock className="size-3.5 shrink-0 text-amber-600" />}
        {!isRunning && !isDone && !isFailed && (
          <Wrench className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <span
          className={cn(
            "text-xs",
            isFailed ? "text-destructive" : isPending ? "text-amber-700" : "text-muted-foreground"
          )}
        >
          {title}
        </span>
      </div>
      {actions && actions.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {actions.map((action) =>
            action.method === "GET" ? (
              <a
                key={action.id}
                href={action.href}
                className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-[11px] font-medium text-foreground hover:bg-accent transition-colors"
              >
                {action.label ?? action.id}
                <ExternalLink className="size-3" />
              </a>
            ) : (
              <span
                key={action.id}
                className="inline-flex items-center rounded-md border border-border bg-background px-2 py-1 text-[11px] text-muted-foreground"
              >
                {action.label ?? action.id}
                {action.method ? ` ${action.method}` : ""}
              </span>
            )
          )}
        </div>
      )}
    </div>
  );
}

import { Box, ExternalLink, Play } from "lucide-react";
import { cn } from "@/lib/utils";
import type { WorkerListCard as WorkerListCardType } from "@/lib/emily-chat-types";

export function WorkerListCard({ card }: { card: WorkerListCardType }) {
  const { workers } = card;
  if (!workers || workers.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-card/60 px-3.5 py-3 text-xs text-muted-foreground">
        No workers found.
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border bg-card/60 overflow-hidden text-sm">
      <div className="flex items-center gap-2 px-3.5 py-2.5 border-b border-border/50">
        <Box className="size-3.5 text-muted-foreground" />
        <span className="font-medium text-xs text-muted-foreground uppercase tracking-wide">
          Workers ({workers.length})
        </span>
      </div>
      <ul className="divide-y divide-border/50">
        {workers.map((w) => (
          <li key={w.id} className="flex items-center gap-2.5 px-3.5 py-2">
            <span
              className={cn(
                "size-1.5 rounded-full shrink-0",
                w.enabled ? "bg-green-500" : "bg-muted-foreground/30"
              )}
              aria-hidden="true"
            />
            <span className="flex-1 min-w-0">
              <span className="font-medium truncate block">{w.name}</span>
              {w.trigger && (
                <span className="text-[11px] text-muted-foreground">{w.trigger}</span>
              )}
            </span>
            <div className="flex gap-1 shrink-0">
              {/* Worker detail opens in the Workers split pane. */}
              <a
                href={`/workers?sel=${encodeURIComponent(w.id)}`}
                title="Run"
                className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
              >
                <Play className="size-3" />
              </a>
              <a
                href={`/workers?sel=${encodeURIComponent(w.id)}`}
                title="Open"
                className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
              >
                <ExternalLink className="size-3" />
              </a>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

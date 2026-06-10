import { ExternalLink } from "lucide-react";
import type { GenericToolCard as GenericToolCardType } from "@/lib/emily-chat-types";
import { Tool } from "@/components/ai-elements/tool";

// #825: tool calls render with the EXISTING collapsible ai-elements/tool.tsx
// (click → args/result/status) — the same component run details use — instead
// of a flat one-line card.
export function GenericToolCard({ card }: { card: GenericToolCardType }) {
  const { status, title, toolName, preview, isError, callId, actions } = card;
  const isFailed = status === "failed" || isError;
  // result is undefined while the tool is still in flight (running/starting/
  // pending) → the collapsible shows the in-flight "called" state and defaults open.
  const inFlight = status === "running" || status === "starting" || status === "pending_approval";
  const result = inFlight ? undefined : preview;

  return (
    <div className="space-y-2">
      <Tool name={title || toolName} result={result} isError={isFailed} callId={callId} />
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

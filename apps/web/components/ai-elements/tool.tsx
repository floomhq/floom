"use client";

// Inspired by Vercel AI Elements. MIT License.

import { ChevronDown, Hammer, XCircle } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

export function Tool({
  name,
  args,
  result,
  isError = false,
  callId,
  className,
}: {
  name: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
  callId?: string;
  className?: string;
}) {
  const state = result === undefined ? "called" : isError ? "error" : "done";
  return (
    <Collapsible defaultOpen={state !== "done"}>
      <div className={cn("rounded-md border border-border bg-card", className)}>
        <CollapsibleTrigger className="group flex w-full items-center justify-between gap-3 px-3 py-2 text-left">
          <div className="flex min-w-0 items-center gap-2">
            {isError ? (
              <XCircle className="size-4 shrink-0 text-error" />
            ) : (
              <Hammer className="size-4 shrink-0 text-muted-foreground" />
            )}
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{name}</p>
              {callId && <p className="truncate font-mono text-[11px] text-muted-foreground">{callId}</p>}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <span
              className={cn(
                "rounded border px-1.5 py-0.5 text-[11px] font-medium",
                state === "error"
                  ? "border-error/30 bg-error/10 text-error"
                  : state === "done"
                    ? "border-success/30 bg-success/10 text-success"
                    : "border-pending/30 bg-pending/10 text-pending",
              )}
            >
              {state}
            </span>
            <ChevronDown className="size-4 text-muted-foreground transition-transform group-data-[panel-open]:rotate-180" />
          </div>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="space-y-3 border-t border-border p-3">
            <ToolBlock label="Args" value={args} />
            {result !== undefined && <ToolBlock label={isError ? "Error" : "Result"} value={result} />}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

function ToolBlock({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="space-y-1">
      <p className="text-[11px] font-medium uppercase text-muted-foreground">{label}</p>
      <pre className="max-h-[280px] overflow-auto rounded-sm bg-muted p-2 font-mono text-xs leading-relaxed">
        {formatValue(value)}
      </pre>
    </div>
  );
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value ?? {}, null, 2);
  } catch {
    return String(value);
  }
}

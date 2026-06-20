"use client";

// Inspired by Vercel AI Elements. MIT License.

import { useState } from "react";
import type { ReactNode } from "react";
import { ChevronDown, Hammer, XCircle, Maximize2, Minimize2, Copy, Check } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

export function Tool({
  name,
  args,
  result,
  isError = false,
  callId,
  status,
  duration,
  className,
  children,
}: {
  name: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
  callId?: string;
  status?: string;
  duration?: string;
  className?: string;
  children?: ReactNode;
}) {
  const normalizedStatus = normalizeStatus(status);
  const state = normalizedStatus ?? (result === undefined && !children ? "called" : isError ? "error" : "done");
  const displayState = status ? humanizeStatus(status) : state;
  const showState = Boolean(status) || state !== "done";
  return (
    <Collapsible defaultOpen={false}>
      <div className={cn("rounded-[var(--radius-card)] bg-[var(--bg-2)] shadow-[var(--shadow-card)]", className)}>
        <CollapsibleTrigger className="group flex w-full items-center gap-2.5 px-3 py-2 text-left">
          {/* Status icon — error gets a red X, running gets a muted hammer, done gets nothing */}
          {isError ? (
            <XCircle className="size-3.5 shrink-0 text-destructive" />
          ) : state === "called" ? (
            <Hammer className="size-3.5 shrink-0 text-muted-foreground/60 animate-pulse" />
          ) : (
            <Hammer className="size-3.5 shrink-0 text-muted-foreground/40" />
          )}
          <span className="flex-1 min-w-0 truncate text-xs font-medium text-[var(--ink-soft)]">{name}</span>
          <div className="flex shrink-0 items-center gap-1.5">
            {duration && (
              <span className="text-[10.5px] text-muted-foreground/60 tabular-nums">{duration}</span>
            )}
            {/* Status pill: only show when not silently "done" — error and in-flight states need a label */}
            {showState && (
              <span
                className={cn(
                  "rounded-[var(--radius-pill)] px-1.5 py-0.5 text-[10.5px] font-medium leading-none",
                  state === "error"
                    ? "bg-destructive/10 text-destructive"
                    : state === "done"
                      ? "bg-[var(--bg-3)] text-muted-foreground"
                      : "bg-[var(--accent)]/10 text-[var(--accent)]",
                )}
              >
                {displayState}
              </span>
            )}
            <ChevronDown className="size-3.5 text-muted-foreground/50 transition-transform duration-150 group-data-[panel-open]:rotate-180" />
          </div>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="space-y-3 px-3 pb-3 pt-0">
            <div className="h-px bg-[var(--border-default)] opacity-50" />
            {args !== undefined && <ToolBlock label="Args" value={args} />}
            {result !== undefined && <ToolBlock label={isError ? "Error" : "Result"} value={result} />}
            {children}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

function normalizeStatus(status: string | undefined): "called" | "done" | "error" | undefined {
  if (!status) return undefined;
  const normalized = status.toLowerCase();
  if (normalized === "completed" || normalized === "ready" || normalized === "succeeded" || normalized === "done") {
    return "done";
  }
  if (normalized === "failed" || normalized === "error" || normalized === "cancelled") return "error";
  return "called";
}

function humanizeStatus(status: string): string {
  return status.replace(/[_-]+/g, " ");
}

function ToolBlock({ label, value }: { label: string; value: unknown }) {
  // S29k (Q3 Codex verdict): Tool input/output payloads were visually capped
  // at max-h-280 with no escape. the operator needs the full payload for
  // debugging. Now: Expand button removes the cap; Copy lifts the formatted
  // value to clipboard so users can paste into a diff tool.
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const formatted = formatValue(value);
  const handleCopy = () => {
    navigator.clipboard.writeText(formatted).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
  };
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] font-medium uppercase text-muted-foreground">{label}</p>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={handleCopy}
            className="inline-flex h-6 items-center gap-1 rounded px-1.5 text-[11px] text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            aria-label="Copy"
          >
            {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
            {copied ? "Copied" : "Copy"}
          </button>
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="inline-flex h-6 items-center gap-1 rounded px-1.5 text-[11px] text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            aria-label={expanded ? "Collapse" : "Expand"}
          >
            {expanded ? <Minimize2 className="size-3" /> : <Maximize2 className="size-3" />}
            {expanded ? "Collapse" : "Expand"}
          </button>
        </div>
      </div>
      <pre
        className={cn(
          "overflow-auto rounded-[var(--radius-button)] bg-muted p-2 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words",
          expanded ? "max-h-none" : "max-h-[280px]",
        )}
      >
        {formatted}
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

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
      <div className={cn("rounded-[var(--radius-button)] [border:var(--bd-card)] bg-card", className)}>
        <CollapsibleTrigger className="group flex w-full items-center justify-between gap-3 px-3 py-2 text-left">
          <div className="flex min-w-0 items-center gap-2">
            {isError ? (
              <XCircle className="size-4 shrink-0 text-error" />
            ) : (
              <Hammer className="size-4 shrink-0 text-muted-foreground" />
            )}
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{name}</p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {duration && <span className="text-[11px] text-muted-foreground">{duration}</span>}
            {/* S29l (ChatGPT-audit): "done" pill is decoration once the
                Hammer icon + (in failure case) XCircle already signal state.
                Show it again only when callers pass an explicit status because
                chat tool cards need status parity with run details. */}
            {showState && (
              <span
                className={cn(
                  "rounded-[var(--radius-button)] [border:var(--bd-pill)] px-1.5 py-0.5 text-[11px] font-medium",
                  state === "error"
                    ? "bg-error/10 text-error"
                    : state === "done"
                      ? "bg-muted/50 text-muted-foreground"
                      : "bg-pending/10 text-pending",
                )}
              >
                {displayState}
              </span>
            )}
            <ChevronDown className="size-4 text-muted-foreground transition-transform group-data-[panel-open]:rotate-180" />
          </div>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="space-y-3 [border-top:var(--bd-div)] p-3">
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

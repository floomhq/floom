"use client";

// Inspired by AI Elements. MIT License.

import { TerminalSquare } from "lucide-react";
import { cn } from "@/lib/utils";

// S28: theme-aware Terminal. Was bg-[#111] always (looked broken in light
// mode against warm matte background). Now uses bg-[var(--bg-2)] in light
// + bg-[#0d0d0d] in dark via dark: variant. Text colors follow.
export function Terminal({
  lines,
  className,
}: {
  lines: Array<{ level?: string; message: string; timestamp?: string }>;
  className?: string;
}) {
  return (
    <div className={cn(
      "overflow-hidden rounded-[var(--radius-button)] [border:var(--bd-card)] bg-[var(--bg-2)] text-foreground",
      "dark:bg-[#0d0d0d] dark:text-[#e8e8e8]",
      className,
    )}>
      <div className="flex items-center gap-2 [border-bottom:var(--bd-div)] px-3 py-2 text-xs text-muted-foreground dark:text-white/70">
        <TerminalSquare className="size-3.5" />
        Logs
      </div>
      <pre className="max-h-[520px] overflow-auto p-3 font-mono text-xs leading-relaxed">
        {lines.length === 0
          ? "$ waiting for logs"
          : lines.map((line, index) => (
              <div
                key={`${line.timestamp || "line"}-${index}`}
                className={line.level === "error" ? "text-red-700 dark:text-[#ffb4a8]" : ""}
              >
                <span className="text-muted-foreground dark:text-white/35">
                  {line.timestamp ? `[${new Date(line.timestamp).toLocaleTimeString()}]` : "$"}
                </span>{" "}
                <span>{line.message}</span>
              </div>
            ))}
      </pre>
    </div>
  );
}

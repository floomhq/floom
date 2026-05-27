"use client";

// Inspired by Vercel AI Elements. MIT License.

import { TerminalSquare } from "lucide-react";
import { cn } from "@/lib/utils";

export function Terminal({
  lines,
  className,
}: {
  lines: Array<{ level?: string; message: string; timestamp?: string }>;
  className?: string;
}) {
  return (
    <div className={cn("overflow-hidden rounded-md border border-border bg-[#111] text-[#e8e8e8]", className)}>
      <div className="flex items-center gap-2 border-b border-white/10 px-3 py-2 text-xs text-white/70">
        <TerminalSquare className="size-3.5" />
        Logs
      </div>
      <pre className="max-h-[520px] overflow-auto p-3 font-mono text-xs leading-relaxed">
        {lines.length === 0
          ? "$ waiting for logs"
          : lines.map((line, index) => (
              <div key={`${line.timestamp || "line"}-${index}`} className={line.level === "error" ? "text-[#ffb4a8]" : ""}>
                <span className="text-white/35">{line.timestamp ? `[${new Date(line.timestamp).toLocaleTimeString()}]` : "$"}</span>{" "}
                <span>{line.message}</span>
              </div>
            ))}
      </pre>
    </div>
  );
}

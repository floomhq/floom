"use client";

// Inspired by Vercel AI Elements. MIT License.

import { AlertTriangle } from "lucide-react";

export function StackTrace({ error }: { error?: string | null }) {
  if (!error) {
    return <p className="text-sm text-muted-foreground">No error recorded.</p>;
  }
  const lines = error.split("\n");
  return (
    <div className="overflow-hidden rounded-[var(--radius-ui)] bg-error/10">
      <div className="flex items-center gap-2 [border-bottom:var(--bd-div)] px-3 py-2 text-sm font-medium text-error">
        <AlertTriangle className="size-4" />
        Error
      </div>
      <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-xs leading-relaxed text-error">
        {lines.map((line, index) => (
          <div key={`${index}-${line.slice(0, 20)}`}>{line}</div>
        ))}
      </pre>
    </div>
  );
}

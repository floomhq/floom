"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { FileCode, FileText } from "lucide-react";

// PR S11: execution mode is derived from which entry file lives in the
// bundle (`SKILL.md` -> agent, `run.py` -> script). There is no longer a
// separate `mode:` field in the worker manifest. This component shows the
// detected entry point read-only so the edit page is unambiguous.

export type ExecMode = "agent" | "pure-script";

export type DetectedEntry = "SKILL.md" | "run.py" | "none";

interface ExecModePickerProps {
  // Detected from the files list. When both SKILL.md and run.py exist,
  // agent wins (parent component is responsible for that call).
  detectedEntry: DetectedEntry;
}

export function ExecModePicker({ detectedEntry }: ExecModePickerProps) {
  const isAgent = detectedEntry === "SKILL.md";
  const isScript = detectedEntry === "run.py";

  return (
    <Card className="border-border shadow-none bg-card">
      <CardHeader>
        <CardTitle className="text-sm font-medium">Entry point</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <p className="text-xs text-muted-foreground">
          The worker mode is inferred from the entry file in your bundle.
          Add a SKILL.md to run as an agent; add a run.py to run as a script.
        </p>
        <div
          className={`flex items-start gap-3 rounded-[var(--radius-button)] border px-3 py-2.5 ${
            isAgent ? "border-[var(--accent)] bg-muted/50" : "border-line opacity-60"
          }`}
        >
          <FileText className="w-4 h-4 mt-0.5 text-muted-foreground" />
          <div>
            <p className="text-sm font-medium text-foreground">
              Agent (SKILL.md)
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Platform runs an LLM tool loop with web_search, file tools, and your connections.
            </p>
          </div>
        </div>
        <div
          className={`flex items-start gap-3 rounded-[var(--radius-button)] border px-3 py-2.5 ${
            isScript ? "border-[var(--accent)] bg-muted/50" : "border-line opacity-60"
          }`}
        >
          <FileCode className="w-4 h-4 mt-0.5 text-muted-foreground" />
          <div>
            <p className="text-sm font-medium text-foreground">
              Script (run.py)
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Platform executes run.py in an E2B sandbox. Use any libraries you need.
            </p>
          </div>
        </div>
        {detectedEntry === "none" && (
          <p className="rounded-[var(--radius-button)] border border-[color-mix(in_srgb,var(--warning)_28%,var(--line))] bg-[color-mix(in_srgb,var(--warning)_12%,transparent)] px-3 py-2 text-xs text-[var(--warning)]">
            Add SKILL.md (agent) or run.py (script) to the file list to set the entry point.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

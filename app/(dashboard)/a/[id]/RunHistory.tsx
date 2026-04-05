"use client";

import { useState } from "react";
import { StatusDot } from "@/components/ui/StatusDot";
import { ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "@/lib/utils";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";

type Run = {
  _id: string;
  status: "pending" | "running" | "success" | "error" | "timeout";
  startedAt: number;
  durationMs: number | null;
  triggeredBy: string;
  version: number;
  outputs: unknown;
  inputs: unknown;
  errorType: string | null;
  error: string | null;
};

export function RunHistory({
  runs,
  onSelectRun,
}: {
  runs: Run[];
  onSelectRun: (runId: string) => void;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  const displayed = showAll ? runs : runs.slice(0, 5);

  if (runs.length === 0) return null;

  return (
    <div className="px-4 pb-4">
      <div className="flex items-center justify-between py-2">
        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
          Run History
        </h3>
        {runs.length > 5 && (
          <Button
            variant="link"
            size="xs"
            onClick={() => setShowAll(!showAll)}
          >
            {showAll ? "Show less" : `Show all ${runs.length}`}
          </Button>
        )}
      </div>

      <div className="space-y-1">
        {displayed.map((run) => (
          <Card key={run._id} size="sm" className="py-0 gap-0">
            <div
              className="flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-muted/50 text-sm transition-colors"
              onClick={() => {
                onSelectRun(run._id);
                setExpanded(expanded === run._id ? null : run._id);
              }}
            >
              <StatusDot status={run.status} />
              <span className="text-muted-foreground text-xs w-32 shrink-0">
                {formatDate(run.startedAt)}
              </span>
              <Badge variant="secondary">v{run.version}</Badge>
              <span className="text-xs text-muted-foreground flex-1">
                {run.triggeredBy === "schedule"
                  ? "schedule"
                  : run.triggeredBy}
              </span>
              {run.durationMs != null && (
                <span className="text-xs text-muted-foreground/60">
                  {run.durationMs < 1000
                    ? `${run.durationMs}ms`
                    : `${(run.durationMs / 1000).toFixed(1)}s`}
                </span>
              )}
              {expanded === run._id ? (
                <ChevronUp className="size-3.5 text-muted-foreground" />
              ) : (
                <ChevronDown className="size-3.5 text-muted-foreground" />
              )}
            </div>

            {expanded === run._id && (
              <>
                <Separator />
                <div className="px-3 py-3 space-y-2 text-xs">
                  <div>
                    <p className="font-medium text-muted-foreground mb-1">
                      Inputs
                    </p>
                    <pre className="bg-muted p-2 rounded text-muted-foreground overflow-x-auto">
                      {JSON.stringify(run.inputs, null, 2)}
                    </pre>
                  </div>

                  {run.status === "success" && Boolean(run.outputs) && (
                    <OutputSummary outputs={run.outputs} />
                  )}

                  {run.status !== "success" && run.error && (
                    <div>
                      <p className="font-medium text-muted-foreground mb-1">
                        Error
                      </p>
                      <pre className="bg-destructive/5 p-2 rounded text-destructive overflow-x-auto max-h-32">
                        {run.error}
                      </pre>
                    </div>
                  )}
                </div>
              </>
            )}
          </Card>
        ))}
      </div>
    </div>
  );
}

function OutputSummary({ outputs }: { outputs: unknown }) {
  const obj = outputs as Record<string, unknown>;
  const entries = Object.entries(obj);

  return (
    <div>
      <p className="font-medium text-muted-foreground mb-1">Output summary</p>
      {entries.map(([key, value]) => {
        if (Array.isArray(value)) {
          return (
            <p key={key} className="text-muted-foreground">
              {key}: {value.length} rows
            </p>
          );
        }
        return (
          <p key={key} className="text-muted-foreground">
            {key}: {String(value)}
          </p>
        );
      })}
    </div>
  );
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

"use client";

// RIGHT PANE — generic run result panel with three states:
//   idle   — quiet placeholder ("Provide input and run")
//   running — live steps from useRunStream (reuses the same TranscriptView
//             primitives that /runs/[id] and /workers/[id] use)
//   done    — run output via OutputRenderer per declared type
//
// This component owns NO worker-specific styling. It is driven purely by the
// real run stream hook and the generic output renderer.
import { useEffect, useState } from "react";
import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { OutputRenderer } from "@/components/output-renderer";
import { GenericOutput } from "@/components/generic-output";
import { RunStatusBadge } from "@/components/RunStatus";
import { Task } from "@/components/ai-elements/task";
import { Tool } from "@/components/ai-elements/tool";
import { StackTrace } from "@/components/ai-elements/stack-trace";
import { useRunStream } from "@/lib/useRunStream";
import { api } from "@/lib/api";
import { humanizeRunError } from "@/lib/run-format";
import { stripCitationTokens } from "@/lib/strip-citations";
import type { RunDetail, RunPart } from "@/lib/types";

// Infer output type from a raw value when no schema is declared.
function inferOutputType(value: unknown): string {
  if (typeof value === "object" && value !== null) return "json";
  if (typeof value === "string") {
    const t = value.trim();
    if (
      (t.startsWith("{") && t.endsWith("}")) ||
      (t.startsWith("[") && t.endsWith("]"))
    )
      return "json";
    if (/^#{1,3}\s|\n[-*]\s|\|.+\|/.test(t)) return "markdown";
    return "text";
  }
  return "text";
}

// Humanize an input key for display.
function humanizeKey(key: string): string {
  return key
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// ---- Idle placeholder ----

function IdlePlaceholder() {
  return (
    <div className="flex h-full min-h-[240px] items-center justify-center">
      <p className="text-sm text-muted-foreground select-none">
        Provide input and run
      </p>
    </div>
  );
}

// ---- Streaming transcript (reuses RunDetailSplitPane primitives) ----

function LiveTranscript({
  runId,
  parts,
  run,
  connected,
  streamError,
  streamUnavailable,
  onRefresh,
}: {
  runId: string;
  parts: RunPart[];
  run: RunDetail | null;
  connected: boolean;
  streamError: string | null;
  streamUnavailable: boolean;
  onRefresh: () => void;
}) {
  const status = run?.status ?? "running";
  const isActive = status === "running" || status === "queued";

  if (parts.length === 0 && isActive) {
    return (
      <div className="space-y-3">
        <Task title="Starting" status="pending" detail="Waiting for the first step..." />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Status + stream indicator */}
      <div className="flex items-center gap-2">
        {run && <RunStatusBadge status={status} />}
        {connected && (
          <span className="text-xs text-muted-foreground">Live</span>
        )}
        {streamError && !streamUnavailable && (
          <span className="text-xs text-destructive">{streamError}</span>
        )}
      </div>

      {streamUnavailable && isActive && (
        <div className="flex flex-wrap items-start justify-between gap-3 rounded-[var(--radius-button)] bg-[color-mix(in_srgb,var(--warning)_8%,transparent)] px-4 py-3">
          <p className="text-sm text-[var(--ink)]">
            {streamError || "Stream connection dropped. Refresh to re-check."}
          </p>
          <Button variant="outline" size="sm" onClick={onRefresh}>
            <RotateCcw className="size-3.5 mr-1.5" />
            Refresh
          </Button>
        </div>
      )}

      {/* Parts (same rendering as RunDetailSplitPane TranscriptView) */}
      {parts.map((part, index) => {
        if (part.type === "tool-result") return null;
        if (part.type === "tool-call") {
          const result = parts.find(
            (
              candidate,
            ): candidate is Extract<RunPart, { type: "tool-result" }> =>
              candidate.type === "tool-result" &&
              candidate.callId === part.callId,
          );
          return (
            <Tool
              key={`${part.callId}-${index}`}
              name={part.toolName}
              args={part.args}
              callId={part.callId}
              result={result?.result}
              isError={Boolean(result?.isError)}
            />
          );
        }
        if (part.type === "text" || part.type === "reasoning") {
          return (
            <div
              key={`${part.type}-${index}`}
              className="rounded-[var(--radius-button)] bg-muted/40 p-3"
            >
              <p className="mb-1 text-[11px] font-medium uppercase text-muted-foreground">
                {part.type === "reasoning" ? "Reasoning" : "Text"}
              </p>
              <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">
                {stripCitationTokens(part.text)}
              </p>
            </div>
          );
        }
        if (part.type === "step-start") {
          return (
            <Task
              key={`step-${part.stepNumber}-${index}`}
              title={`Step ${part.stepNumber}`}
              status={
                status === "failed"
                  ? "failed"
                  : status === "completed"
                    ? "completed"
                    : "running"
              }
            />
          );
        }
        if (part.type === "finish") {
          if (part.status === "completed") {
            return (
              <Task key={`finish-${index}`} title="Finished" status="completed" />
            );
          }
          if (part.status === "pending_approval") {
            return (
              <Task
                key={`finish-${index}`}
                title="Awaiting approval"
                status="pending"
                detail="This run is waiting for your decision."
              />
            );
          }
          return (
            <StackTrace
              key={`finish-${index}`}
              error={
                run?.error ||
                humanizeRunError(part.error) ||
                "Run failed"
              }
            />
          );
        }
        return null;
      })}

      {/* Trailing error when run failed but no finish part arrived */}
      {status === "failed" &&
        !parts.some((p) => p.type === "finish") &&
        run?.error && <StackTrace error={run.error} />}
    </div>
  );
}

// ---- Done: output via the GENERIC renderer ----

function DoneOutput({ run }: { run: RunDetail }) {
  if (run.status === "failed") {
    return <StackTrace error={run.error} />;
  }
  const hasSchema = run.output_schema && run.output_schema.length > 0;
  const hasRaw = Object.keys(run.output || {}).length > 0;

  if (hasSchema) {
    return (
      <div className="space-y-6">
        {run.output_schema.map((field) => (
          <OutputRenderer key={field.name} field={field} runId={run.id} />
        ))}
      </div>
    );
  }
  if (hasRaw) {
    return (
      <div className="space-y-4">
        {Object.entries(run.output).map(([key, value]) => (
          <div key={key} className="space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground">
              {humanizeKey(key)}
            </p>
            <GenericOutput type={inferOutputType(value)} value={value} />
          </div>
        ))}
      </div>
    );
  }
  return (
    <p className="text-sm text-muted-foreground">
      Run completed with no structured output.
    </p>
  );
}

// ---- Public export ----

interface RunPanelProps {
  /** null = idle; non-null = attach stream */
  runId: string | null;
}

export function RunPanel({ runId }: RunPanelProps) {
  const { parts, fallbackRun, connected, error, finishedPart, streamUnavailable, refresh } =
    useRunStream(runId);

  const [run, setRun] = useState<RunDetail | null>(null);

  // Load the run detail when we have an ID or when fallbackRun is updated by the
  // stream hook.
  useEffect(() => {
    if (fallbackRun) {
      setRun(fallbackRun);
    }
  }, [fallbackRun]);

  useEffect(() => {
    if (!runId) {
      setRun(null);
      return;
    }
    let cancelled = false;
    api.runs.get(runId).then(
      (detail) => {
        if (!cancelled) setRun(detail);
      },
      () => {/* swallow initial fetch errors — stream hook covers the error UI */},
    );
    return () => {
      cancelled = true;
    };
  }, [runId]);

  // Re-fetch run after stream finishes so we have the final output.
  useEffect(() => {
    if (!finishedPart || !runId) return;
    let cancelled = false;
    api.runs.get(runId).then(
      (detail) => {
        if (!cancelled) setRun(detail);
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [finishedPart, runId]);

  // Idle
  if (!runId) {
    return <IdlePlaceholder />;
  }

  const status = run?.status ?? "running";
  const isTerminal = status === "completed" || status === "failed";

  // Done
  if (isTerminal && run) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <RunStatusBadge status={status} />
          {run.worker_name && (
            <span className="text-sm text-muted-foreground">
              {run.worker_name}
            </span>
          )}
        </div>
        <DoneOutput run={run} />
      </div>
    );
  }

  // Running (or queued)
  return (
    <LiveTranscript
      runId={runId}
      parts={parts}
      run={run}
      connected={connected}
      streamError={error}
      streamUnavailable={streamUnavailable}
      onRefresh={refresh}
    />
  );
}

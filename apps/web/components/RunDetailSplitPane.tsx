"use client";

import Link from "next/link";
import { Copy, Download, Pencil, RotateCcw, Square } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { RunStatusBadge, RunStatusGlyph } from "@/components/RunStatus";
import { Tool } from "@/components/ai-elements/tool";
import { Terminal } from "@/components/ai-elements/terminal";
import { StackTrace } from "@/components/ai-elements/stack-trace";
import { Task } from "@/components/ai-elements/task";
import { OutputRenderer } from "@/components/output-renderer";
import { api } from "@/lib/api";
import { formatAbsolute } from "@/lib/formatters";
import { cn } from "@/lib/utils";
import type { LogEntry, RunDetail, RunPart, TranscriptRow } from "@/lib/types";

type Props = {
  run: RunDetail;
  parts?: RunPart[];
  streamConnected?: boolean;
  streamError?: string | null;
  inline?: boolean;
  onBack?: () => void;
  onReplay?: () => void;
  onCancel?: () => void;
};

export function RunDetailSplitPane({
  run,
  parts = [],
  streamConnected = false,
  streamError,
  inline = false,
  onBack,
  onReplay,
  onCancel,
}: Props) {
  const transcriptParts = parts.length > 0 ? parts : partsFromRun(run);
  const timeline = buildTimeline(run, transcriptParts);
  const isActive = run.status === "running" || run.status === "queued";

  return (
    <div className={cn("min-h-[calc(100vh-7rem)]", inline && "min-h-[560px]")}>
      {/* S27: header chrome aligned with /workers/<id>. Dropped the
          ArrowLeft (sidebar nav + browser back already cover that), H1 is
          worker name (status pill inline), subtitle holds run-id +
          timestamp + duration. Edit/Re-run/Download keep their slot. */}
      <div className="sticky top-0 z-10 border-b border-border bg-background/95 py-4 backdrop-blur">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className={cn("truncate font-semibold tracking-tight", inline ? "text-base" : "text-xl")}>
                {run.worker_name || run.worker_id}
              </h1>
              <RunStatusBadge status={latestStatus(run, transcriptParts)} />
              {streamConnected && <span className="text-xs text-pending">Streaming</span>}
              {streamError && <span className="text-xs text-error">{streamError}</span>}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              <code className="font-mono">{run.id}</code>
              <button
                type="button"
                title="Copy run ID"
                className="rounded p-0.5 hover:bg-muted"
                onClick={() => {
                  navigator.clipboard.writeText(run.id).then(
                    () => toast.success("Run ID copied"),
                    () => toast.error("Copy failed"),
                  );
                }}
              >
                <Copy className="size-3" />
              </button>
              {run.created_at && (
                <>
                  <span className="text-muted-foreground/60">·</span>
                  <span>{formatAbsolute(run.created_at)}</span>
                </>
              )}
              {run.duration_ms != null && (
                <>
                  <span className="text-muted-foreground/60">·</span>
                  <span>{formatDuration(run.duration_ms)}</span>
                </>
              )}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <Link href={`/workers/${run.worker_id}?section=code`}>
              <Button variant="outline" size="sm">
                <Pencil className="size-3.5 mr-1.5" />
                Edit
              </Button>
            </Link>
            <Button variant="outline" size="sm" onClick={onReplay}>
              <RotateCcw className="size-3.5 mr-1.5" />
              Re-run
            </Button>
            <a href={api.runs.downloadUrl(run.id)} download>
              <Button variant="outline" size="sm">
                <Download className="size-3.5 mr-1.5" />
                Download
              </Button>
            </a>
            {isActive && (
              <Button variant="outline" size="sm" onClick={onCancel}>
                <Square className="size-3.5 mr-1.5" />
                Cancel
              </Button>
            )}
          </div>
        </div>
      </div>

      <div className="flex min-h-[520px] gap-0 border-x border-b border-border bg-card">
        <aside className="w-[320px] min-w-[240px] max-w-[460px] resize-x overflow-auto border-r border-border bg-muted/25">
          <div className="sticky top-0 border-b border-border bg-card px-3 py-2">
            <p className="text-xs font-medium uppercase text-muted-foreground">Timeline</p>
          </div>
          <div className="p-2">
            {timeline.map((item, index) => (
              <TimelineRow key={`${item.label}-${index}`} item={item} />
            ))}
          </div>
        </aside>

        <main className="min-w-0 flex-1">
          <Tabs defaultValue="transcript" className="h-full">
            <div className="border-b border-border px-3 py-2">
              <TabsList variant="line">
                <TabsTrigger value="transcript">Transcript</TabsTrigger>
                <TabsTrigger value="logs">Logs</TabsTrigger>
                <TabsTrigger value="output">Output</TabsTrigger>
                <TabsTrigger value="metadata">Metadata</TabsTrigger>
              </TabsList>
            </div>
            <TabsContent value="transcript" className="p-4">
              <TranscriptView run={run} parts={transcriptParts} />
            </TabsContent>
            <TabsContent value="logs" className="p-4">
              <Terminal lines={run.logs.map((log) => ({ level: log.level, message: log.message, timestamp: log.timestamp }))} />
            </TabsContent>
            <TabsContent value="output" className="p-4">
              <OutputView run={run} />
            </TabsContent>
            <TabsContent value="metadata" className="p-4">
              <MetadataView run={run} />
            </TabsContent>
          </Tabs>
        </main>
      </div>
    </div>
  );
}

function TimelineRow({ item }: { item: TimelineItem }) {
  return (
    <div className="relative flex gap-2 pb-3 pl-1">
      <div className="flex flex-col items-center">
        <RunStatusGlyph status={item.status} className="size-4" />
        <div className="mt-1 h-full w-px bg-border" />
      </div>
      <div className="min-w-0 flex-1 rounded-sm px-2 py-1 hover:bg-muted">
        <div className="flex items-center justify-between gap-2">
          <p className="truncate text-sm font-medium">{item.label}</p>
          <span className="shrink-0 text-[11px] text-muted-foreground">{item.duration}</span>
        </div>
        {item.detail && <p className="truncate text-xs text-muted-foreground">{item.detail}</p>}
      </div>
    </div>
  );
}

function TranscriptView({ run, parts }: { run: RunDetail; parts: RunPart[] }) {
  if (parts.length === 0) {
    return <Task title="Waiting for transcript" status={run.status === "failed" ? "failed" : "pending"} detail="No stream parts recorded yet." />;
  }

  return (
    <div className="space-y-3">
      {parts.map((part, index) => {
        if (part.type === "tool-result") return null;
        if (part.type === "tool-call") {
          const result = parts.find(
            (candidate): candidate is Extract<RunPart, { type: "tool-result" }> =>
              candidate.type === "tool-result" && candidate.callId === part.callId,
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
            <div key={`${part.type}-${index}`} className="rounded-md border border-border bg-muted/40 p-3">
              <p className="mb-1 text-[11px] font-medium uppercase text-muted-foreground">
                {part.type === "reasoning" ? "Reasoning" : "Text"}
              </p>
              <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">
                {part.text}
              </p>
            </div>
          );
        }
        if (part.type === "step-start") {
          return (
            <Task
              key={`step-${part.stepNumber}-${index}`}
              title={`Step ${part.stepNumber}`}
              status={run.status === "failed" ? "failed" : run.status === "completed" ? "completed" : "running"}
            />
          );
        }
        if (part.type === "finish") {
          return part.status === "completed" ? (
            <Task key={`finish-${index}`} title="Finished" status="completed" />
          ) : (
            <StackTrace key={`finish-${index}`} error={part.error || run.error || "Run failed"} />
          );
        }
        return null;
      })}
    </div>
  );
}

function OutputView({ run }: { run: RunDetail }) {
  const hasSchema = run.output_schema && run.output_schema.length > 0;
  const hasRaw = Object.keys(run.output || {}).length > 0;
  if (run.status === "failed") {
    return <StackTrace error={run.error} />;
  }
  if (!hasSchema && !hasRaw) {
    return <p className="text-sm text-muted-foreground">No output yet.</p>;
  }
  if (hasSchema) {
    return (
      <div className="space-y-6">
        {run.output_schema.map((field) => (
          <OutputRenderer key={field.name} field={field} runId={run.id} />
        ))}
      </div>
    );
  }
  return (
    <div className="space-y-4">
      {Object.entries(run.output).map(([key, value]) => (
        <div key={key} className="space-y-1">
          <p className="text-xs font-medium uppercase text-muted-foreground">{key}</p>
          <pre className="overflow-auto rounded-md bg-muted p-3 font-mono text-xs">
            {formatUnknown(value)}
          </pre>
        </div>
      ))}
    </div>
  );
}

function MetadataView({ run }: { run: RunDetail }) {
  const metadata = {
    id: run.id,
    worker_id: run.worker_id,
    trigger_source: run.trigger_source,
    runner: run.runner,
    status: run.status,
    created_at: run.created_at,
    started_at: run.started_at,
    completed_at: run.completed_at,
    duration_ms: run.duration_ms,
    input: run.input,
    artifacts: run.artifacts.map((artifact) => ({
      id: artifact.id,
      name: artifact.name,
      type: artifact.type,
      size_bytes: artifact.size_bytes,
    })),
  };
  return (
    <pre className="max-h-[620px] overflow-auto rounded-md bg-muted p-3 font-mono text-xs leading-relaxed">
      {JSON.stringify(metadata, null, 2)}
    </pre>
  );
}

type TimelineItem = {
  label: string;
  detail?: string;
  duration: string;
  status: string;
};

function buildTimeline(run: RunDetail, parts: RunPart[]): TimelineItem[] {
  const rows: TimelineItem[] = [];
  for (const part of parts) {
    if (part.type === "step-start") {
      rows.push({ label: `Step ${part.stepNumber}`, duration: "start", status: run.status });
    } else if (part.type === "tool-call") {
      rows.push({ label: part.toolName, detail: part.callId, duration: "tool", status: run.status });
    } else if (part.type === "text") {
      rows.push({ label: "Assistant text", detail: clip(part.text), duration: "stream", status: run.status });
    } else if (part.type === "reasoning") {
      rows.push({ label: "Reasoning", detail: clip(part.text), duration: "stream", status: run.status });
    } else if (part.type === "finish") {
      rows.push({
        label: part.status === "completed" ? "Completed" : "Failed",
        detail: part.error,
        duration: run.duration_ms != null ? formatDuration(run.duration_ms) : "done",
        status: part.status === "completed" ? "completed" : "failed",
      });
    }
  }
  if (rows.length === 0) {
    return logsToTimeline(run.logs, run.status);
  }
  return rows;
}

function logsToTimeline(logs: LogEntry[], status: string): TimelineItem[] {
  if (logs.length === 0) return [{ label: "Queued", duration: "waiting", status }];
  return logs.map((log, index) => ({
    label: log.message,
    duration: index === 0 ? "start" : deltaLabel(logs[index - 1]?.timestamp, log.timestamp),
    status: log.level === "error" ? "failed" : status,
  }));
}

function latestStatus(run: RunDetail, parts: RunPart[]): string {
  const finish = [...parts].reverse().find((part) => part.type === "finish");
  if (finish?.type === "finish") {
    return finish.status === "completed" ? "completed" : "failed";
  }
  return run.status;
}

function partsFromRun(run: RunDetail): RunPart[] {
  const parts = transcriptRowsToParts(run.transcript || []);
  if (run.status === "completed") parts.push({ type: "finish", status: "completed" });
  if (run.status === "failed") parts.push({ type: "finish", status: "failed", error: run.error });
  return parts;
}

function transcriptRowsToParts(rows: TranscriptRow[]): RunPart[] {
  const parts: RunPart[] = [];
  rows.forEach((row, index) => {
    if (row.role === "assistant" && typeof row.content === "string" && row.content) {
      parts.push({ type: "text", text: row.content });
    }
    const toolCalls = Array.isArray(row.tool_calls) ? row.tool_calls : [];
    for (const call of toolCalls) {
      const callRecord = call as { id?: string; function?: { name?: string; arguments?: string } };
      const callId = callRecord.id || `transcript_call_${index}`;
      parts.push({
        type: "tool-call",
        toolName: callRecord.function?.name || "tool",
        args: parseMaybeJson(callRecord.function?.arguments),
        callId,
      });
    }
    if (row.role === "tool") {
      parts.push({
        type: "tool-result",
        callId: row.tool_call_id || `transcript_result_${index}`,
        result: parseMaybeJson(typeof row.content === "string" ? row.content : row.content),
        isError: false,
      });
    }
    if (row.type === "tool_call") {
      parts.push({
        type: "tool-call",
        toolName: row.name || "tool",
        args: row.arguments ?? {},
        callId: row.tool_call_id || `transcript_call_${index}`,
      });
    }
    if (row.type === "tool_result") {
      parts.push({
        type: "tool-result",
        callId: row.tool_call_id || `transcript_result_${index}`,
        result: row.content,
        isError: false,
      });
    }
  });
  return parts;
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value ?? {};
  if (!value.trim()) return {};
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function formatUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

function clip(value: string): string {
  return value.length > 80 ? `${value.slice(0, 80)}...` : value;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60000)}m`;
}

function deltaLabel(previous?: string, current?: string): string {
  if (!previous || !current) return "";
  const delta = new Date(current).getTime() - new Date(previous).getTime();
  if (!Number.isFinite(delta) || delta < 0) return "";
  return formatDuration(delta);
}

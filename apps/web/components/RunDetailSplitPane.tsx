"use client";

import { useState } from "react";
import Link from "next/link";
import { Copy, Check, Download, FileText, Pencil, RotateCcw, Square } from "lucide-react";
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
    <div className={cn("space-y-6", inline && "min-h-[280px]")}>
      {/* S29h (F8.1): match /workers/<id> chrome exactly. Drop the
          sticky/backdrop/border-b header pattern (no other page has it),
          drop the border-x box around the split pane. Header is now flat
          with the same flex/gap/padding rhythm as /workers/<id>. */}
      {!inline && (
        <Link
          href="/runs"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <span aria-hidden="true">←</span>
          Runs
        </Link>
      )}
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
          <Link href={`/workers/${run.worker_id}#code`}>
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

      <RunMetricsStrip run={run} parts={transcriptParts} />

      {/* R4: the split pane was unbounded — long transcripts/logs grew the
          whole page so it scrolled "into infinity". Cap the pane at a
          viewport-relative height and let each pane scroll WITHIN itself. */}
      <div className="flex min-h-[280px] max-h-[calc(100vh-13rem)] flex-col gap-0 overflow-hidden rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] md:flex-row">
        <aside className="max-h-44 w-full shrink-0 overflow-y-auto border-b border-border bg-muted/25 md:max-h-none md:w-[320px] md:min-w-[240px] md:max-w-[460px] md:resize-x md:border-r md:border-b-0">
          {/* S29q: dropped the SMALL-CAPS "TIMELINE" panel label entirely.
              The timeline IS the panel; the label was dead weight (ChatGPT
              audit P-1). */}
          <div className="p-2">
            {timeline.map((item, index) => (
              <TimelineRow key={`${item.label}-${index}`} item={item} />
            ))}
          </div>
        </aside>

        <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <Tabs defaultValue="transcript" className="flex h-full min-h-0 flex-col">
            <div className="shrink-0 border-b border-border px-3 py-2">
              <TabsList variant="line">
                <TabsTrigger value="transcript">Result</TabsTrigger>
                <TabsTrigger value="logs">Logs</TabsTrigger>
                <TabsTrigger value="output">Output</TabsTrigger>
                <TabsTrigger value="raw">Raw</TabsTrigger>
                <TabsTrigger value="metadata">Metadata</TabsTrigger>
              </TabsList>
            </div>
            <TabsContent value="transcript" className="min-h-0 flex-1 overflow-y-auto p-4">
              <TranscriptView run={run} parts={transcriptParts} />
            </TabsContent>
            <TabsContent value="logs" className="min-h-0 flex-1 overflow-y-auto p-4">
              <Terminal lines={run.logs.map((log) => ({ level: log.level, message: log.message, timestamp: log.timestamp }))} />
            </TabsContent>
            <TabsContent value="output" className="min-h-0 flex-1 overflow-y-auto p-4">
              <OutputView run={run} />
            </TabsContent>
            <TabsContent value="raw" className="min-h-0 flex-1 overflow-y-auto p-4">
              <RawView run={run} parts={transcriptParts} />
            </TabsContent>
            <TabsContent value="metadata" className="min-h-0 flex-1 overflow-y-auto p-4">
              <MetadataView run={run} />
            </TabsContent>
          </Tabs>
        </main>
      </div>
    </div>
  );
}

function RunMetricsStrip({ run, parts }: { run: RunDetail; parts: RunPart[] }) {
  return (
    <dl className="grid gap-px overflow-hidden rounded-xl border border-[var(--border-default)] bg-[var(--border-default)] text-sm sm:grid-cols-2 lg:grid-cols-5">
      <RunMetric label="Status" value={statusLabel(latestStatus(run, parts))} />
      <RunMetric label="Started" value={run.started_at ? formatAbsolute(run.started_at) : "Not started"} />
      <RunMetric label="Duration" value={run.duration_ms != null ? formatDuration(run.duration_ms) : "Running"} />
      <RunMetric label="Output" value={`${outputItemCount(run)} item${outputItemCount(run) === 1 ? "" : "s"}`} />
      <RunMetric label="Files" value={`${run.artifacts.length} file${run.artifacts.length === 1 ? "" : "s"}`} />
    </dl>
  );
}

function RunMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 bg-card px-3 py-2">
      <dt className="text-[11px] font-medium uppercase text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 truncate font-medium text-foreground">{value}</dd>
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
      <div className="min-w-0 flex-1 rounded-[var(--radius-button)] px-2 py-1 hover:bg-muted">
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
  if (run.status === "queued") {
    const positionMsg = run.queue_position != null && run.queue_position > 0
      ? `Waiting for a free execution slot (${run.queue_position - 1} ahead)`
      : "Waiting for a free execution slot";
    return <Task title="Queued" status="pending" detail={positionMsg} />;
  }
  if (parts.length === 0) {
    return <Task title="Waiting for transcript" status={run.status === "failed" ? "failed" : "pending"} detail="No stream parts recorded yet." />;
  }

  if (!hasReadableTranscript(parts)) {
    if (run.status === "failed") {
      return (
        <div className="space-y-5">
          <StackTrace error={run.error || "Run failed"} />
          <RecentLogsPreview run={run} />
        </div>
      );
    }
    return <RunResultOverview run={run} />;
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
            <div key={`${part.type}-${index}`} className="rounded-[var(--radius-button)] border border-border bg-muted/40 p-3">
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

function RunResultOverview({ run }: { run: RunDetail }) {
  return (
    <div className="space-y-6">
      <section className="border border-line bg-muted/20 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-semibold">{run.status === "completed" ? "Run completed" : statusLabel(run.status)}</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {run.worker_name || run.worker_id} produced {outputItemCount(run)} output item{outputItemCount(run) === 1 ? "" : "s"}
              {run.artifacts.length > 0 ? ` and ${run.artifacts.length} result file${run.artifacts.length === 1 ? "" : "s"}` : ""}.
            </p>
          </div>
          <a href={api.runs.downloadUrl(run.id)} download>
            <Button variant="outline" size="sm">
              <Download className="size-3.5 mr-1.5" />
              Download run
            </Button>
          </a>
        </div>
      </section>

      <OutputSummary run={run} />
      <ArtifactsList run={run} />
      <RecentLogsPreview run={run} />
    </div>
  );
}

function OutputSummary({ run }: { run: RunDetail }) {
  const metricEntries = Object.entries(run.output || {}).filter(([, value]) => isScalarOutput(value)).slice(0, 8);
  const schemaFields = (run.output_schema || []).filter((field) => field.value != null && field.value !== "");
  const fileFields = schemaFields.filter((field) => typeof field.value === "string" && field.value.includes("/"));

  if (metricEntries.length === 0 && schemaFields.length === 0) {
    return (
      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Output</h2>
        <p className="text-sm text-muted-foreground">No structured output was recorded.</p>
      </section>
    );
  }

  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-sm font-semibold">Output</h2>
        <p className="text-xs text-muted-foreground">Primary result values and generated output paths.</p>
      </div>

      {metricEntries.length > 0 && (
        <dl className="grid gap-px overflow-hidden rounded-xl border border-[var(--border-default)] bg-[var(--border-default)] sm:grid-cols-2 lg:grid-cols-4">
          {metricEntries.map(([key, value]) => (
            <div key={key} className="min-w-0 bg-card px-3 py-2">
              <dt className="truncate text-[11px] font-medium uppercase text-muted-foreground">{humanizeKey(key)}</dt>
              <dd className="mt-0.5 truncate text-sm font-medium">{String(value)}</dd>
            </div>
          ))}
        </dl>
      )}

      {fileFields.length > 0 && (
        <div className="grid gap-2 lg:grid-cols-2">
          {fileFields.map((field) => (
            <OutputFileLink key={field.name} run={run} label={field.label || field.name} path={String(field.value)} />
          ))}
        </div>
      )}
    </section>
  );
}

function OutputFileLink({ run, label, path }: { run: RunDetail; label: string; path: string }) {
  const artifact = run.artifacts.find((candidate) => candidate.name === path);
  const href = artifact ? api.runs.artifactUrl(run.id, artifact.id) : api.runs.bundleUrl(run.id, path);
  return (
    <a
      href={href}
      download
      className="flex min-w-0 items-center justify-between gap-3 rounded-lg border border-[var(--border-default)] bg-[var(--bg-card)] px-3 py-2 text-sm hover:bg-[var(--active-nav-bg)] transition-colors"
    >
      <span className="flex min-w-0 items-center gap-2">
        <FileText className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0">
          <span className="block truncate font-medium">{label}</span>
          <span className="block truncate font-mono text-xs text-muted-foreground">{path}</span>
        </span>
      </span>
      <Download className="size-4 shrink-0 text-muted-foreground" />
    </a>
  );
}

function ArtifactsList({ run }: { run: RunDetail }) {
  if (run.artifacts.length === 0) return null;
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">Result files</h2>
          <p className="text-xs text-muted-foreground">{run.artifacts.length} downloadable artifact{run.artifacts.length === 1 ? "" : "s"}.</p>
        </div>
        <a href={api.runs.downloadUrl(run.id)} download>
          <Button variant="outline" size="sm">
            <Download className="size-3.5 mr-1.5" />
            Download all
          </Button>
        </a>
      </div>
      <div className="grid gap-2 lg:grid-cols-2">
        {run.artifacts.map((artifact) => (
          <a
            key={artifact.id}
            href={api.runs.artifactUrl(run.id, artifact.id)}
            download
            className="flex min-w-0 items-center justify-between gap-3 rounded-lg border border-[var(--border-default)] bg-[var(--bg-card)] px-3 py-2 text-sm hover:bg-[var(--active-nav-bg)] transition-colors"
          >
            <span className="min-w-0">
              <span className="block truncate font-mono text-xs">{artifact.name}</span>
              <span className="block truncate text-xs text-muted-foreground">
                {[artifact.type || "file", artifact.size_bytes != null ? formatBytes(artifact.size_bytes) : null].filter(Boolean).join(" · ")}
              </span>
            </span>
            <Download className="size-4 shrink-0 text-muted-foreground" />
          </a>
        ))}
      </div>
    </section>
  );
}

function RecentLogsPreview({ run }: { run: RunDetail }) {
  const recent = run.logs.slice(-8);
  if (recent.length === 0) return null;
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-sm font-semibold">Recent logs</h2>
        <p className="text-xs text-muted-foreground">Last {recent.length} server-side log entr{recent.length === 1 ? "y" : "ies"}.</p>
      </div>
      <div className="overflow-hidden rounded-xl border border-[var(--border-default)]">
        {recent.map((log, index) => (
          <div key={`${log.timestamp}-${index}`} className="grid gap-2 border-b border-[var(--border-default)] bg-[var(--bg-card)] px-3 py-2 text-xs last:border-b-0 sm:grid-cols-[8.5rem_5rem_1fr]">
            <span className="font-mono text-muted-foreground">{formatTime(log.timestamp)}</span>
            <span className={cn("font-medium uppercase", log.level === "error" || log.level === "critical" ? "text-error" : "text-muted-foreground")}>
              {log.level}
            </span>
            <span className="min-w-0 break-words text-foreground">{log.message}</span>
          </div>
        ))}
      </div>
    </section>
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
          <pre className="overflow-auto rounded-[var(--radius-button)] bg-muted p-3 font-mono text-xs">
            {formatUnknown(value)}
          </pre>
        </div>
      ))}
    </div>
  );
}

function RawView({ run, parts }: { run: RunDetail; parts: RunPart[] }) {
  // S29k (Q3 Codex verdict): canonical full-fidelity surface for debugging.
  // SSE parts (no timestamps; stream order is time order) + server-side
  // logs (timestamped) joined into one document. JSON download button
  // exports everything so users can diff offline or share with support.
  const payload = {
    run_id: run.id,
    worker_id: run.worker_id,
    status: run.status,
    error: run.error,
    started_at: run.started_at,
    completed_at: run.completed_at,
    duration_ms: run.duration_ms,
    input: run.input,
    output: run.output,
    artifacts: run.artifacts,
    parts,
    logs: run.logs,
  };
  const json = JSON.stringify(payload, null, 2);
  const download = () => {
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${run.id}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(json).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
  };
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium">Raw run data</p>
          <p className="text-xs text-muted-foreground">
            Full SSE part stream, logs, inputs, outputs, and artifacts. Use this when transcript/output don&apos;t show enough.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button variant="outline" size="sm" onClick={copy}>
            {copied ? <Check className="size-3.5 mr-1.5" /> : <Copy className="size-3.5 mr-1.5" />}
            {copied ? "Copied" : "Copy JSON"}
          </Button>
          <Button variant="outline" size="sm" onClick={download}>
            <Download className="size-3.5 mr-1.5" />
            Download
          </Button>
        </div>
      </div>

      <section className="space-y-2">
        <p className="text-[11px] font-medium text-muted-foreground">Parts (SSE stream order)</p>
        {parts.length === 0 ? (
          <p className="text-xs text-muted-foreground italic">No parts captured.</p>
        ) : (
          <pre className="rounded-[var(--radius-button)] border border-line bg-[var(--bg-2)] dark:bg-[#1a1a1a] p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words overflow-auto max-h-[400px]">
            {parts.map((p, i) => `[${i.toString().padStart(3, "0")}] ${p.type}\n${JSON.stringify(p, null, 2)}`).join("\n\n")}
          </pre>
        )}
      </section>

      <section className="space-y-2">
        <p className="text-[11px] font-medium text-muted-foreground">Logs (server-side, timestamped)</p>
        {run.logs.length === 0 ? (
          <p className="text-xs text-muted-foreground italic">No logs captured.</p>
        ) : (
          <pre className="rounded-[var(--radius-button)] border border-line bg-[var(--bg-2)] dark:bg-[#1a1a1a] p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words overflow-auto max-h-[400px]">
            {run.logs.map((l) => `${l.timestamp} [${l.level.toUpperCase()}]${l.trace_id ? ` ${l.trace_id}` : ""} ${l.message}`).join("\n")}
          </pre>
        )}
      </section>
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
    <pre className="max-h-[620px] overflow-auto rounded-[var(--radius-button)] bg-muted p-3 font-mono text-xs leading-relaxed">
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

function hasReadableTranscript(parts: RunPart[]): boolean {
  return parts.some((part) => part.type === "text" || part.type === "reasoning" || part.type === "tool-call" || part.type === "step-start");
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

function isScalarOutput(value: unknown): value is string | number | boolean {
  return typeof value === "number" || typeof value === "boolean" || (typeof value === "string" && !value.includes("/") && value.length <= 120);
}

function outputItemCount(run: RunDetail): number {
  return run.output_schema?.length || Object.keys(run.output || {}).length;
}

function humanizeKey(value: string): string {
  return value.replace(/_/g, " ");
}

function statusLabel(value: string): string {
  return value.replace(/_/g, " ");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
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

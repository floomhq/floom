"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { useState, useEffect } from "react";
import { Download, Clock, AlertCircle, Key, XCircle } from "lucide-react";
import { StatusDot } from "@/components/ui/StatusDot";
import * as XLSX from "xlsx";
import { cn } from "@/lib/utils";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollArea } from "@/components/ui/scroll-area";

type Run = {
  _id: string;
  status: "pending" | "running" | "success" | "error" | "timeout";
  outputs: unknown;
  logs: string;
  errorType: string | null;
  error: string | null;
  durationMs: number | null;
  startedAt: number;
  version: number;
  versionId: string;
};

type ManifestOutputType = "text" | "table" | "integer" | "html" | "pdf";

type Output = {
  name: string;
  label: string;
  type: ManifestOutputType;
  columns?: string[];
};

export function OutputPanel({
  runId,
  lastRun,
  currentVersionId,
  manifestOutputs = [],
}: {
  runId: string | null;
  lastRun: Run | null;
  currentVersionId: string;
  manifestOutputs?: Output[];
}) {
  const activeRun = useQuery(
    api.runs.get,
    runId ? { runId: runId as Id<"runs"> } : "skip"
  );

  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!activeRun || activeRun.status !== "running") {
      setElapsed(0);
      return;
    }
    const start = activeRun.startedAt;
    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - start) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, [activeRun]);

  const displayRun = activeRun ?? lastRun;

  if (!displayRun) {
    return (
      <div className="flex flex-col items-center justify-center h-full min-h-[300px] p-8 text-center">
        <div className="text-muted-foreground/30 text-4xl mb-3">&rarr;</div>
        <p className="text-sm text-muted-foreground">
          Run this automation to see output here
        </p>
      </div>
    );
  }

  if (displayRun.status === "pending" || displayRun.status === "running") {
    return (
      <div className="flex flex-col items-center justify-center h-full min-h-[300px] p-8">
        <div className="space-y-3 text-center">
          <StatusDot status="running" size="sm" />
          <p className="text-sm text-foreground font-medium">
            Running v{displayRun.version}...
          </p>
          {displayRun.status === "running" && (
            <p className="text-xs text-muted-foreground">{elapsed}s elapsed</p>
          )}
          <div className="mt-4 space-y-2 w-48">
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-3/4" />
            <Skeleton className="h-3 w-1/2" />
          </div>
        </div>
      </div>
    );
  }

  if (displayRun.status === "timeout") {
    return (
      <div className="p-4">
        <Alert>
          <Clock className="size-4 text-amber-500" />
          <AlertTitle>Automation timed out (4.5 min limit)</AlertTitle>
          <AlertDescription>
            Try processing fewer items, or ask the automation owner to optimize.
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  if (displayRun.status === "error") {
    return <ErrorOutput run={displayRun} />;
  }

  // Success
  return (
    <SuccessOutput
      run={displayRun}
      currentVersionId={currentVersionId}
      manifestOutputs={manifestOutputs}
    />
  );
}

function ErrorOutput({ run }: { run: Run }) {
  const [showLogs, setShowLogs] = useState(false);

  const errorMessages: Record<
    string,
    { icon: React.ReactNode; title: string; detail: string }
  > = {
    missing_secret: {
      icon: <Key className="size-4 text-destructive" />,
      title: `Missing API key${run.error ? `: ${run.error.replace("Missing secrets: ", "")}` : ""}`,
      detail: "An org admin can add it in Settings \u2192 Org Secrets.",
    },
    runtime_error: {
      icon: <XCircle className="size-4 text-destructive" />,
      title: "Runtime error",
      detail: `Fix with: /floom fix [url]`,
    },
    sandbox_error: {
      icon: <AlertCircle className="size-4 text-amber-500" />,
      title: "Temporary service error",
      detail: "Try again in a moment.",
    },
    syntax_error: {
      icon: <XCircle className="size-4 text-destructive" />,
      title: "Syntax error in automation code",
      detail: `Fix with: /floom fix [url]`,
    },
  };

  const errInfo =
    errorMessages[run.errorType ?? "runtime_error"] ??
    errorMessages.runtime_error;

  return (
    <div className="p-4 space-y-3">
      <Alert variant="destructive">
        {errInfo.icon}
        <AlertTitle>{errInfo.title}</AlertTitle>
        <AlertDescription>
          {errInfo.detail}
          {run.errorType === "runtime_error" && run.error && (
            <div className="mt-2">
              <button
                onClick={() => setShowLogs(!showLogs)}
                className="text-xs text-destructive/80 hover:text-destructive underline"
              >
                {showLogs ? "\u25BC Hide traceback" : "\u25B6 Show traceback"}
              </button>
              {showLogs && (
                <ScrollArea className="mt-2 max-h-48">
                  <pre className="text-xs bg-destructive/5 p-2 rounded overflow-x-auto">
                    {run.error}
                  </pre>
                </ScrollArea>
              )}
            </div>
          )}
        </AlertDescription>
      </Alert>
    </div>
  );
}

function SuccessOutput({
  run,
  currentVersionId,
  manifestOutputs = [],
}: {
  run: Run;
  currentVersionId: string;
  manifestOutputs?: Output[];
}) {
  const outputs = run.outputs as Record<string, unknown> | null;
  if (!outputs) return null;

  const entries = Object.entries(outputs);
  const attrLine = `From run v${run.version} \u00B7 ${formatTime(run.startedAt)}`;
  const isStale = run.versionId !== currentVersionId;

  return (
    <div className="p-4 space-y-4">
      {isStale && (
        <p className="text-xs text-muted-foreground italic">
          Showing output from v{run.version}. Run again to get latest results.
        </p>
      )}

      {entries.map(([key, value]) => {
        const manifestOut = manifestOutputs.find((o) => o.name === key);
        return (
          <OutputBlock
            key={key}
            name={key}
            value={value}
            manifestType={manifestOut?.type}
          />
        );
      })}

      <p className="text-xs text-muted-foreground mt-2">
        {attrLine}
        {isStale && " \u00B7 Run again to refresh"}
      </p>
    </div>
  );
}

function OutputBlock({
  name,
  value,
  manifestType,
}: {
  name: string;
  value: unknown;
  manifestType?: ManifestOutputType;
}) {
  // Manifest-declared types take priority over duck typing
  if (manifestType === "html" && typeof value === "string") {
    return <HtmlOutput label={name} html={value} />;
  }
  if (manifestType === "pdf" && typeof value === "string") {
    return <PdfOutput label={name} base64={value} />;
  }

  if (
    Array.isArray(value) &&
    value.length > 0 &&
    typeof value[0] === "object"
  ) {
    return (
      <TableOutput label={name} rows={value as Record<string, unknown>[]} />
    );
  }

  if (typeof value === "number") {
    return (
      <Card size="sm">
        <CardContent>
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">
            {name.replace(/_/g, " ")}
          </p>
          <p className="text-5xl font-bold text-foreground tabular-nums">
            {value.toLocaleString()}
          </p>
        </CardContent>
      </Card>
    );
  }

  if (typeof value === "string") {
    return (
      <div>
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">
          {name.replace(/_/g, " ")}
        </p>
        <div className="text-sm text-foreground whitespace-pre-wrap">
          {value}
        </div>
      </div>
    );
  }

  return (
    <div>
      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">
        {name.replace(/_/g, " ")}
      </p>
      <pre className="text-xs text-muted-foreground bg-muted p-2 rounded overflow-x-auto">
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function linkify(text: string): string {
  const escaped = escapeHtml(text);
  return escaped.replace(
    /(https?:\/\/[^\s<>&"'`,;)}\]]+)/g,
    '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>'
  );
}

function HtmlOutput({ label, html }: { label: string; html: string }) {
  return (
    <div>
      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
        {label.replace(/_/g, " ")}
      </p>
      <Card className="overflow-hidden p-0">
        <iframe
          srcDoc={html}
          sandbox="allow-scripts"
          className="w-full h-96 bg-background"
          title={label}
        />
      </Card>
    </div>
  );
}

function PdfOutput({ label, base64 }: { label: string; base64: string }) {
  function downloadPDF() {
    try {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const blob = new Blob([bytes], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${label}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      // base64 decode failed
    }
  }

  return (
    <div>
      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
        {label.replace(/_/g, " ")}
      </p>
      <Card size="sm">
        <CardContent className="flex items-center gap-3">
          <span className="text-sm text-muted-foreground">
            PDF generated successfully.
          </span>
          <Button size="sm" onClick={downloadPDF}>
            <Download className="size-3.5" />
            Download PDF
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

function TableOutput({
  label,
  rows,
}: {
  label: string;
  rows: Record<string, unknown>[];
}) {
  const columns = rows.length > 0 ? Object.keys(rows[0]) : [];

  function downloadCSV() {
    const header = columns.join(",");
    const body = rows
      .map((r) => columns.map((c) => JSON.stringify(r[c] ?? "")).join(","))
      .join("\n");
    const csv = `${header}\n${body}`;
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${label}.csv`;
    a.click();
  }

  function downloadXLSX() {
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
    XLSX.writeFile(wb, `${label}.xlsx`);
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          {label.replace(/_/g, " ")}
        </p>
        <div className="flex items-center gap-2">
          <Button variant="link" size="xs" onClick={downloadCSV}>
            <Download className="size-3" />
            CSV
          </Button>
          <Button variant="link" size="xs" onClick={downloadXLSX}>
            <Download className="size-3" />
            XLSX
          </Button>
        </div>
      </div>
      <div className="rounded-lg border overflow-hidden">
        <div className="overflow-x-auto max-h-[500px] overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 z-10 bg-muted/60 backdrop-blur-sm">
              <tr className="border-b">
                {columns.map((col) => (
                  <th
                    key={col}
                    className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground whitespace-nowrap"
                  >
                    {col.replace(/_/g, " ")}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={i} className="border-b last:border-0 hover:bg-muted/30 transition-colors">
                  {columns.map((col) => (
                    <td key={col} className="px-3 py-2 align-top text-sm min-w-[120px] max-w-[300px]">
                      <div
                        className="output-cell"
                        tabIndex={0}
                        onFocus={(e) => e.currentTarget.classList.add("expanded")}
                        onBlur={(e) =>
                          e.currentTarget.classList.remove("expanded")
                        }
                        dangerouslySetInnerHTML={{
                          __html: linkify(String(row[col] ?? "")),
                        }}
                        onClick={(e) => {
                          if ((e.target as HTMLElement).tagName === "A") {
                            e.stopPropagation();
                          }
                        }}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

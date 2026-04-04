"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { useState, useEffect } from "react";
import { Download, Clock, AlertCircle, Key, XCircle } from "lucide-react";
import { StatusDot } from "@/components/ui/StatusDot";
import * as XLSX from "xlsx";

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
};

type Output = {
  name: string;
  label: string;
  type: "text" | "table" | "integer";
  columns?: string[];
};

export function OutputPanel({
  runId,
  lastRun,
  currentVersion,
}: {
  runId: string | null;
  lastRun: Run | null;
  currentVersion: number;
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
        <div className="text-gray-300 text-4xl mb-3">→</div>
        <p className="text-sm text-gray-400">
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
          <p className="text-sm text-gray-600 font-medium">
            Running v{displayRun.version}...
          </p>
          {displayRun.status === "running" && (
            <p className="text-xs text-gray-400">{elapsed}s elapsed</p>
          )}
          <div className="mt-4 space-y-2 w-48">
            <div className="h-3 bg-gray-100 rounded animate-pulse" />
            <div className="h-3 bg-gray-100 rounded animate-pulse w-3/4" />
            <div className="h-3 bg-gray-100 rounded animate-pulse w-1/2" />
          </div>
        </div>
      </div>
    );
  }

  if (displayRun.status === "timeout") {
    return (
      <div className="p-4">
        <div className="flex items-start gap-3 p-4 bg-amber-50 border border-amber-200 rounded">
          <Clock size={18} className="text-amber-500 shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-medium text-amber-800">
              Automation timed out (4.5 min limit)
            </p>
            <p className="text-xs text-amber-700 mt-1">
              Try processing fewer items, or ask the automation owner to
              optimize.
            </p>
          </div>
        </div>
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
      currentVersion={currentVersion}
    />
  );
}

function ErrorOutput({ run }: { run: Run }) {
  const [showLogs, setShowLogs] = useState(false);

  const errorMessages: Record<string, { icon: React.ReactNode; title: string; detail: string }> = {
    missing_secret: {
      icon: <Key size={18} className="text-red-500 shrink-0 mt-0.5" />,
      title: `Missing API key${run.error ? `: ${run.error.replace("Missing secrets: ", "")}` : ""}`,
      detail: "An org admin can add it in Settings → Org Secrets.",
    },
    runtime_error: {
      icon: <XCircle size={18} className="text-red-500 shrink-0 mt-0.5" />,
      title: "Runtime error",
      detail: `Fix with: /floom fix [url]`,
    },
    sandbox_error: {
      icon: <AlertCircle size={18} className="text-amber-500 shrink-0 mt-0.5" />,
      title: "Temporary service error",
      detail: "Try again in a moment.",
    },
    syntax_error: {
      icon: <XCircle size={18} className="text-red-500 shrink-0 mt-0.5" />,
      title: "Syntax error in automation code",
      detail: `Fix with: /floom fix [url]`,
    },
  };

  const errInfo = errorMessages[run.errorType ?? "runtime_error"] ??
    errorMessages.runtime_error;

  return (
    <div className="p-4 space-y-3">
      <div className="flex items-start gap-3 p-4 bg-red-50 border border-red-200 rounded">
        {errInfo.icon}
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-red-800">{errInfo.title}</p>
          <p className="text-xs text-red-700 mt-1">{errInfo.detail}</p>
          {run.errorType === "runtime_error" && run.error && (
            <div className="mt-2">
              <button
                onClick={() => setShowLogs(!showLogs)}
                className="text-xs text-red-600 hover:text-red-800 underline"
              >
                {showLogs ? "▼ Hide traceback" : "▶ Show traceback"}
              </button>
              {showLogs && (
                <pre className="mt-2 text-xs bg-red-100 p-2 rounded overflow-x-auto text-red-900 max-h-48 overflow-y-auto">
                  {run.error}
                </pre>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function SuccessOutput({
  run,
  currentVersion,
}: {
  run: Run;
  currentVersion: number;
}) {
  const outputs = run.outputs as Record<string, unknown> | null;
  if (!outputs) return null;

  const entries = Object.entries(outputs);
  const attrLine = `From run v${run.version} · ${formatTime(run.startedAt)}`;
  const isStale = run.version < currentVersion;

  return (
    <div className="p-4 space-y-4">
      {isStale && (
        <p className="text-xs text-gray-400 italic">
          Showing output from v{run.version}. Run again to get v{currentVersion} results.
        </p>
      )}

      {entries.map(([key, value]) => (
        <OutputBlock key={key} name={key} value={value} />
      ))}

      <p className="text-xs text-gray-400 mt-2">
        {attrLine}
        {isStale && " · Run again to refresh"}
      </p>
    </div>
  );
}

function OutputBlock({ name, value }: { name: string; value: unknown }) {
  if (Array.isArray(value) && value.length > 0 && typeof value[0] === "object") {
    return <TableOutput label={name} rows={value as Record<string, unknown>[]} />;
  }

  if (typeof value === "number") {
    return (
      <div>
        <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">
          {name.replace(/_/g, " ")}
        </p>
        <p className="text-5xl font-bold text-gray-900 tabular-nums">
          {value.toLocaleString()}
        </p>
      </div>
    );
  }

  if (typeof value === "string") {
    return (
      <div>
        <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">
          {name.replace(/_/g, " ")}
        </p>
        <div className="text-sm text-gray-800 whitespace-pre-wrap">{value}</div>
      </div>
    );
  }

  return (
    <div>
      <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">
        {name.replace(/_/g, " ")}
      </p>
      <pre className="text-xs text-gray-700 bg-gray-50 p-2 rounded overflow-x-auto">
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
        <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">
          {label.replace(/_/g, " ")}
        </p>
        <div className="flex items-center gap-2">
          <button
            onClick={downloadCSV}
            className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800"
          >
            <Download size={12} />
            CSV
          </button>
          <button
            onClick={downloadXLSX}
            className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800"
          >
            <Download size={12} />
            XLSX
          </button>
        </div>
      </div>
      <div className="border border-gray-200 rounded overflow-hidden overflow-x-auto max-h-[500px] overflow-y-auto">
        <table className="output-table">
          <thead className="sticky top-0 z-10">
            <tr>
              {columns.map((col) => (
                <th key={col}>{col.replace(/_/g, " ")}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i}>
                {columns.map((col) => (
                  <td key={col}>
                    <div
                      className="td-cell"
                      tabIndex={0}
                      onFocus={(e) => e.currentTarget.classList.add("expanded")}
                      onBlur={(e) => e.currentTarget.classList.remove("expanded")}
                      dangerouslySetInnerHTML={{
                        __html: linkify(String(row[col] ?? "")),
                      }}
                      onClick={(e) => {
                        // Don't steal focus from link clicks
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

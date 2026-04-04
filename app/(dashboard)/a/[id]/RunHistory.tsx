"use client";

import { useState } from "react";
import { StatusDot } from "@/components/ui/StatusDot";
import { ChevronDown, ChevronUp } from "lucide-react";

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
        <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
          Run History
        </h3>
        {runs.length > 5 && (
          <button
            onClick={() => setShowAll(!showAll)}
            className="text-xs text-blue-600 hover:text-blue-800"
          >
            {showAll ? "Show less" : `Show all ${runs.length}`}
          </button>
        )}
      </div>

      <div className="space-y-1">
        {displayed.map((run) => (
          <div key={run._id} className="border border-gray-100 rounded">
            <div
              className="flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-gray-50 text-sm"
              onClick={() => {
                onSelectRun(run._id);
                setExpanded(expanded === run._id ? null : run._id);
              }}
            >
              <StatusDot status={run.status} />
              <span className="text-gray-500 text-xs w-32 shrink-0">
                {formatDate(run.startedAt)}
              </span>
              <span className="text-xs text-gray-400 bg-gray-100 px-1.5 py-0.5 rounded">
                v{run.version}
              </span>
              <span className="text-xs text-gray-500 flex-1">
                {run.triggeredBy === "schedule"
                  ? "schedule"
                  : run.triggeredBy}
              </span>
              {run.durationMs != null && (
                <span className="text-xs text-gray-400">
                  {run.durationMs < 1000
                    ? `${run.durationMs}ms`
                    : `${(run.durationMs / 1000).toFixed(1)}s`}
                </span>
              )}
              {expanded === run._id ? (
                <ChevronUp size={14} className="text-gray-400" />
              ) : (
                <ChevronDown size={14} className="text-gray-400" />
              )}
            </div>

            {expanded === run._id && (
              <div className="border-t border-gray-100 px-3 py-3 space-y-2 text-xs">
                <div>
                  <p className="font-medium text-gray-500 mb-1">Inputs</p>
                  <pre className="bg-gray-50 p-2 rounded text-gray-700 overflow-x-auto">
                    {JSON.stringify(run.inputs, null, 2)}
                  </pre>
                </div>

                {run.status === "success" && Boolean(run.outputs) && (
                  <OutputSummary outputs={run.outputs} />
                )}

                {run.status !== "success" && run.error && (
                  <div>
                    <p className="font-medium text-gray-500 mb-1">Error</p>
                    <pre className="bg-red-50 p-2 rounded text-red-700 overflow-x-auto max-h-32">
                      {run.error}
                    </pre>
                  </div>
                )}
              </div>
            )}
          </div>
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
      <p className="font-medium text-gray-500 mb-1">Output summary</p>
      {entries.map(([key, value]) => {
        if (Array.isArray(value)) {
          return (
            <p key={key} className="text-gray-600">
              {key}: {value.length} rows
            </p>
          );
        }
        return (
          <p key={key} className="text-gray-600">
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

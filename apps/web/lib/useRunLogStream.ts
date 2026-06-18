"use client";

/**
 * useRunLogStream -- live SSE log/trace stream for a single run.
 *
 * Connects to GET /runs/{runId}/logs/stream, which:
 *   - replays all persisted log rows on connect (full history, no separate REST call)
 *   - pushes new log lines in real-time while the run is active
 *   - emits a terminal `{"type":"done","status":"..."}` event and closes
 *
 * Uses EventSource (GET + cookies) via the same-origin proxy at
 * /api/proxy/runs/{id}/logs/stream?workspace_id=... so auth is cookie-based
 * and no custom Authorization header is needed -- same pattern as useRunStream.
 *
 * Returns:
 *   - logs: accumulated log entries (grows in real-time)
 *   - connected: true while EventSource is open and has not errored
 *   - done: true once the terminal "done" event is received
 *   - error: any connection/parse error message
 */

import { useEffect, useState } from "react";
import { apiProxyPath } from "@/lib/api";
import type { LogEntry } from "@/lib/types";

export interface RunLogStreamState {
  logs: LogEntry[];
  connected: boolean;
  done: boolean;
  error: string | null;
}

export function useRunLogStream(runId: string | null | undefined): RunLogStreamState {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [connected, setConnected] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!runId) {
      setLogs([]);
      setConnected(false);
      setDone(false);
      setError(null);
      return;
    }

    setLogs([]);
    setConnected(false);
    setDone(false);
    setError(null);

    let closed = false;

    const source = new EventSource(
      apiProxyPath(`/runs/${encodeURIComponent(runId)}/logs/stream`, true),
    );

    source.addEventListener("open", () => {
      if (!closed) setConnected(true);
    });

    // The backend emits `data: <json>\n\n` as the default (unnamed) event type.
    source.addEventListener("message", (event: MessageEvent) => {
      if (closed) return;
      try {
        const parsed = JSON.parse(event.data as string) as Record<string, unknown>;
        if (parsed.type === "done") {
          setDone(true);
          setConnected(false);
          source.close();
          return;
        }
        if (parsed.type === "log") {
          const entry: LogEntry = {
            level: (parsed.level as LogEntry["level"]) ?? "info",
            message: (parsed.message as string) ?? "",
            timestamp: (parsed.timestamp as string) ?? new Date().toISOString(),
            trace_id: parsed.trace_id as string | undefined,
          };
          setLogs((prev) => [...prev, entry]);
        }
      } catch {
        // malformed event -- ignore and keep stream open
      }
    });

    source.onerror = () => {
      if (closed) return;
      setConnected(false);
      // EventSource auto-reconnects on transient errors; only treat as terminal
      // if the source enters CLOSED state (readyState === 2).
      if (source.readyState === EventSource.CLOSED) {
        setError("Log stream disconnected.");
        source.close();
      }
    };

    return () => {
      closed = true;
      source.close();
    };
  }, [runId]);

  return { logs, connected, done, error };
}

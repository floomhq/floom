"use client";

import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import type { RunDetail, RunPart } from "@/lib/types";

export function useRunStream(runId: string | null | undefined) {
  const [parts, setParts] = useState<RunPart[]>([]);
  const [fallbackRun, setFallbackRun] = useState<RunDetail | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!runId) return;
    setParts([]);
    setFallbackRun(null);
    setError(null);

    let closed = false;
    let sawEvent = false;
    let sawFinish = false;
    const apiBase = process.env.NEXT_PUBLIC_API_PROXY_BASE || "/api/proxy";
    const source = new EventSource(`${apiBase}/runs/${encodeURIComponent(runId)}/stream`);

    source.addEventListener("open", () => {
      if (!closed) setConnected(true);
    });

    source.addEventListener("part", (event) => {
      sawEvent = true;
      try {
        const part = JSON.parse((event as MessageEvent).data) as RunPart;
        setParts((prev) => [...prev, part]);
        if (part.type === "finish") {
          sawFinish = true;
          source.close();
          setConnected(false);
        }
      } catch (exc) {
        setError(exc instanceof Error ? exc.message : "Invalid stream event");
      }
    });

    source.onerror = () => {
      setConnected(false);
      source.close();
      if (closed || sawEvent) return;
      void api.runs.get(runId).then(
        (run) => {
          if (!closed) setFallbackRun(run);
        },
        (exc) => {
          if (!closed) setError(exc instanceof Error ? exc.message : "Run stream unavailable");
        },
      );
    };

    // S28: stale-running detection. Federico hit a case where the UI showed
    // "running" for 10 minutes while the actual run had completed.
    // Mitigation: while we are subscribed but the stream has NOT reported
    // a finish event, poll the run row every 8s. If the polled run.status
    // is terminal (completed/failed), update fallbackRun so the UI
    // reflects reality even though the SSE silently dropped.
    const pollId = window.setInterval(() => {
      if (closed || sawFinish) return;
      void api.runs.get(runId).then(
        (run) => {
          if (closed) return;
          const terminal = run.status === "completed" || run.status === "failed";
          if (terminal) {
            sawFinish = true;
            setFallbackRun(run);
            source.close();
            setConnected(false);
          }
        },
        () => {
          // network blips during polling are fine; SSE error handler covers persistent fail
        },
      );
    }, 8000);

    return () => {
      closed = true;
      source.close();
      window.clearInterval(pollId);
    };
  }, [runId]);

  const finishedPart = useMemo(
    () => parts.findLast((part) => part.type === "finish") as Extract<RunPart, { type: "finish" }> | undefined,
    [parts],
  );

  return { parts, fallbackRun, connected, error, finishedPart };
}

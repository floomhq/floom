"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { api, apiProxyPath } from "@/lib/api";
import type { RunDetail, RunPart } from "@/lib/types";

export function useRunStream(runId: string | null | undefined) {
  const [parts, setParts] = useState<RunPart[]>([]);
  const [fallbackRun, setFallbackRun] = useState<RunDetail | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [streamUnavailable, setStreamUnavailable] = useState(false);
  const [refreshNonce, setRefreshNonce] = useState(0);

  const refresh = useCallback(() => {
    if (!runId) return;
    setError(null);
    setStreamUnavailable(false);
    setRefreshNonce((value) => value + 1);
  }, [runId]);

  useEffect(() => {
    if (!runId) return;
    setParts([]);
    setFallbackRun(null);
    setError(null);
    setStreamUnavailable(false);
    setConnected(false);

    let closed = false;
    let sawFinish = false;
    let staleTimer: number | null = null;
    let consecutivePollFailures = 0;
    const POLL_FAILURE_THRESHOLD = 3;
    const source = new EventSource(
      apiProxyPath(`/runs/${encodeURIComponent(runId)}/stream`, true),
    );

    const armStaleTimer = () => {
      if (staleTimer) window.clearTimeout(staleTimer);
      staleTimer = window.setTimeout(() => {
        if (closed || sawFinish) return;
        setStreamUnavailable(true);
        setError("Lost connection to run status. Refresh to re-check.");
      }, 60000);
    };

    source.addEventListener("open", () => {
      if (!closed) {
        setConnected(true);
        setStreamUnavailable(false);
        armStaleTimer();
      }
    });

    source.addEventListener("part", (event) => {
      try {
        const part = JSON.parse((event as MessageEvent).data) as RunPart;
        consecutivePollFailures = 0;
        setStreamUnavailable(false);
        setError(null);
        setParts((prev) => [...prev, part]);
        armStaleTimer();
        if (part.type === "finish") {
          sawFinish = true;
          source.close();
          setConnected(false);
          if (staleTimer) window.clearTimeout(staleTimer);
        }
      } catch (exc) {
        setError(exc instanceof Error ? exc.message : "Invalid stream event");
      }
    });

    source.onerror = () => {
      setConnected(false);
      source.close();
      if (closed || sawFinish) return;
      void api.runs.get(runId).then(
        (run) => {
          if (closed) return;
          setFallbackRun(run);
          setStreamUnavailable(false);
          setError(null);
          const terminal = run.status === "completed" || run.status === "failed";
          if (terminal) {
            sawFinish = true;
            if (staleTimer) window.clearTimeout(staleTimer);
          } else {
            armStaleTimer();
          }
        },
        (exc) => {
          if (!closed) {
            setStreamUnavailable(true);
            setError(exc instanceof Error ? exc.message : "Run stream unavailable");
            armStaleTimer();
          }
        },
      );
    };

    // S28: stale-running detection. the operator hit a case where the UI showed
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
          consecutivePollFailures = 0;
          setStreamUnavailable(false);
          setError(null);
          const terminal = run.status === "completed" || run.status === "failed" || run.status === "cancelled";
          if (terminal) {
            sawFinish = true;
            setFallbackRun(run);
            source.close();
            setConnected(false);
            if (staleTimer) window.clearTimeout(staleTimer);
          } else {
            armStaleTimer();
          }
        },
        () => {
          if (closed || sawFinish) return;
          consecutivePollFailures += 1;
          if (consecutivePollFailures >= POLL_FAILURE_THRESHOLD) {
            setError("Lost connection to run. Check your network or refresh to see the latest status.");
          }
        },
      );
    }, 8000);

    return () => {
      closed = true;
      source.close();
      window.clearInterval(pollId);
      if (staleTimer) window.clearTimeout(staleTimer);
    };
  }, [runId, refreshNonce]);

  const finishedPart = useMemo(
    () => parts.findLast((part) => part.type === "finish") as Extract<RunPart, { type: "finish" }> | undefined,
    [parts],
  );

  return { parts, fallbackRun, connected, error, finishedPart, streamUnavailable, refresh };
}

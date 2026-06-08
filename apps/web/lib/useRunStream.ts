"use client";

import { useEffect, useMemo, useState } from "react";
import { api, apiProxyPath } from "@/lib/api";
import type { RunDetail, RunPart } from "@/lib/types";

// #587: after this many consecutive poll failures with no finish event, surface
// an error state so the user knows the run status is unknown rather than showing
// "running" indefinitely. The SSE onerror handler fires first; the poll is the
// fallback heartbeat. 3 consecutive failures ≈ 24s of sustained unreachability.
const POLL_FAILURE_THRESHOLD = 3;

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
    let consecutivePollFailures = 0;

    const source = new EventSource(
      apiProxyPath(`/runs/${encodeURIComponent(runId)}/stream`, true),
    );

    source.addEventListener("open", () => {
      if (!closed) setConnected(true);
    });

    source.addEventListener("part", (event) => {
      sawEvent = true;
      consecutivePollFailures = 0; // reset on any real event
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

    // S28: stale-running detection. Poll every 8s while the stream has not
    // reported a finish event. If the polled run.status is terminal, update
    // fallbackRun so the UI reflects reality even when the SSE silently dropped.
    //
    // #587: count consecutive poll failures. After POLL_FAILURE_THRESHOLD
    // failures with no finish event received, surface an error so the user sees
    // "connection lost" instead of an indefinite "running" spinner. This covers
    // the case where both the SSE and the poll endpoint are unreachable for an
    // extended period (e.g. backend restart + proxy flap).
    const pollId = window.setInterval(() => {
      if (closed || sawFinish) return;
      void api.runs.get(runId).then(
        (run) => {
          if (closed) return;
          consecutivePollFailures = 0;
          const terminal = run.status === "completed" || run.status === "failed" || run.status === "cancelled";
          if (terminal) {
            sawFinish = true;
            setFallbackRun(run);
            source.close();
            setConnected(false);
          }
        },
        () => {
          if (closed || sawFinish) return;
          consecutivePollFailures += 1;
          if (consecutivePollFailures >= POLL_FAILURE_THRESHOLD) {
            setError(
              "Lost connection to run. Check your network or refresh to see the latest status.",
            );
          }
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

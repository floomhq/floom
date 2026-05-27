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
    const source = new EventSource(`/api/proxy/runs/${encodeURIComponent(runId)}/stream`);

    source.addEventListener("open", () => {
      if (!closed) setConnected(true);
    });

    source.addEventListener("part", (event) => {
      sawEvent = true;
      try {
        const part = JSON.parse((event as MessageEvent).data) as RunPart;
        setParts((prev) => [...prev, part]);
        if (part.type === "finish") {
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

    return () => {
      closed = true;
      source.close();
    };
  }, [runId]);

  const finishedPart = useMemo(
    () => parts.findLast((part) => part.type === "finish") as Extract<RunPart, { type: "finish" }> | undefined,
    [parts],
  );

  return { parts, fallbackRun, connected, error, finishedPart };
}

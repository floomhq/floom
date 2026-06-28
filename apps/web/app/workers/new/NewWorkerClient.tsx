"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { PromptChips } from "@/components/PromptChips";
import { RunPanel } from "@/components/run-page/RunPanel";
import { api } from "@/lib/api";
import { reportError } from "@/lib/notify";
import { useRunStream } from "@/lib/useRunStream";
import type { RunDetail } from "@/lib/types";

const EXAMPLE_PROMPTS = [
  "Summarise my Granola meetings and sync notes to HubSpot",
  "Send me a daily GitHub PR digest at 9am",
  "Alert me when Stripe charges exceed $500",
] as const;

function readCreatedWorkerId(output: Record<string, unknown> | undefined): string | null {
  const id = output?.created_worker_id;
  return typeof id === "string" && id.trim() ? id.trim() : null;
}

export function NewWorkerClient({ initialPrompt = "" }: { initialPrompt?: string }) {
  const router = useRouter();
  const [prompt, setPrompt] = useState(initialPrompt);
  const [runId, setRunId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigatedRef = useRef(false);

  const { fallbackRun, finishedPart } = useRunStream(runId);
  const [run, setRun] = useState<RunDetail | null>(null);

  useEffect(() => {
    setPrompt((prev) => (prev.trim().length === 0 && initialPrompt.trim() ? initialPrompt : prev));
  }, [initialPrompt]);

  useEffect(() => {
    if (!runId) {
      setRun(null);
      return;
    }
    let cancelled = false;
    const load = () =>
      api.runs.get(runId).then(
        (detail) => {
          if (!cancelled) setRun(detail);
        },
        () => {},
      );
    void load();
    const timer = window.setInterval(load, 4000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [runId, fallbackRun, finishedPart]);

  useEffect(() => {
    if (fallbackRun) setRun(fallbackRun);
  }, [fallbackRun]);

  useEffect(() => {
    if (!run || navigatedRef.current) return;
    const workerId = readCreatedWorkerId(run.output);
    if (run.status === "completed" && workerId) {
      navigatedRef.current = true;
      toast.success("Worker created");
      router.replace(`/workers?sel=${encodeURIComponent(workerId)}&tab=overview`);
      return;
    }
    if (run.status === "failed" || run.status === "cancelled") {
      setError(run.error?.trim() || "Worker creation failed. Try again with a different description.");
      setRunId(null);
    }
  }, [run, router]);

  const handleSubmit = useCallback(async () => {
    const text = prompt.trim();
    if (!text || submitting || runId) return;
    setSubmitting(true);
    setError(null);
    navigatedRef.current = false;
    try {
      const result = await api.workers.newFromPrompt({ prompt: text, mode: "create" });
      setRunId(result.run_id);
    } catch (err) {
      reportError("Could not start worker creation.", err);
      setError(err instanceof Error ? err.message : "Could not start worker creation.");
    } finally {
      setSubmitting(false);
    }
  }, [prompt, submitting, runId]);

  const generating = Boolean(runId);

  return (
    <div className="mx-auto flex h-full w-full max-w-3xl flex-col px-4 py-8 sm:px-6 sm:py-10">
      <div className="shrink-0">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">New worker</h1>
        <p className="mt-2 max-w-xl text-sm text-muted-foreground">
          Describe the job in plain English. Floom drafts the worker, wires integrations, and opens it for review.
        </p>
      </div>

      {!generating ? (
        <div className="mt-8 flex flex-1 flex-col">
          <label htmlFor="new-worker-prompt" className="sr-only">
            Describe the worker you want
          </label>
          <textarea
            id="new-worker-prompt"
            autoFocus
            rows={4}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void handleSubmit();
              }
            }}
            placeholder="Describe the job you want done..."
            className="w-full resize-none rounded-xl bg-[var(--bg-app)] px-4 py-3 text-sm outline-none [border:var(--bd-div)] focus:ring-2 focus:ring-[var(--ring)]"
          />
          <PromptChips prompt={prompt} className="mt-3 px-1" />
          <div className="mt-4 flex flex-wrap gap-2">
            {EXAMPLE_PROMPTS.map((example) => (
              <button
                key={example}
                type="button"
                onClick={() => setPrompt(example)}
                className="rounded-[var(--radius-pill)] [border:var(--bd-card)] bg-[var(--bg-2)] px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-[var(--bg-3)]"
              >
                {example}
              </button>
            ))}
          </div>
          {error && (
            <p className="mt-4 text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
          <div className="mt-6">
            <Button size="lg" disabled={!prompt.trim() || submitting} onClick={() => void handleSubmit()}>
              {submitting ? (
                <>
                  <Loader2 className="mr-2 size-4 animate-spin" />
                  Starting...
                </>
              ) : (
                "Create worker"
              )}
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-8 flex min-h-0 flex-1 flex-col gap-4">
          <div className="shrink-0 rounded-lg [border:var(--bd-card)] bg-[var(--bg-2)] px-4 py-3">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Your request</p>
            <p className="mt-1 text-sm text-foreground">{prompt.trim()}</p>
          </div>
          <div className="min-h-[320px] flex-1 overflow-hidden rounded-lg [border:var(--bd-card)]">
            <RunPanel runId={runId} />
          </div>
        </div>
      )}
    </div>
  );
}

"use client";

import { Suspense, use, useEffect, useRef, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { api } from "@/lib/api";
import { toast } from "sonner";
import { Paperclip, Loader2, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";

// ---------------------------------------------------------------------------
// Example chips shown below the hero card
// ---------------------------------------------------------------------------

const EXAMPLES = [
  { label: "Granola → HubSpot daily", prompt: "Summarise my Granola meetings and post action items to HubSpot CRM daily" },
  { label: "GitHub PR digest 9am", prompt: "Every morning at 9am, send me a digest of my unread GitHub PRs and open issues" },
  { label: "Invoice → Sheets", prompt: "Process any new email in label 'invoices', extract total amount, and add a row to Google Sheets" },
  { label: "HubSpot deal → Slack", prompt: "When a new deal is created in HubSpot, send a Slack message to #sales-channel" },
  { label: "Granola → email drafts", prompt: "Fetch last week's Granola meeting notes and draft follow-up emails via Gmail" },
];

// ---------------------------------------------------------------------------
// Page shell with Suspense for searchParams
// ---------------------------------------------------------------------------

export default function NewWorkerPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string>>;
}) {
  return (
    <Suspense fallback={<NewWorkerSkeleton />}>
      <NewWorkerPageInner searchParams={searchParams} />
    </Suspense>
  );
}

function NewWorkerPageInner({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string>>;
}) {
  use(searchParams || Promise.resolve({} as Record<string, string>));
  return <NewWorkerContent />;
}

function NewWorkerSkeleton() {
  return (
    <div className="max-w-4xl mx-auto space-y-6 pt-8">
      <Skeleton className="h-8 w-56 rounded-[var(--radius-button)]" />
      <Skeleton className="h-4 w-80 rounded-[var(--radius-button)]" />
      <Skeleton className="h-[280px] rounded-lg" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page content
// ---------------------------------------------------------------------------

type UploadState = "idle" | "processing" | "navigating";

// SSE event from /runs/{id}/events
interface RunEvent {
  type: string;
  status?: string;
  log?: string;
  level?: string;
  error?: string;
}

function NewWorkerContent() {
  const router = useRouter();
  const [prompt, setPrompt] = useState("");
  const [generating, setGenerating] = useState(false);
  const [streamRunId, setStreamRunId] = useState<string | null>(null);
  const [streamLogs, setStreamLogs] = useState<string[]>([]);
  const [uploadState, setUploadState] = useState<UploadState>("idle");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const sseRef = useRef<EventSource | null>(null);

  function getLivePrompt(): string {
    return (textareaRef.current?.value ?? prompt).trim();
  }

  const cancelStream = useCallback(() => {
    if (sseRef.current) {
      sseRef.current.close();
      sseRef.current = null;
    }
    setGenerating(false);
    setStreamRunId(null);
    setStreamLogs([]);
  }, []);

  // ---- Generate from prompt ------------------------------------------------
  // Uses the new /workers/new/from-prompt endpoint which returns a run_id.
  // We then subscribe to SSE on that run to get real-time progress.
  // On completion we navigate to /runs/<id> so the user can save the bundle.
  //
  // ROBUST FALLBACK (P0 2026-05-29): the user must NEVER see a dead/hung
  // generation. If the streaming path fails for ANY reason — endpoint 404,
  // the worker-author run reaches status=failed, or the SSE connection drops
  // before completion — fall back to the synchronous draftAndCreate path
  // (which runs the generation in-process and reliably returns a worker_id)
  // so a worker still gets created.

  // Guards against a double-fallback (e.g. onerror firing after a failed
  // status already triggered the fallback).
  const fallbackFiredRef = useRef(false);

  async function fallbackDraftAndCreate(trimmed: string) {
    if (fallbackFiredRef.current) return;
    fallbackFiredRef.current = true;
    if (sseRef.current) {
      sseRef.current.close();
      sseRef.current = null;
    }
    try {
      const result = await api.workers.draftAndCreate({ prompt: trimmed });
      router.push(`/workers/${result.worker_id}?edit=1`);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to generate worker");
      setGenerating(false);
      setStreamRunId(null);
      setStreamLogs([]);
    }
  }

  async function handleGenerate(overridePrompt?: string) {
    const trimmed = overridePrompt ?? getLivePrompt();
    if (!trimmed) {
      toast.error("Describe what you want the worker to do");
      return;
    }
    if (overridePrompt) setPrompt(overridePrompt);
    fallbackFiredRef.current = false;
    setGenerating(true);
    setStreamLogs([]);

    let completed = false;

    try {
      // Try the new streaming endpoint first
      const result = await api.workers.newFromPrompt({ prompt: trimmed, mode: "draft" });
      const runId = result.run_id;
      setStreamRunId(runId);

      // Subscribe to SSE events for real-time progress
      const evtSource = new EventSource(`/api/proxy/runs/${runId}/events`);
      sseRef.current = evtSource;

      evtSource.onmessage = (e) => {
        try {
          const event: RunEvent = JSON.parse(e.data);
          if (event.log) {
            setStreamLogs((prev: string[]) => [...prev.slice(-19), event.log as string]);
          }
          if (event.type === "status" && (event.status === "completed" || event.status === "failed")) {
            evtSource.close();
            sseRef.current = null;
            if (event.status === "completed") {
              completed = true;
              // Navigate to the run page so user can see the bundle and save it
              router.push(`/runs/${runId}`);
            } else {
              // The worker-author run failed — don't dead-end. Fall back to
              // draftAndCreate so a worker still gets created.
              console.warn("worker-author run failed, falling back to draftAndCreate:", event.error);
              void fallbackDraftAndCreate(trimmed);
            }
          }
        } catch {
          // Non-JSON keepalive lines — ignore
        }
      };

      evtSource.onerror = () => {
        evtSource.close();
        sseRef.current = null;
        // SSE dropped. If the run already completed we've navigated away.
        // Otherwise fall back to draftAndCreate rather than navigating to a
        // possibly-incomplete run page or hanging on the GeneratingPanel.
        if (!completed) {
          console.warn("worker-author SSE dropped before completion, falling back to draftAndCreate");
          void fallbackDraftAndCreate(trimmed);
        }
      };
    } catch (streamErr) {
      // The /workers/new/from-prompt endpoint itself failed (e.g. 404/503).
      console.warn("worker-author endpoint unavailable, falling back to draftAndCreate:", streamErr);
      void fallbackDraftAndCreate(trimmed);
    }
  }

  // ---- File upload ---------------------------------------------------------

  async function handleFiles(files: FileList | File[]) {
    const fileArr = Array.from(files);
    if (fileArr.length === 0) return;

    if (fileArr.length > 1) {
      await handleFolderUpload(fileArr);
      return;
    }

    const file = fileArr[0];

    if (file.name.endsWith(".zip")) {
      await handleZipUpload(file);
      return;
    }

    if (file.name.endsWith(".py")) {
      const content = await readText(file);
      if (!content) return;
      const slug = slugify(file.name.replace(/\.py$/i, ""));
      const workerYml = buildMinimalWorkerYml(slug, "pure-script");
      setUploadState("processing");
      try {
        const result = await api.workers.draftAndCreate({
          files: [
            { path: "worker.yml", content: workerYml },
            { path: "run.py", content: content },
          ],
        });
        setUploadState("navigating");
        router.push(`/workers/${result.worker_id}?edit=1`);
      } catch (e: unknown) {
        toast.error(e instanceof Error ? e.message : "Failed to create worker from file");
        setUploadState("idle");
      }
      return;
    }

    if (file.name.endsWith(".md") || file.name.endsWith(".txt")) {
      const content = await readText(file);
      if (!content) return;
      const slug = slugify(file.name.replace(/\.(md|txt)$/i, ""));
      const workerYml = buildMinimalWorkerYml(slug, "agent");
      setUploadState("processing");
      try {
        const result = await api.workers.draftAndCreate({
          files: [
            { path: "worker.yml", content: workerYml },
            { path: "SKILL.md", content: content },
          ],
        });
        setUploadState("navigating");
        router.push(`/workers/${result.worker_id}?edit=1`);
      } catch (e: unknown) {
        toast.error(e instanceof Error ? e.message : "Failed to create worker from file");
        setUploadState("idle");
      }
      return;
    }

    toast.error("Upload a .md, .py, or .zip file");
  }

  async function handleZipUpload(file: File) {
    setUploadState("processing");
    try {
      const worker = await api.workers.createFromBundle(file);
      setUploadState("navigating");
      router.push(`/workers/${worker.id}?edit=1`);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to create worker from bundle");
      setUploadState("idle");
    }
  }

  async function handleFolderUpload(files: File[]) {
    setUploadState("processing");
    try {
      const JSZip = (await import("jszip")).default;
      const zip = new JSZip();
      for (const file of files) {
        const path = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
        zip.file(path, await file.arrayBuffer());
      }
      const blob = await zip.generateAsync({ type: "blob" });
      const worker = await api.workers.createFromBundle(blob);
      setUploadState("navigating");
      router.push(`/workers/${worker.id}?edit=1`);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to create worker from folder");
      setUploadState("idle");
    }
  }

  function handleFileInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (files && files.length > 0) void handleFiles(files);
    e.target.value = "";
  }

  const isUploading = uploadState !== "idle";
  const isBusy = generating || isUploading;

  if (generating) {
    return (
      <div className="max-w-4xl mx-auto pt-8 pb-16">
        <GeneratingPanel
          prompt={prompt}
          streamLogs={streamLogs}
          isStreaming={!!streamRunId}
          onCancel={cancelStream}
        />
      </div>
    );
  }

  return (
    <div className="max-w-3xl space-y-8">
      {/* S29o: was max-w-3xl mx-auto (centered) + text-center hero, which
          Federico flagged as not aligning with the rest of the surface
          (everything else is left-aligned). Now left-aligned, prominent
          back-nav (text-sm), heading text-xl matching detail headers, no
          decorative icon since the page is the action. */}
      <Link
        href="/workers"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        <span aria-hidden="true">←</span>
        Workers
      </Link>
      <div className="space-y-1.5">
        <h1 className="text-xl font-semibold tracking-tight">Hire a new AI worker</h1>
        <p className="text-sm text-muted-foreground">
          Describe the job in plain English. Floom drafts the worker, picks the right
          integrations, and opens the editor so you can review before running.
        </p>
      </div>

      {/* S25: hero textarea card sized to feel like the centerpiece, not a
          form field. Bigger min-height + tighter footer. */}
      <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] p-5 shadow-[var(--shadow-card)] space-y-4">
        <Textarea
          ref={textareaRef}
          placeholder="Summarise my Granola meetings and post action items to HubSpot CRM daily"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onInput={(e) => {
            const val = (e.target as HTMLTextAreaElement).value;
            if (val !== prompt) setPrompt(val);
          }}
          className="min-h-[160px] resize-none border-0 px-0 shadow-none text-base focus-visible:ring-0 focus-visible:border-0 placeholder:text-muted-foreground/50"
          disabled={isBusy}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              void handleGenerate();
            }
          }}
        />

        <div className="border-t border-line" />

        {/* Bottom row: upload (left) + generate (right).
            S22c (roast P1/P2): upload now reads as a button (border + padded
            rectangle), shortcut hint moves outside the disabled-button shadow
            so it remains visible. */}
        <div className="flex items-center justify-between gap-3">
          <button
            type="button"
            disabled={isBusy}
            onClick={() => fileInputRef.current?.click()}
            className="inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-button)] border border-border bg-card px-3 text-xs font-medium text-foreground hover:bg-muted transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {isUploading ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                {uploadState === "navigating" ? "Opening editor..." : "Processing..."}
              </>
            ) : (
              <>
                <Paperclip className="w-3.5 h-3.5" />
                Upload .md / .py / .zip
              </>
            )}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".md,.txt,.py,.zip,application/zip"
            multiple
            className="hidden"
            onChange={handleFileInputChange}
          />

          <div className="flex items-center gap-2">
            <Button
              onClick={() => void handleGenerate()}
              disabled={isBusy || !prompt.trim()}
              className="h-8 px-4 text-sm"
            >
              {generating ? (
                <span className="flex items-center gap-1.5">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  Generating...
                </span>
              ) : (
                "Generate"
              )}
            </Button>
            <kbd
              className="hidden sm:inline-flex items-center gap-0.5 rounded border border-line bg-[var(--bg-2)] px-1.5 py-1 text-[10px] font-mono text-[var(--ink-mute)]"
              aria-hidden="true"
            >
              <span style={{ fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif' }}>⌘</span>
              <span>↵</span>
            </kbd>
          </div>
        </div>
      </div>

      {/* S25: examples promoted from pills to a tappable card grid with the
          full prompt visible. Less heartless: users see what kind of work
          Floom can do, not just abstract one-liners. */}
      {/* S29u (score walk): "Recommended first" accent label dropped (per
          ChatGPT audit: don't paint things to look special unless they ARE
          state). First tile no longer rendered in saturated --accent-soft;
          all tiles now equal-weight ghost-style, hover lifts. */}
      <div className="space-y-3">
        <p className="text-sm font-medium text-foreground">Or start from a popular workflow</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {EXAMPLES.map((ex) => (
            <button
              key={ex.label}
              type="button"
              disabled={isBusy}
              onClick={() => setPrompt(ex.prompt)}
              className="group flex flex-col items-start gap-1.5 rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] px-4 py-3 text-left hover:bg-[var(--active-nav-bg)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <span className="text-sm font-medium text-foreground">{ex.label}</span>
              <span className="text-xs text-muted-foreground line-clamp-2">{ex.prompt}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function slugify(name: string): string {
  return (name || "my-worker")
    .replace(/[^a-z0-9]+/gi, "-")
    .toLowerCase()
    .replace(/^-+|-+$/g, "")
    .slice(0, 63) || "my-worker";
}

function buildMinimalWorkerYml(slug: string, mode: "agent" | "pure-script"): string {
  const title = slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  if (mode === "pure-script") {
    return `schema_version: "0.3"\nname: ${slug}\ntitle: ${JSON.stringify(title)}\ndescription: "Describe what this worker does."\nversion: "0.1.0"\nentrypoint: run.py\ntargets: [generic]\n\nexec:\n  command: python run.py\n  runtime: python311\n  mode: pure-script\n  runner: e2b\n  inputs: []\n  outputs: []\n\ntrigger:\n  type: manual\n`;
  }
  return `schema_version: "0.3"\nname: ${slug}\ntitle: ${JSON.stringify(title)}\ndescription: "Describe what this worker does."\nversion: "0.1.0"\nentrypoint: SKILL.md\ntargets: [generic]\n\nexec:\n  runtime: skill\n  mode: agent\n  runner: e2b\n  entrypoint: SKILL.md\n  inputs: []\n  outputs: []\n\ntrigger:\n  type: manual\n`;
}

async function readText(file: File): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target?.result;
      if (typeof text === "string" && text.trim()) {
        resolve(text);
      } else {
        toast.error("The file appears to be empty");
        resolve(null);
      }
    };
    reader.onerror = () => {
      toast.error("Failed to read file");
      resolve(null);
    };
    reader.readAsText(file);
  });
}

// S40: GeneratingPanel now shows real SSE log lines from the worker-author run.
// Falls back to timer-based stage hints when no stream logs are available yet.
const DRAFT_STAGES = [
  { id: "read",     label: "Reading your prompt",           targetSec: 3 },
  { id: "plan",     label: "Reading style context",         targetSec: 9 },
  { id: "draft",    label: "Drafting worker.yml",           targetSec: 16 },
  { id: "write",    label: "Writing SKILL.md / run.py",     targetSec: 24 },
  { id: "validate", label: "Validating schema",             targetSec: 38 },
] as const;

function GeneratingPanel({
  prompt,
  streamLogs,
  isStreaming,
  onCancel,
}: {
  prompt: string;
  streamLogs: string[];
  isStreaming: boolean;
  onCancel?: () => void;
}) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const id = window.setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => window.clearInterval(id);
  }, []);

  const stageIndex = DRAFT_STAGES.findIndex((s) => elapsed < s.targetSec);
  const activeStage = stageIndex === -1 ? DRAFT_STAGES.length - 1 : stageIndex;
  const lastStage = stageIndex === -1;
  const stageRatio = (activeStage + (lastStage ? 0 : 1)) / DRAFT_STAGES.length;
  const progress = Math.min(0.92, stageRatio);

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div className="text-center space-y-3">
        <Loader2 className="size-7 animate-spin mx-auto text-muted-foreground" aria-hidden="true" />
        <h1 className="text-2xl font-semibold tracking-tight">Drafting your worker</h1>
        <p className="text-sm text-muted-foreground max-w-md mx-auto">
          {isStreaming
            ? "Worker Author is running — you'll see real progress below."
            : "Floom is reading your prompt, picking integrations, and writing the worker files."}
        </p>
      </div>

      {prompt && (
        <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-2)] px-4 py-3">
          <p className="text-[11px] text-muted-foreground mb-1">Your prompt</p>
          <p className="text-sm text-foreground whitespace-pre-wrap">{prompt}</p>
        </div>
      )}

      {/* Real SSE log lines from worker-author run */}
      {streamLogs.length > 0 && (
        <div className="rounded-lg border border-line bg-[var(--bg-2)] px-4 py-3 space-y-1">
          <p className="text-[11px] text-muted-foreground mb-2">Worker Author</p>
          {streamLogs.map((log, i) => (
            <p key={i} className="text-xs text-muted-foreground font-mono truncate">
              {log}
            </p>
          ))}
        </div>
      )}

      <div className="space-y-3">
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--bg-2)] relative">
          <div
            className="absolute inset-y-0 left-0 rounded-full bg-[var(--accent)] transition-[width] duration-700 ease-out"
            style={{ width: `${progress * 100}%` }}
          />
          {lastStage && (
            <div
              className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-transparent via-white/30 to-transparent dark:via-white/10 animate-[s40-shimmer_1.6s_ease-in-out_infinite]"
              style={{ width: `${progress * 100}%` }}
            />
          )}
        </div>
        <ol className="space-y-1.5">
          {DRAFT_STAGES.map((stage, i) => {
            const done = i < activeStage;
            const active = i === activeStage;
            return (
              <li key={stage.id} className="flex items-center gap-2.5 text-sm">
                <span
                  className={`inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] ${
                    done
                      ? "bg-[var(--accent)] text-[var(--solid-fg)]"
                      : active
                      ? "border border-[var(--accent)] text-[var(--accent)]"
                      : "border border-line text-muted-foreground"
                  }`}
                >
                  {done ? <Check className="w-2.5 h-2.5" /> : active ? <Loader2 className="w-2.5 h-2.5 animate-spin" /> : null}
                </span>
                <span className={done ? "text-muted-foreground" : active ? "text-foreground font-medium" : "text-muted-foreground"}>
                  {stage.label}
                </span>
              </li>
            );
          })}
        </ol>
        <div className="flex justify-between text-[11px] text-muted-foreground pt-1">
          <span>{isStreaming ? "Live from Worker Author" : "Stages are best-guess timing."}</span>
          <span className="tabular-nums">{formatElapsed(elapsed)}</span>
        </div>
      </div>

      {elapsed >= 60 && onCancel && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 dark:bg-amber-950/30 dark:border-amber-900">
          <p className="text-xs text-amber-800 dark:text-amber-300">
            This is taking longer than usual. The request may have stalled.
          </p>
          <button
            type="button"
            onClick={onCancel}
            className="mt-2 text-xs underline text-amber-900 hover:text-amber-700 dark:text-amber-200 dark:hover:text-amber-100"
          >
            Go back and try a shorter prompt
          </button>
        </div>
      )}

      <style>{`
        @keyframes s40-shimmer {
          0% { transform: translateX(-100%); opacity: 0; }
          50% { opacity: 1; }
          100% { transform: translateX(100%); opacity: 0; }
        }
      `}</style>
    </div>
  );
}

function formatElapsed(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m === 0) return `${s}s`;
  return `${m}m ${s}s`;
}

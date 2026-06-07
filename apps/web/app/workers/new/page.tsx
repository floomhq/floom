"use client";

import { Suspense, use, useEffect, useRef, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { api, apiProxyPath } from "@/lib/api";
import { toast } from "sonner";
import { Paperclip, Loader2, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { PromptText } from "@/components/PromptText";
import { PromptChips } from "@/components/PromptChips";
import { PromptHighlightInput } from "@/components/PromptHighlightInput";

// ---------------------------------------------------------------------------
// Example workflows shown below the hero card. The tool/capability chips on
// each card are derived from the prompt text by the shared detector
// (lib/prompt-detect) — no hand-kept app list to drift.
// ---------------------------------------------------------------------------

const EXAMPLES = [
  {
    label: "Granola → HubSpot daily",
    prompt: "Summarise my Granola meetings and post action items to HubSpot CRM daily",
  },
  {
    label: "GitHub PR digest 9am",
    prompt: "Every morning at 9am, send me a digest of my unread GitHub PRs and open issues",
  },
  {
    label: "Invoice → Sheets",
    prompt: "Process any new email in label 'invoices', extract total amount, and add a row to Google Sheets",
  },
  {
    label: "HubSpot deal → Slack",
    prompt: "When a new deal is created in HubSpot, send a Slack message to #sales-channel",
  },
  {
    label: "Granola → email drafts",
    prompt: "Fetch last week's Granola meeting notes and draft follow-up emails via Gmail",
  },
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
  const params = use(searchParams || Promise.resolve({} as Record<string, string>));
  const seed = typeof params?.prompt === "string" ? params.prompt : "";
  return <NewWorkerContent initialPrompt={seed} />;
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
  // Broadcast by the backend when a worker-author run completes and the drafted
  // bundle has been registered as a real worker (wedge fix 2026-05-29).
  created_worker_id?: string;
}

function NewWorkerContent({ initialPrompt = "" }: { initialPrompt?: string }) {
  const router = useRouter();
  const [prompt, setPrompt] = useState(initialPrompt);
  const [generating, setGenerating] = useState(false);
  const [streamRunId, setStreamRunId] = useState<string | null>(null);
  const [streamLogs, setStreamLogs] = useState<string[]>([]);
  const [uploadState, setUploadState] = useState<UploadState>("idle");
  const [dragActive, setDragActive] = useState(false);
  // Chip ids the operator has removed from the detected tool/capability row.
  const [dismissedChips, setDismissedChips] = useState<Set<string>>(new Set());
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const sseRef = useRef<EventSource | null>(null);
  const runIdRef = useRef<string | null>(null);
  // Guards against double navigation (e.g. onerror firing right after onmessage
  // already navigated on the terminal `close`/status event).
  const navigatedRef = useRef(false);
  // Auto-trigger fires once when arriving from the marketing prompt-box CTA
  // (`/workers/new?prompt=…`). Strict-mode-safe via a ref.
  const autoTriggeredRef = useRef(false);

  function getLivePrompt(): string {
    return (textareaRef.current?.value ?? prompt).trim();
  }

  const cancelStream = useCallback(() => {
    if (sseRef.current) {
      sseRef.current.close();
      sseRef.current = null;
    }
    runIdRef.current = null;
    navigatedRef.current = false;
    setGenerating(false);
    setStreamRunId(null);
    setStreamLogs([]);
  }, []);

  // Auto-trigger generation when arriving with a seeded prompt from the
  // marketing prompt-box CTA (`/workers/new?prompt=…`). Only fires once per
  // page-mount. The handleGenerate reference is hoisted by the JS engine so
  // referencing it here before its declaration below is safe.
  useEffect(() => {
    if (autoTriggeredRef.current) return;
    if (!initialPrompt.trim()) return;
    autoTriggeredRef.current = true;
    void handleGenerate(initialPrompt);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPrompt]);

  // ---- Generate from prompt ------------------------------------------------
  // Uses the /workers/new/from-prompt endpoint which creates a worker-author
  // run and returns its run_id. We subscribe to SSE on that run for real-time
  // drafting progress.
  //
  // WEDGE FIX (2026-05-29): the prompt-to-worker flow MUST end on a REAL,
  // editable worker — not a dead-end /runs/<id> bundle view. On a successful
  // worker-author run the BACKEND now registers the drafted bundle as a worker
  // (run completion hook) and reports the new worker id via SSE
  // (`created_worker_id`) + on the run output. We navigate to
  // `/workers/<id>?edit=1` so the operator reviews/saves/runs it. We only land
  // on `/runs/<id>` when the run FAILED (so the operator can see why) or when
  // — defensively — no worker id ever materialises.
  //
  // G5 P1 (2026-05-29, still holds): never silently reset to the empty form,
  // and never fire a duplicate-creating second call. The run id is kept in a
  // ref so onmessage/onerror never read a stale null; a mid-flight SSE drop
  // resolves the worker via a run-detail fetch rather than re-drafting.

  function navigateToRun(runId: string, opts?: { failed?: boolean }) {
    if (navigatedRef.current) return;
    navigatedRef.current = true;
    if (sseRef.current) {
      sseRef.current.close();
      sseRef.current = null;
    }
    if (opts?.failed) {
      toast.error("Worker generation hit an error — opening the run so you can see what happened.");
    } else {
      toast.success("Worker drafted");
    }
    router.push(`/runs/${runId}`);
  }

  function navigateToWorker(workerId: string) {
    if (navigatedRef.current) return;
    navigatedRef.current = true;
    if (sseRef.current) {
      sseRef.current.close();
      sseRef.current = null;
    }
    toast.success("Worker created");
    router.push(`/workers/${workerId}?edit=1`);
  }

  // A worker-author run COMPLETED. Resolve the real worker id and open the
  // editor. If the SSE event already carried `created_worker_id`, use it; else
  // read it from the run output (covers the already-terminal reconnect case
  // where the minimal SSE event omits custom fields). Only fall back to the
  // run view when no worker id can be resolved.
  async function navigateToCreatedWorker(runId: string, eventWorkerId?: string) {
    if (navigatedRef.current) return;
    if (eventWorkerId) {
      navigateToWorker(eventWorkerId);
      return;
    }
    try {
      const run = await api.runs.get(runId);
      const createdId = (run.output as Record<string, unknown> | undefined)?.["created_worker_id"];
      if (typeof createdId === "string" && createdId) {
        navigateToWorker(createdId);
        return;
      }
    } catch {
      // fall through to the run view
    }
    navigateToRun(runId);
  }

  // SSE through Vercel commonly drops MID-FLIGHT (before the run is terminal).
  // When that happens we must NOT navigate to /runs/<id> while the worker is
  // still being drafted — that strands the operator on a run page and the
  // editor never opens. Instead we keep the drafting panel up and poll the run
  // until it reaches a terminal state, then route correctly:
  //   completed -> /workers/<id>?edit=1 (the registered worker)
  //   failed    -> /runs/<id> (so the operator can see why)
  // Bounded so a wedged run can't poll forever; on timeout we open the run view.
  async function pollRunUntilTerminalThenRoute(runId: string) {
    if (navigatedRef.current) return;
    const startedAt = Date.now();
    const maxMs = 5 * 60 * 1000; // generation is ~30s; 5min is a generous ceiling
    while (!navigatedRef.current && Date.now() - startedAt < maxMs) {
      try {
        const run = await api.runs.get(runId);
        const status = String(run.status || "");
        if (status === "completed") {
          const createdId = (run.output as Record<string, unknown> | undefined)?.["created_worker_id"];
          if (typeof createdId === "string" && createdId) {
            navigateToWorker(createdId);
          } else {
            navigateToRun(runId);
          }
          return;
        }
        if (status === "failed" || status === "rejected" || status === "cancelled") {
          navigateToRun(runId, { failed: true });
          return;
        }
      } catch {
        // transient — keep polling
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    // Timed out without a terminal state — open the run so it isn't a dead-end.
    if (!navigatedRef.current) navigateToRun(runId);
  }

  async function handleGenerate(overridePrompt?: string) {
    const trimmed = overridePrompt ?? getLivePrompt();
    if (!trimmed) {
      toast.error("Describe what you want the worker to do");
      return;
    }
    if (overridePrompt) setPrompt(overridePrompt);
    navigatedRef.current = false;
    runIdRef.current = null;
    setStreamRunId(null);
    setGenerating(true);
    setStreamLogs([]);

    try {
      // Create the worker-author run. After this resolves a run EXISTS — every
      // terminal/drop path below navigates to it, never resets the form.
      const result = await api.workers.newFromPrompt({ prompt: trimmed, mode: "draft" });
      const runId = result.run_id;
      runIdRef.current = runId;
      setStreamRunId(runId);

      // Subscribe to SSE events for real-time progress
      const evtSource = new EventSource(
        apiProxyPath(`/runs/${encodeURIComponent(runId)}/events`, true),
      );
      sseRef.current = evtSource;

      evtSource.onmessage = (e) => {
        try {
          const event: RunEvent = JSON.parse(e.data);
          if (event.log) {
            setStreamLogs((prev: string[]) => [...prev.slice(-19), event.log as string]);
          }
          if (event.type === "status" && event.status === "completed") {
            // Success: the backend registered the drafted bundle as a real
            // worker. Open its editor (not the dead-end run view).
            void navigateToCreatedWorker(runIdRef.current ?? runId, event.created_worker_id);
          } else if (event.type === "status" && event.status === "failed") {
            // A failed worker-author run still has a viewable run page so the
            // operator can see what went wrong.
            navigateToRun(runIdRef.current ?? runId, { failed: true });
          }
        } catch {
          // Non-JSON keepalive lines — ignore
        }
      };

      evtSource.onerror = () => {
        evtSource.close();
        sseRef.current = null;
        // SSE dropped. We already have a real run id, so KEEP the drafting
        // panel up and poll the run until it finishes, then route to the editor
        // (completed) or the run view (failed). Navigating away mid-flight
        // stranded the operator on /runs/<id> with the editor never opening.
        // NEVER fire a second draftAndCreate here — that created the duplicate
        // worker + the silent form reset the G5 audit hit.
        const id = runIdRef.current;
        if (id) {
          void pollRunUntilTerminalThenRoute(id);
        }
      };
    } catch (streamErr) {
      // The async worker-author run did not start, so there is no run page to
      // poll. Keep this path async-only; the legacy synchronous endpoint can
      // outlive the Cloud proxy request budget.
      console.warn("worker-author endpoint unavailable:", streamErr);
      toast.error(streamErr instanceof Error ? streamErr.message : "Failed to start worker generation");
      setGenerating(false);
      setStreamRunId(null);
      runIdRef.current = null;
      setStreamLogs([]);
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

  // Drag-and-drop onto the prompt box (Federico 2026-05-29). Dropping a bundle
  // zip, a folder of files, or a single .md/.py/.txt is handled by the same
  // handleFiles path the Upload button uses. Additive: the textarea + Upload
  // button keep working unchanged.
  function handleDragOver(e: React.DragEvent) {
    if (isBusy) return;
    e.preventDefault();
    if (!dragActive) setDragActive(true);
  }

  function handleDragLeave(e: React.DragEvent) {
    // Only clear when the pointer actually leaves the card, not on child enter.
    if (e.currentTarget === e.target) setDragActive(false);
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragActive(false);
    if (isBusy) return;
    const files = e.dataTransfer.files;
    if (files && files.length > 0) void handleFiles(files);
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
          Describe the job in plain English. Workeros drafts the worker, picks the right
          integrations, and opens the editor so you can review before running.
        </p>
      </div>

      {/* S25: hero textarea card sized to feel like the centerpiece, not a
          form field. Bigger min-height + tighter footer.
          2026-05-29: card is now a dropzone (drag a bundle zip / folder /
          .md / .py onto it — same path as the Upload button). */}
      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={`relative rounded-xl border bg-[var(--bg-card)] p-5 shadow-[var(--shadow-card)] space-y-4 transition-colors ${
          dragActive ? "border-[var(--accent)] border-dashed" : "border-[var(--border-default)]"
        }`}
      >
        {dragActive && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-[var(--bg-card)]/85 backdrop-blur-[1px]">
            <p className="text-sm font-medium text-foreground">Drop a .md / .py / .zip or a worker folder to import</p>
          </div>
        )}
        {/* Inline highlight overlay + real textarea via PromptHighlightInput.
            The mirror layer renders the typed text through the shared tokeniser
            (lib/prompt-detect) — same engine as PromptText on the example cards
            and PromptChips below, so highlight, chips, and backend wiring
            always agree. */}
        <PromptHighlightInput
          ref={textareaRef}
          placeholder="Summarise my Granola meetings and post action items to HubSpot CRM daily"
          value={prompt}
          onChange={setPrompt}
          onInput={(e) => {
            const val = (e.target as HTMLTextAreaElement).value;
            if (val !== prompt) setPrompt(val);
          }}
          disabled={isBusy}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              void handleGenerate();
            }
          }}
        />

        {/* Chip row — keeps the removable "Will use: Granola HubSpot …" row
            which gives an additional signal of detected connections. Both the
            inline highlight above AND this chip row derive from the shared
            detector so they always agree. */}
        <PromptChips
          prompt={prompt}
          dismissed={dismissedChips}
          onDismiss={(id) =>
            setDismissedChips((prev) => {
              const next = new Set(prev);
              next.add(id);
              return next;
            })
          }
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
            accept=".md,.markdown,.txt,.py,.yml,.yaml,.json,.toml,.csv,.zip,application/zip"
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
              <span className="text-xs text-muted-foreground line-clamp-2">
                <PromptText>{ex.prompt}</PromptText>
              </span>
              {/* Tool/capability chips — derived from the prompt by the ONE
                  shared detector (read-only here), not a hand-kept app list. */}
              <PromptChips prompt={ex.prompt} className="mt-0.5" />
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
  { id: "plan",     label: "Reading style guide",           targetSec: 9 },
  { id: "draft",    label: "Drafting worker.yml",           targetSec: 16 },
  { id: "write",    label: "Writing SKILL.md / run.py",     targetSec: 24 },
  { id: "validate", label: "Validating schema",             targetSec: 38 },
] as const;

// FIX 4 (Federico 2026-05-29): worker-author + smoke legitimately runs
// 60-120s+. The old 60s "may have stalled" notice fired DURING normal
// generation, telling the user a worker that completes fine server-side had
// stalled (a scorer flagged the false stall). The background poll
// (pollRunUntilTerminalThenRoute) keeps reconciling against the real run for
// up to 5min and navigates to the created worker on completion — so the UI
// must not alarm before that has had a fair chance. Raise the notice to 150s
// and reword it to "still working", never "stalled".
const SLOW_GENERATION_NOTICE_SEC = 150;

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
            : "Workeros is reading your prompt, picking integrations, and writing the worker files."}
        </p>
      </div>

      {prompt && (
        <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-2)] px-4 py-3">
          <p className="text-[11px] text-muted-foreground mb-1">Your prompt</p>
          <p className="text-sm text-foreground whitespace-pre-wrap">
            <PromptText>{prompt}</PromptText>
          </p>
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

      {elapsed >= SLOW_GENERATION_NOTICE_SEC && onCancel && (
        <div className="rounded-lg border border-line bg-[var(--bg-2)] px-4 py-3">
          <p className="text-xs text-muted-foreground">
            Still working — complex workers can take a couple of minutes. We&apos;ll
            open the editor automatically as soon as it&apos;s ready.
          </p>
          <button
            type="button"
            onClick={onCancel}
            className="mt-2 text-xs underline text-muted-foreground hover:text-foreground transition-colors"
          >
            Cancel and start over
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

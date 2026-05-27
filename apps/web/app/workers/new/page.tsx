"use client";

import { Suspense, use, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { toast } from "sonner";
import { Paperclip, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
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
      <div className="h-8 w-56 bg-[#e4e4e7] rounded-md" />
      <div className="h-4 w-80 bg-[#ececef] rounded-md" />
      <div className="h-[280px] bg-card border border-border rounded-lg" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page content
// ---------------------------------------------------------------------------

type UploadState = "idle" | "processing" | "navigating";

function NewWorkerContent() {
  const router = useRouter();
  const [prompt, setPrompt] = useState("");
  const [generating, setGenerating] = useState(false);
  const [uploadState, setUploadState] = useState<UploadState>("idle");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function getLivePrompt(): string {
    return (textareaRef.current?.value ?? prompt).trim();
  }

  // ---- Generate from prompt ------------------------------------------------

  async function handleGenerate(overridePrompt?: string) {
    const trimmed = overridePrompt ?? getLivePrompt();
    if (!trimmed) {
      toast.error("Describe what you want the worker to do");
      return;
    }
    if (overridePrompt) setPrompt(overridePrompt);
    setGenerating(true);
    try {
      const result = await api.workers.draftAndCreate({ prompt: trimmed });
      router.push(`/workers/${result.worker_id}/edit`);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to generate worker");
      setGenerating(false);
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
        router.push(`/workers/${result.worker_id}/edit`);
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
        router.push(`/workers/${result.worker_id}/edit`);
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
      router.push(`/workers/${worker.id}/edit`);
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
      router.push(`/workers/${worker.id}/edit`);
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

  // S24: when generating, swap the entire hero+pills surface for a
  // dedicated GeneratingPanel that auto-advances through 4 steps so the
  // user has a sense of progress instead of a frozen "Generating..." button.
  if (generating) {
    return (
      <div className="max-w-4xl mx-auto pt-8 pb-16">
        <GeneratingPanel prompt={prompt} />
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto space-y-6 pt-8 pb-16">
      {/* Page header. S22c (roast P2): dropped subtitle that duplicated the
          sidebar context. */}
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Create a worker</h1>
      </div>

      {/* Hero card */}
      <div className="rounded-lg border border-border bg-card p-6 space-y-4">
        <Textarea
          ref={textareaRef}
          placeholder="Summarise my Granola meetings and post action items to HubSpot CRM daily"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onInput={(e) => {
            const val = (e.target as HTMLTextAreaElement).value;
            if (val !== prompt) setPrompt(val);
          }}
          className="min-h-[120px] resize-none border-border text-sm focus-visible:ring-0 focus-visible:border-black placeholder:text-muted-foreground/50"
          disabled={isBusy}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              void handleGenerate();
            }
          }}
        />

        {/* Divider */}
        <div className="border-t border-[#f0f0f0]" />

        {/* Bottom row: upload (left) + generate (right).
            S22c (roast P1/P2): upload now reads as a button (border + padded
            rectangle), shortcut hint moves outside the disabled-button shadow
            so it remains visible. */}
        <div className="flex items-center justify-between gap-3">
          <button
            type="button"
            disabled={isBusy}
            onClick={() => fileInputRef.current?.click()}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-card px-3 text-xs font-medium text-foreground hover:bg-accent transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
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

      {/* Example chips. S22c (roast P1): first pill gets a "Try this" accent
          so users have a clear suggested starting point instead of 5
          equally-weighted options. */}
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">Or start from an example:</p>
        <div className="flex flex-wrap gap-2">
          {EXAMPLES.map((ex, idx) => (
            <button
              key={ex.label}
              type="button"
              disabled={isBusy}
              onClick={() => setPrompt(ex.prompt)}
              className={
                idx === 0
                  ? "inline-flex items-center text-xs font-medium px-3 py-1.5 rounded-full border border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)] hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
                  : "inline-flex items-center text-xs font-medium px-3 py-1.5 rounded-full border border-border bg-card text-foreground hover:bg-accent transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              }
            >
              {idx === 0 && (
                <span className="mr-1.5 inline-flex h-1.5 w-1.5 rounded-full bg-current opacity-70" aria-hidden="true" />
              )}
              {ex.label}
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

// S24: GeneratingPanel — replaces the frozen "Generating..." button with a
// real loading surface. Steps auto-advance on a timer (Drafting -> Writing
// run -> Validating -> Opening editor). The advancement is aspirational
// (we do not know which step the API is on); it gives users a sense of
// progress instead of a static spinner.
function GeneratingPanel({ prompt }: { prompt: string }) {
  const steps = [
    "Understanding what you want",
    "Drafting worker.yml",
    "Writing run.py + SKILL.md",
    "Validating + opening editor",
  ];
  const [activeStep, setActiveStep] = useState(0);

  useEffect(() => {
    const id = window.setInterval(() => {
      setActiveStep((prev) => Math.min(prev + 1, steps.length - 1));
    }, 2200);
    return () => window.clearInterval(id);
  }, [steps.length]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Creating your worker</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Floom is drafting code from your prompt. This usually takes 15-30 seconds.
        </p>
      </div>

      {prompt && (
        <div className="rounded-lg border border-line bg-[var(--bg-2)] px-4 py-3">
          <p className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1">
            Your prompt
          </p>
          <p className="text-sm text-foreground line-clamp-3">{prompt}</p>
        </div>
      )}

      <div className="rounded-lg border border-border bg-card p-6">
        <ol className="space-y-3">
          {steps.map((label, i) => {
            const done = i < activeStep;
            const current = i === activeStep;
            return (
              <li key={label} className="flex items-center gap-3">
                <span
                  className={
                    done
                      ? "inline-flex size-6 items-center justify-center rounded-full bg-[var(--accent)] text-[var(--solid-fg)]"
                      : current
                      ? "inline-flex size-6 items-center justify-center rounded-full border-2 border-[var(--accent)] bg-[var(--accent-soft)]"
                      : "inline-flex size-6 items-center justify-center rounded-full border border-line bg-card"
                  }
                  aria-hidden="true"
                >
                  {done ? (
                    <svg viewBox="0 0 16 16" fill="none" className="size-3.5">
                      <path d="M3 8l3.5 3.5L13 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  ) : current ? (
                    <Loader2 className="size-3 animate-spin text-[var(--accent)]" />
                  ) : null}
                </span>
                <span
                  className={
                    current
                      ? "text-sm font-medium text-foreground"
                      : done
                      ? "text-sm text-muted-foreground"
                      : "text-sm text-muted-foreground/60"
                  }
                >
                  {label}
                </span>
              </li>
            );
          })}
        </ol>

        <div className="mt-6 h-1 w-full overflow-hidden rounded-full bg-[var(--bg-2)]">
          <div
            className="h-full rounded-full bg-[var(--accent)] transition-[width] duration-500 ease-out"
            style={{ width: `${((activeStep + 1) / steps.length) * 100}%` }}
          />
        </div>
      </div>

      <p className="text-xs text-muted-foreground text-center">
        Keep this tab open. You will land in the worker editor when it is ready.
      </p>
    </div>
  );
}

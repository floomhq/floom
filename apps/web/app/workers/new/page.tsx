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

  if (generating) {
    return (
      <div className="max-w-4xl mx-auto pt-8 pb-16">
        <GeneratingPanel prompt={prompt} onCancel={() => setGenerating(false)} />
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto space-y-8 pt-12 pb-16">
      {/* S25: warmer landing. Centered hero, larger inviting heading.
          Dropped the brusque "Create a worker" for a question that gets
          the user to commit to a prompt. */}
      <div className="text-center space-y-3">
        <div className="inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-[var(--accent)] to-[var(--solid-2)] text-[var(--solid-fg)] shadow-[var(--shadow-md)]">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="size-7" aria-hidden="true">
            <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
            <circle cx="12" cy="12" r="4" />
          </svg>
        </div>
        <h1 className="text-3xl font-semibold tracking-tight">What should Floom automate?</h1>
        <p className="text-base text-muted-foreground max-w-xl mx-auto">
          Describe a task in plain English. Floom will draft the worker, pick the right
          integrations, and open the editor so you can review before running.
        </p>
      </div>

      {/* S25: hero textarea card sized to feel like the centerpiece, not a
          form field. Bigger min-height + tighter footer. */}
      <div className="rounded-xl border border-border bg-card p-5 shadow-[var(--shadow-sm)] space-y-4">
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

      {/* S25: examples promoted from pills to a tappable card grid with the
          full prompt visible. Less heartless: users see what kind of work
          Floom can do, not just abstract one-liners. */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium text-foreground">Or start from a popular workflow</p>
          {idx0NoteVisible(EXAMPLES) && (
            <span className="text-[11px] uppercase tracking-wider text-[var(--accent)]">
              Recommended first
            </span>
          )}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {EXAMPLES.map((ex, idx) => (
            <button
              key={ex.label}
              type="button"
              disabled={isBusy}
              onClick={() => setPrompt(ex.prompt)}
              className={
                idx === 0
                  ? "group flex flex-col items-start gap-1.5 rounded-lg border border-[var(--accent)] bg-[var(--accent-soft)] px-4 py-3 text-left hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
                  : "group flex flex-col items-start gap-1.5 rounded-lg border border-border bg-card px-4 py-3 text-left hover:bg-accent hover:border-muted-foreground/30 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              }
            >
              <span className={idx === 0 ? "text-sm font-semibold text-[var(--accent)]" : "text-sm font-semibold text-foreground"}>
                {ex.label}
              </span>
              <span className={idx === 0 ? "text-xs text-[var(--accent)] opacity-80 line-clamp-2" : "text-xs text-muted-foreground line-clamp-2"}>
                {ex.prompt}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function idx0NoteVisible(items: { label: string }[]): boolean {
  return items.length > 1;
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
// S25: honest indeterminate loader. Federico called the prior 4-step panel
// out for (a) hardcoding "Writing run.py + SKILL.md" which doesn't apply to
// every worker (pure-script vs agent), and (b) getting stuck on the last
// step forever when the API takes longer than 4*2.2s. Removed the fake
// progress. Single elegant indeterminate state with the prompt echoed,
// an animated indeterminate bar, an elapsed counter, and an escape hatch
// after 60s in case the request really hung.
function GeneratingPanel({ prompt, onCancel }: { prompt: string; onCancel?: () => void }) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const id = window.setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => window.clearInterval(id);
  }, []);

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div className="text-center space-y-3">
        <div className="inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-[var(--accent)] to-[var(--solid-2)] text-[var(--solid-fg)] shadow-[var(--shadow-md)]">
          <Loader2 className="size-7 animate-spin" aria-hidden="true" />
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">Drafting your worker</h1>
        <p className="text-sm text-muted-foreground max-w-md mx-auto">
          Floom is reading your prompt, picking integrations, and writing the worker files.
          Usually 15-30 seconds; rarely up to 60.
        </p>
      </div>

      {prompt && (
        <div className="rounded-lg border border-line bg-[var(--bg-2)] px-4 py-3">
          <p className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1">
            Your prompt
          </p>
          <p className="text-sm text-foreground whitespace-pre-wrap">{prompt}</p>
        </div>
      )}

      {/* Indeterminate progress bar - pure animation, not tied to fake steps */}
      <div className="space-y-2">
        <div className="h-1 w-full overflow-hidden rounded-full bg-[var(--bg-2)] relative">
          <div className="absolute inset-y-0 w-1/3 rounded-full bg-[var(--accent)] animate-[s25-slide_1.8s_ease-in-out_infinite]" />
        </div>
        <div className="flex justify-between text-[11px] text-muted-foreground">
          <span>Working...</span>
          <span>{formatElapsed(elapsed)}</span>
        </div>
      </div>

      {/* Escape hatch after 60s in case the request hung */}
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
        @keyframes s25-slide {
          0% { transform: translateX(-100%); }
          50% { transform: translateX(200%); }
          100% { transform: translateX(-100%); }
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

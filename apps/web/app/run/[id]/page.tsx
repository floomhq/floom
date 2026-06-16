"use client";

// /run/[id] — generic two-pane "run this worker" page.
//
// LEFT PANE  (~420px, fixed): worker identity + generic input form
// RIGHT PANE (flex-1):        live/idle/done run output panel
//
// STANDALONE — registered in AppShell.standalonePrefixes ("/run") so the
// app sidebar / Emily dock do NOT render here.
//
// AUTH MODES:
//   Authed user  → worker loaded via api.workers.get (full WorkerDetail).
//   Public token → TODO (Codex must add): a new backend endpoint
//                  POST /workers/public/{id}/runs that accepts a share token
//                  and runs the worker on behalf of the workspace owner.
//                  Until that endpoint exists, unauthenticated visitors get an
//                  "Authentication required" message and a login link.
//                  See the TODO block below for the exact contract.
//
// This page works TODAY for any authenticated user who has access to the worker.
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { WorkerAvatar } from "@/components/WorkerAvatar";
import { BrandLogo } from "@/components/connections/BrandLogo";
import { WorkerInputForm, requiredRunInputErrors } from "@/components/run-page/WorkerInputForm";
import { RunPanel } from "@/components/run-page/RunPanel";
import { FloomMark } from "@/components/share/ShareCardShell";
import { api } from "@/lib/api";
import type { WorkerDetail, WorkerInput } from "@/lib/types";

// Normalize connection slugs to the BrandLogo's expected format
// (mirrors WorkerShareCard's normalizeSlug / SLUG_ALIASES).
const SLUG_ALIASES: Record<string, string> = {
  googlecalendar: "google-calendar",
  googledrive: "google-drive",
  googledocs: "google-docs",
  googlesheets: "google-sheets",
  googlemeet: "google-meet",
};
function normalizeSlug(slug: string): string {
  const lower = slug.toLowerCase();
  return SLUG_ALIASES[lower] ?? lower;
}

// Extract plain slug strings from the mixed WorkerConnectionSpec union.
function connectionSlugs(worker: WorkerDetail): string[] {
  const slugs: string[] = [];
  for (const c of worker.config.connections) {
    if (typeof c === "string") slugs.push(c);
    else if ("app" in c && typeof c.app === "string") slugs.push(c.app);
    else if ("composio" in c) {
      // composio connections don't carry a slug we can render
    }
  }
  return slugs;
}

// ---- Left pane: worker identity ----

function WorkerIdentityPanel({ worker }: { worker: WorkerDetail }) {
  const slugs = connectionSlugs(worker);
  return (
    <div className="space-y-3">
      {/* Avatar + name */}
      <div className="flex items-center gap-3">
        <WorkerAvatar
          name={worker.name}
          size="size-10"
          className="rounded-[var(--radius-squircle)]"
        />
        <div className="min-w-0">
          <p className="font-semibold text-[var(--ink)] truncate">{worker.name}</p>
          {worker.config.trigger?.type && (
            <p className="text-xs text-muted-foreground capitalize">
              {worker.config.trigger.type === "schedule"
                ? "Runs on a schedule"
                : worker.config.trigger.type === "webhook"
                  ? "Runs on a webhook"
                  : "Runs on demand"}
            </p>
          )}
        </div>
      </div>

      {/* Description */}
      {worker.description && (
        <p className="text-sm text-muted-foreground leading-relaxed">
          {worker.description}
        </p>
      )}

      {/* Tool logos */}
      {slugs.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {slugs.map((slug) => (
            <BrandLogo
              key={slug}
              icon={normalizeSlug(slug)}
              className="opacity-70"
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ---- Main page ----

export default function RunWorkerPage() {
  const { id } = useParams<{ id: string }>();
  // Support an optional share ?token= param for future public-run path.
  const searchParams = useSearchParams();
  const token = searchParams.get("token");

  const [worker, setWorker] = useState<WorkerDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [inputs, setInputs] = useState<Record<string, unknown>>({});
  const [fileNames, setFileNames] = useState<Record<string, string>>({});
  const [validationErrors, setValidationErrors] = useState<Record<string, string>>({});
  const [running, setRunning] = useState(false);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);

  // Load worker (authed path).
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setLoading(true);
    setLoadError(null);

    api.workers.get(id).then(
      (detail) => {
        if (cancelled) return;
        setWorker(detail);
        // Pre-fill defaults.
        const defaults: Record<string, unknown> = {};
        for (const inp of detail.config.inputs) {
          if (inp.default !== undefined && inp.default !== null) {
            defaults[inp.name] = inp.default;
          }
        }
        setInputs(defaults);
        setLoading(false);
      },
      (err: unknown) => {
        if (cancelled) return;
        const msg =
          err instanceof Error ? err.message : "Failed to load worker";
        setLoadError(msg);
        setLoading(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [id]);

  const handleInputChange = useCallback(
    (name: string, value: unknown) => {
      setInputs((prev) => ({ ...prev, [name]: value }));
      // Clear validation error on edit.
      setValidationErrors((prev) => {
        if (!prev[name]) return prev;
        const next = { ...prev };
        delete next[name];
        return next;
      });
    },
    [],
  );

  const handleFileUploaded = useCallback(
    (name: string, sha256: string, fileName: string) => {
      setInputs((prev) => ({ ...prev, [name]: sha256 }));
      setFileNames((prev) => ({ ...prev, [name]: fileName }));
    },
    [],
  );

  async function handleRun() {
    if (!worker) return;
    const errors = requiredRunInputErrors(worker.config.inputs, inputs);
    if (Object.keys(errors).length > 0) {
      setValidationErrors(errors);
      toast.error("Fill required inputs before running");
      return;
    }
    setValidationErrors({});
    setRunning(true);
    setActiveRunId(null); // reset so the panel returns to running state
    try {
      const result = await api.workers.run(worker.id, inputs);
      if (!result.run_id) throw new Error("Run ID missing from API response");
      setActiveRunId(result.run_id);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to start run");
    } finally {
      setRunning(false);
    }
  }

  // ---- Render states ----

  // Loading
  if (loading) {
    return (
      <RunPageShell>
        <div className="flex items-center justify-center h-64 text-sm text-muted-foreground">
          Loading worker…
        </div>
      </RunPageShell>
    );
  }

  // Error — covers 401 (will say "Not authorized") and 404
  if (loadError || !worker) {
    // TODO (Codex): when this page is accessed with a ?token= param and the
    // api.workers.get call returns 401, we should instead call a new backend
    // endpoint:
    //
    //   GET /workers/public/{id}/run-meta?token=<share_token>
    //
    // which returns a subset of WorkerDetail sufficient to render the run form
    // (name, description, connections, config.inputs, config.outputs).
    // Then the "Run" button calls:
    //
    //   POST /workers/public/{id}/runs
    //   Body: { inputs: {...}, token: "<share_token>" }
    //
    // The backend authenticates via the HMAC share token and runs the worker as
    // the workspace owner, returning { run_id }. The stream endpoint
    // GET /runs/{run_id}/stream must also accept the share token as a query
    // param so the public viewer can subscribe.
    //
    // Until that backend is in place, unauthenticated visitors see a login gate.
    const isUnauthed =
      loadError?.toLowerCase().includes("unauthorized") ||
      loadError?.toLowerCase().includes("not authorized") ||
      loadError?.includes("401");

    return (
      <RunPageShell>
        <div className="flex flex-col items-center justify-center h-64 gap-4 text-center px-6">
          {isUnauthed ? (
            <>
              <p className="text-sm text-[var(--ink)]">
                Sign in to run this worker.
              </p>
              <Link href={`/login?next=${encodeURIComponent(`/run/${id}${token ? `?token=${token}` : ""}`)}`}>
                <Button>Sign in</Button>
              </Link>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              {loadError ?? "Worker not found."}
            </p>
          )}
        </div>
      </RunPageShell>
    );
  }

  const isEnabled = worker.enabled !== false;

  return (
    <RunPageShell>
      <div className="flex flex-col md:flex-row min-h-0 flex-1">
        {/* LEFT PANE */}
        <aside
          className="shrink-0 border-b border-[var(--border-soft)] md:border-b-0 md:border-r md:overflow-y-auto"
          style={{ width: "100%", maxWidth: 420 }}
        >
          <div className="p-5 space-y-6">
            <WorkerIdentityPanel worker={worker} />

            <div className="h-px bg-[var(--border-soft)]" />

            {/* Input form */}
            <WorkerInputForm
              inputs={worker.config.inputs as WorkerInput[]}
              values={inputs}
              fileNames={fileNames}
              validationErrors={validationErrors}
              onInputChange={handleInputChange}
              onFileUploaded={handleFileUploaded}
              csvRequiredColumns={worker.config.csv_required_columns}
            />

            {/* Run button */}
            <Button
              className="w-full"
              onClick={handleRun}
              disabled={running || !isEnabled}
              title={!isEnabled ? "This worker is paused" : undefined}
            >
              {running ? "Starting…" : "Run worker"}
            </Button>

            {!isEnabled && (
              <p className="text-xs text-muted-foreground text-center">
                This worker is currently paused.
              </p>
            )}
          </div>
        </aside>

        {/* RIGHT PANE */}
        <main className="flex-1 min-w-0 overflow-y-auto">
          <div className="p-5">
            <RunPanel runId={activeRunId} />
          </div>
        </main>
      </div>
    </RunPageShell>
  );
}

// Shell: top nav + border card, no sidebar. Mirrors ShareCardShell style but
// with a wider max-width appropriate for a two-pane layout.
function RunPageShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto w-full px-3 py-10" style={{ maxWidth: 1080 }}>
      <div
        className="rounded-[var(--radius-card)] border border-[var(--border-soft)] bg-[var(--bg-app)] shadow-[var(--shadow-pop)] overflow-hidden flex flex-col"
        style={{ minHeight: 560 }}
      >
        {/* Nav */}
        <div className="flex items-center justify-between border-b border-[var(--border-soft)] bg-[var(--bg-card)] px-5 py-3 shrink-0">
          <FloomMark />
        </div>
        {children}
      </div>
    </div>
  );
}

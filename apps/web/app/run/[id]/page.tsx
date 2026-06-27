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
import { ArrowLeft } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Avatar } from "@/components/ui/Avatar";
import { BrandLogo } from "@/components/connections/BrandLogo";
import {
  getConnectionAccountLabel,
  getSupportedApp,
  maskAccountLabel,
  normalizeAppSlug,
  type ConnectionRecord,
} from "@/components/connections/connection-data";
import { WorkerInputForm, requiredRunInputErrors } from "@/components/run-page/WorkerInputForm";
import { RunPanel } from "@/components/run-page/RunPanel";
import { FloomMark } from "@/components/share/ShareCardShell";
import { api } from "@/lib/api";
import type { ConnectionItem, WorkerDetail, WorkerInput } from "@/lib/types";

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

// Match a worker connection slug to a connected account from the workspace's
// connections list (api.connections.list). Composio app_names arrive in a few
// separator variants, so normalize both sides before comparing.
function findConnectionForSlug(
  slug: string,
  connections: ConnectionItem[],
): ConnectionItem | undefined {
  const target = normalizeAppSlug(slug);
  return connections.find((c) => normalizeAppSlug(c.app_name || "") === target);
}

// One row per app the worker uses, showing WHICH connected account it will act
// as (e.g. Gmail -> fe•••@gmail.com). This answers "which Google account is
// this worker bound to?" right on the run surface instead of forcing a trip to
// /connections. The email local-part is masked (maskAccountLabel) so we never
// print a full personal address in plain view.
function WorkerConnectionRow({
  slug,
  connection,
}: {
  slug: string;
  connection: ConnectionItem | undefined;
}) {
  const app = getSupportedApp(slug);
  const accountLabel = connection
    ? maskAccountLabel(getConnectionAccountLabel(connection as ConnectionRecord))
    : null;
  return (
    <div className="flex items-center gap-2.5 text-sm">
      <span className="shrink-0">
        <BrandLogo icon={normalizeSlug(slug)} className="size-4 opacity-80" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[var(--ink)]">{app.displayName}</span>
        {accountLabel ? (
          <span className="block truncate text-xs text-muted-foreground">{accountLabel}</span>
        ) : (
          <Link
            href="/connections"
            className="block text-xs text-[var(--accent)] no-underline hover:underline"
          >
            Not connected · Connect
          </Link>
        )}
      </span>
    </div>
  );
}

function WorkerIdentityPanel({
  worker,
  connections,
}: {
  worker: WorkerDetail;
  connections: ConnectionItem[] | null;
}) {
  const slugs = connectionSlugs(worker);
  return (
    <div className="space-y-3">
      {/* Identity mark + name — a worker is a non-human entity (squircle). */}
      <div className="flex items-center gap-3">
        <Avatar role="worker" id={worker.id} name={worker.name} size={36} />
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

      {/* Connected accounts — which account each tool acts as. While the
          connections list is loading we fall back to bare brand logos so the
          panel never flickers an empty state. */}
      {slugs.length > 0 &&
        (connections === null ? (
          <div className="flex flex-wrap items-center gap-1.5">
            {slugs.map((slug) => (
              <BrandLogo key={slug} icon={normalizeSlug(slug)} className="opacity-70" />
            ))}
          </div>
        ) : (
          <div className="space-y-2 rounded-[var(--radius-card)] bg-[var(--bg-2)] px-3 py-2.5">
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
              Acts as
            </p>
            <div className="space-y-2">
              {slugs.map((slug) => (
                <WorkerConnectionRow
                  key={slug}
                  slug={slug}
                  connection={findConnectionForSlug(slug, connections)}
                />
              ))}
            </div>
          </div>
        ))}
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
  const [loadSlow, setLoadSlow] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Workspace connections, used to show WHICH account each tool acts as.
  // null = not loaded yet (panel shows bare logos until it resolves).
  const [connections, setConnections] = useState<ConnectionItem[] | null>(null);

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
    setLoadSlow(false);
    setLoadError(null);

    // A slow backend (cold container) should not read as a frozen page: after
    // a few seconds, swap the copy to a "waking up" hint instead of a silent
    // spinner that looks like a hang.
    const slowTimer = setTimeout(() => {
      if (!cancelled) setLoadSlow(true);
    }, 4000);

    api.workers.getRunMeta(id).then(
      (detail) => {
        if (cancelled) return;
        clearTimeout(slowTimer);
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
        clearTimeout(slowTimer);
        const msg =
          err instanceof Error ? err.message : "Failed to load agent";
        setLoadError(msg);
        setLoading(false);
      },
    );
    return () => {
      cancelled = true;
      clearTimeout(slowTimer);
    };
  }, [id]);

  // Load workspace connections so the identity panel can show the bound account
  // per tool. Best-effort: a failure just leaves the panel on bare logos.
  useEffect(() => {
    let cancelled = false;
    api.connections.list().then(
      (rows) => {
        if (!cancelled) setConnections(rows);
      },
      () => {
        if (!cancelled) setConnections([]);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

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

  // Where "Back" returns to: the worker's detail pane if we know the id, else
  // the Workers list. The /run page is a standalone takeover (no app sidebar),
  // so this is the only way back into the app.
  const backHref = id ? `/workers?sel=${encodeURIComponent(id)}` : "/workers";

  // Loading
  if (loading) {
    return (
      <RunPageShell backHref={backHref}>
        <div className="flex items-center justify-center h-64 text-sm text-muted-foreground">
          {loadSlow ? "Waking the agent... one moment" : "Loading agent..."}
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
      <RunPageShell backHref={backHref}>
        <div className="flex flex-col items-center justify-center h-64 gap-4 text-center px-6">
          {isUnauthed ? (
            <>
              <p className="text-sm text-[var(--ink)]">
                Sign in to run this agent.
              </p>
              <Link href={`/login?next=${encodeURIComponent(`/run/${id}${token ? `?token=${token}` : ""}`)}`}>
                <Button>Sign in</Button>
              </Link>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              {loadError ?? "Agent not found."}
            </p>
          )}
        </div>
      </RunPageShell>
    );
  }

  const isEnabled = worker.enabled !== false;

  return (
    <RunPageShell backHref={backHref}>
      <div className="flex flex-col md:flex-row min-h-0 flex-1">
        {/* LEFT PANE */}
        <aside
          className="shrink-0 bg-[var(--bg-card)] md:overflow-y-auto md:[border-right:var(--bd-div)]"
          style={{ width: "100%", maxWidth: 420 }}
        >
          <div className="p-5 space-y-6">
            <div className="[border-bottom:var(--bd-div)] pb-6">
              <WorkerIdentityPanel worker={worker} connections={connections} />
            </div>

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
              title={!isEnabled ? "This agent is paused" : undefined}
            >
              {running ? "Starting…" : "Run agent"}
            </Button>

            {!isEnabled && (
              <p className="text-xs text-muted-foreground text-center">
                This agent is currently paused.
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
//
// The /run page is a standalone takeover (AppShell.standalonePrefixes), so it
// renders WITHOUT the app sidebar. The nav therefore carries an explicit Back
// control — otherwise the only nav element is the Floom wordmark (which leaves
// the app to the marketing root), leaving the user stranded with no way back
// into the dashboard.
function RunPageShell({
  children,
  backHref = "/workers",
}: {
  children: React.ReactNode;
  backHref?: string;
}) {
  return (
    <div className="mx-auto w-full px-3 py-10" style={{ maxWidth: 1080 }}>
      <div
        className="rounded-[var(--radius-card)] bg-[var(--bg-card)] shadow-[var(--shadow-pop)] overflow-hidden flex flex-col"
        style={{ minHeight: 560 }}
      >
        {/* Nav */}
        <div className="flex items-center gap-3 [border-bottom:var(--bd-div)] px-5 py-3 shrink-0">
          <Link
            href={backHref}
            aria-label="Back to agent"
            className="inline-flex items-center gap-1.5 text-sm text-muted-foreground no-underline transition-colors hover:text-[var(--ink)]"
          >
            <ArrowLeft className="size-4" />
            Back
          </Link>
          <span className="h-4 w-px bg-[var(--border)]" aria-hidden="true" />
          <FloomMark />
        </div>
        {children}
      </div>
    </div>
  );
}

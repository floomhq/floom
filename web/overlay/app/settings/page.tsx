"use client";

export const dynamic = "force-dynamic";

import Link from "next/link";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { toast } from "sonner";

import { api } from "@/lib/api";
import type {
  PlatformConfig,
  SystemInfo,
  WorkspaceAgentInfo,
  WorkspaceImportResult,
} from "@/lib/types";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CliCommandPanel } from "@/components/CliCommandPanel";
import { ThemeModeToggleGroup } from "@/components/ThemeModeToggleGroup";
import { AlertTriangle, CheckCircle2, Download, Trash2 } from "lucide-react";

// S22f: Notifications tab is currently hidden. The TabKey type still includes
// it so the URL ?tab=notifications doesn't blow up; we just silently fall back
// to "api" when a hidden tab is requested.
type TabKey =
  | "workspace"
  | "api"
  | "system"
  | "assistant"
  | "notifications"
  | "appearance"
  | "data"
  | "danger";

const VISIBLE_TAB_KEYS: TabKey[] = ["workspace", "api", "system", "appearance", "data", "danger"];
const TAB_KEYS: TabKey[] = [
  "workspace",
  "api",
  "system",
  "assistant",
  "notifications",
  "appearance",
  "data",
  "danger",
];
const API_PROXY_BASE = process.env.NEXT_PUBLIC_API_PROXY_BASE || "/api/proxy";
const ACTIVE_WORKSPACE_STORAGE_KEY = "workeros.activeWorkspaceId";

type TelemetryPreferenceResponse = {
  product_telemetry_enabled: boolean;
};

type TelemetryExportResponse = {
  events: Record<string, unknown>[];
};

function isValidTab(value: string | null): value is TabKey {
  return value !== null && TAB_KEYS.includes(value as TabKey);
}

function activeWorkspaceHeaders(headers?: HeadersInit): Headers {
  const next = new Headers(headers);
  if (typeof window === "undefined") return next;
  const workspaceId = window.localStorage.getItem(ACTIVE_WORKSPACE_STORAGE_KEY);
  if (workspaceId && workspaceId !== "local-default") {
    next.set("x-workeros-workspace", workspaceId);
  }
  return next;
}

export default function SettingsPage() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">Loading settings...</div>}>
      <SettingsContent />
    </Suspense>
  );
}

function SettingsContent() {
  const searchParams = useSearchParams();
  const fromInstallChannel = searchParams.get("from_install");
  // S28: tabs use URL hash now (#api, #danger, etc.). Fall back to legacy
  // ?tab= for old links.
  // S30: own the hash via the History API instead of router.replace. The App
  // Router treated a same-pathname `#hash` navigation as an append (clicking
  // System then Appearance produced `/settings#system#appearance`), so the tab
  // could only switch once per load. We are the single source of truth for the
  // hash now: state drives history.replaceState, and a hashchange listener
  // keeps deep-links + back/forward in sync.
  const initialTab = (() => {
    const fromHash =
      typeof window !== "undefined" ? window.location.hash.replace(/^#/, "") : null;
    const fromQuery = searchParams.get("tab");
    const candidate = fromHash || fromQuery;
    // S22f: hidden tab (e.g. notifications) requested via URL falls back to workspace.
    return isValidTab(candidate) && VISIBLE_TAB_KEYS.includes(candidate)
      ? candidate
      : "workspace";
  })();
  const [tab, setTab] = useState<TabKey>(initialTab);

  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [platformConfig, setPlatformConfig] = useState<PlatformConfig | null>(null);
  const [workspaceAgent, setWorkspaceAgent] = useState<WorkspaceAgentInfo | null>(null);
  const [workspaceAgentLoading, setWorkspaceAgentLoading] = useState(false);
  const [workspaceAgentError, setWorkspaceAgentError] = useState<string | null>(null);
  const [reloading, setReloading] = useState(false);
  const [clearing, setClearing] = useState(false);
  // PR S19 (I-44): type-to-confirm text for the Clear runs button.
  const [clearConfirmText, setClearConfirmText] = useState("");

  // Duplicate workspace: export this workspace as a .zip template / import one.
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<WorkspaceImportResult | null>(null);
  const importFileRef = useRef<HTMLInputElement | null>(null);
  const [telemetryEnabled, setTelemetryEnabled] = useState<boolean | null>(null);
  const [telemetryLoading, setTelemetryLoading] = useState(false);
  const [telemetrySaving, setTelemetrySaving] = useState(false);
  const [telemetryExporting, setTelemetryExporting] = useState(false);
  const [telemetryDeleting, setTelemetryDeleting] = useState(false);
  const [telemetryLastExportCount, setTelemetryLastExportCount] = useState<number | null>(null);

  const loadData = useCallback(async () => {
    try {
      const [infoRes, platformRes] = await Promise.all([
        api.system.info(),
        api.system.platformConfig(),
      ]);
      setInfo(infoRes);
      setPlatformConfig(platformRes);
    } catch (e) {
      console.error(e);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  useEffect(() => {
    if (window.location.hash.replace(/^#/, "") === "assistant") {
      window.location.replace("/assistant#instructions");
    }
  }, []);

  const loadTelemetryPreference = useCallback(async () => {
    setTelemetryLoading(true);
    try {
      const res = await fetch(`${API_PROXY_BASE}/telemetry/preferences`, {
        headers: activeWorkspaceHeaders(),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as TelemetryPreferenceResponse;
      setTelemetryEnabled(Boolean(body.product_telemetry_enabled));
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to load data settings");
    } finally {
      setTelemetryLoading(false);
    }
  }, []);

  useEffect(() => {
    if (tab !== "data" || telemetryEnabled !== null || telemetryLoading) return;
    void loadTelemetryPreference();
  }, [loadTelemetryPreference, tab, telemetryEnabled, telemetryLoading]);

  // Keep state in sync with the URL hash for deep-links and back/forward.
  useEffect(() => {
    function syncFromHash() {
      const fromHash = window.location.hash.replace(/^#/, "");
      if (isValidTab(fromHash) && VISIBLE_TAB_KEYS.includes(fromHash)) {
        setTab((prev) => (prev === fromHash ? prev : fromHash));
      }
    }
    window.addEventListener("hashchange", syncFromHash);
    return () => window.removeEventListener("hashchange", syncFromHash);
  }, []);

  // Lazy-load the workspace agent prompt + tools only when the tab is opened —
  // the system prompt can be large, so we don't fetch it on every settings view.
  // NOTE: workspaceAgentLoading is intentionally excluded from the dep array.
  // Including it caused the effect to re-run (and cancel the in-flight fetch)
  // the moment setWorkspaceAgentLoading(true) was called, leaving loading=true
  // forever. The guard below still reads the current value via closure; the only
  // triggers we want are a tab switch or data arriving (workspaceAgent).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (tab !== "assistant" || workspaceAgent || workspaceAgentLoading) return;
    let cancelled = false;
    setWorkspaceAgentLoading(true);
    setWorkspaceAgentError(null);
    api.system
      .workspaceAgent()
      .then((res) => {
        if (!cancelled) setWorkspaceAgent(res);
      })
      .catch((e: unknown) => {
        if (!cancelled) setWorkspaceAgentError(e instanceof Error ? e.message : "Failed to load");
      })
      .finally(() => {
        if (!cancelled) setWorkspaceAgentLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tab, workspaceAgent]);

  function handleTabChange(value: string) {
    if (!isValidTab(value)) return;
    setTab(value);
    // S30: set the hash to exactly the clicked tab via the History API so it
    // REPLACES rather than appends. Drop the legacy ?tab= param if present.
    const params = new URLSearchParams(searchParams.toString());
    params.delete("tab");
    const qs = params.size ? `?${params.toString()}` : "";
    window.history.replaceState(null, "", `/settings${qs}#${value}`);
  }

  async function handleReload() {
    setReloading(true);
    try {
      const res = await api.workers.reload();
      toast.success(`Loaded ${res.workers_loaded} workers`);
      void loadData();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to reload");
    } finally {
      setReloading(false);
    }
  }

  async function handleClearRuns() {
    if (clearConfirmText.trim() !== "DELETE ALL RUNS") return;
    setClearing(true);
    try {
      await api.system.clearRuns();
      toast.success("Run history cleared");
      setClearConfirmText("");
      void loadData();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to clear runs");
    } finally {
      setClearing(false);
    }
  }

  async function handleExportWorkspace() {
    setExporting(true);
    try {
      const { blob, filename } = await api.workspace.exportTemplate();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success("Workspace template downloaded");
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to export workspace");
    } finally {
      setExporting(false);
    }
  }

  async function handleImportWorkspace(file: File) {
    setImporting(true);
    setImportResult(null);
    try {
      const result = await api.workspace.importTemplate(file);
      setImportResult(result);
      const n = result.workers_imported.length + result.contexts_imported.length;
      toast.success(
        n > 0 ? `Imported ${n} item${n === 1 ? "" : "s"}` : "Nothing new to import"
      );
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to import workspace");
    } finally {
      setImporting(false);
      if (importFileRef.current) importFileRef.current.value = "";
    }
  }

  async function updateTelemetryPreference(enabled: boolean) {
    setTelemetrySaving(true);
    try {
      const res = await fetch(`${API_PROXY_BASE}/telemetry/preferences`, {
        method: "PUT",
        headers: activeWorkspaceHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ product_telemetry_enabled: enabled }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as TelemetryPreferenceResponse;
      setTelemetryEnabled(Boolean(body.product_telemetry_enabled));
      toast.success(enabled ? "Product telemetry enabled" : "Product telemetry disabled");
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to update data settings");
    } finally {
      setTelemetrySaving(false);
    }
  }

  async function handleExportTelemetry() {
    setTelemetryExporting(true);
    try {
      const res = await fetch(`${API_PROXY_BASE}/telemetry/export?limit=1000`, {
        headers: activeWorkspaceHeaders(),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as TelemetryExportResponse;
      const events = Array.isArray(body.events) ? body.events : [];
      const blob = new Blob([JSON.stringify({ events }, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `workeros-telemetry-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setTelemetryLastExportCount(events.length);
      toast.success(`Exported ${events.length} telemetry event${events.length === 1 ? "" : "s"}`);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to export telemetry");
    } finally {
      setTelemetryExporting(false);
    }
  }

  async function handleDeleteTelemetry() {
    if (!confirm("Delete all product telemetry events for this workspace?")) return;
    setTelemetryDeleting(true);
    try {
      const res = await fetch(`${API_PROXY_BASE}/telemetry/workspace`, {
        method: "DELETE",
        headers: activeWorkspaceHeaders(),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { deleted?: number };
      setTelemetryLastExportCount(0);
      toast.success(`Deleted ${body.deleted ?? 0} telemetry event${body.deleted === 1 ? "" : "s"}`);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to delete telemetry");
    } finally {
      setTelemetryDeleting(false);
    }
  }

  async function copySecretName(name: string) {
    try {
      await navigator.clipboard.writeText(name);
      toast.success(`Copied ${name}`);
    } catch {
      toast.error("Could not copy name");
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          System configuration and access.
        </p>
      </div>

      {fromInstallChannel ? (
        <Alert>
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>
            {fromInstallChannel === "slack" ? "Connect Slack to continue" : `Finish ${fromInstallChannel} setup`}
          </AlertTitle>
          <AlertDescription>
            {fromInstallChannel === "slack"
              ? "Open Assistant to connect Slack OAuth for this workspace."
              : "This install channel needs platform credentials before setup can finish."}
          </AlertDescription>
        </Alert>
      ) : null}

      {/* S22f: hide Notifications tab. Roast P1: it shipped two "Soon"
          placeholder toggles, which read as "this team ships features that
          don't exist yet". When the feature ships, restore the tab. */}
      <Tabs value={tab} onValueChange={handleTabChange}>
        {/* S30: on narrow viewports the w-fit tab strip ran off the right edge
            (scrollWidth 489 > 375) and clipped "Danger zone", forcing a
            horizontal page scroll. Wrap it in an overflow-x-auto, full-width
            container with a hidden scrollbar so the page stays at viewport
            width while the strip scrolls internally. Desktop is unchanged: the
            strip fits, so nothing scrolls. */}
        <div className="-mx-1 max-w-full overflow-x-auto px-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <TabsList>
          <TabsTrigger value="workspace">Workspace</TabsTrigger>
          <TabsTrigger value="api">API access</TabsTrigger>
          <TabsTrigger value="system">System</TabsTrigger>
          <TabsTrigger value="appearance">Appearance</TabsTrigger>
          <TabsTrigger value="data">Data</TabsTrigger>
          <TabsTrigger value="danger">Danger zone</TabsTrigger>
        </TabsList>
        </div>

        <TabsContent value="workspace" className="space-y-4">
          <WorkspaceSettingsTab />
        </TabsContent>

        <TabsContent value="api" className="space-y-4">
          <CliCommandPanel />
        </TabsContent>

        <TabsContent value="system" className="space-y-8">
          {/* S29s: dropped Card wrappers. Match sister tabs (API access,
              Appearance) which also flat-section now. */}
          <section className="space-y-3">
            <h2 className="text-sm font-medium text-muted-foreground">System info</h2>
            <div className="space-y-3 text-sm">
              {info ? (
                <>
                  <Row label="Version" value={info.version} mono />
                  <Row label="Started at" value={info.started_at} mono />
                  <Row label="Python" value={info.python_version} mono />
                  <Row label="Runner" value={info.runner} />
                </>
              ) : (
                <div className="space-y-3">
                  {[120, 96, 80].map((w, i) => (
                    <div key={i} className="flex justify-between items-center">
                      <Skeleton className="h-4" style={{ width: 80 }} />
                      <Skeleton className="h-4" style={{ width: w }} />
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>

          <section className="space-y-3">
            <h2 className="text-sm font-medium text-muted-foreground">Platform configuration</h2>
            <div className="space-y-3">
              {!platformConfig ? (
                <Skeleton className="h-12 w-full" />
              ) : (
                <>
                  <div className="flex items-center justify-between bg-muted p-3">
                    <span className="text-sm">Configured</span>
                    <span className="text-sm font-medium">
                      {platformConfig.set_count}/{platformConfig.required_count}
                    </span>
                  </div>
                  {platformConfig.all_required_set ? (
                    <Alert>
                      <CheckCircle2 className="size-4" />
                      <AlertTitle>All required secrets are set</AlertTitle>
                      <AlertDescription>
                        Workers can run with full platform configuration.
                      </AlertDescription>
                    </Alert>
                  ) : (
                    <Alert variant="destructive">
                      <AlertTriangle className="size-4" />
                      <AlertTitle>
                        {platformConfig.missing.length} required{" "}
                        {platformConfig.missing.length === 1 ? "secret" : "secrets"} missing
                      </AlertTitle>
                      <AlertDescription>
                        <div className="mt-2 space-y-1.5">
                          {platformConfig.missing.map((name) => (
                            <div
                              key={name}
                              className="flex items-center justify-between gap-2"
                            >
                              <code className="text-xs">{name}</code>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => void copySecretName(name)}
                              >
                                Copy name
                              </Button>
                            </div>
                          ))}
                        </div>
                      </AlertDescription>
                    </Alert>
                  )}
                </>
              )}
            </div>
          </section>
        </TabsContent>

        <TabsContent value="assistant" className="space-y-8">
          <section className="space-y-2">
            <h2 className="text-sm font-medium text-muted-foreground">Workspace agent</h2>
            <p className="text-sm text-muted-foreground">
              This is the assistant behind <code className="text-foreground">/chat</code>. It reads
              your workspace and can manage workers, runs, secrets, connections, brain packs, and
              approvals on your behalf. The instructions and tools below are read-only.
            </p>
          </section>

          {workspaceAgentLoading && !workspaceAgent ? (
            <div className="space-y-3">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-48 w-full" />
            </div>
          ) : workspaceAgentError ? (
            <Alert variant="destructive">
              <AlertTriangle className="size-4" />
              <AlertTitle>Couldn&apos;t load the workspace agent</AlertTitle>
              <AlertDescription>{workspaceAgentError}</AlertDescription>
            </Alert>
          ) : workspaceAgent ? (
            <>
              <section className="space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-medium">System instructions</h3>
                  <Badge variant="outline" className="text-xs">
                    Read-only
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground">
                  The full system prompt the agent runs with, including the live workspace snapshot.
                </p>
                <pre className="max-h-[28rem] overflow-auto whitespace-pre-wrap break-words rounded-[var(--radius-button)] border border-[var(--border-default)] bg-muted/40 p-4 font-mono text-xs leading-relaxed text-foreground">
                  {workspaceAgent.system_prompt}
                </pre>
              </section>

              <section className="space-y-3">
                <h3 className="text-sm font-medium">
                  Tools <span className="text-muted-foreground">({workspaceAgent.tools.length})</span>
                </h3>
                <p className="text-xs text-muted-foreground">
                  The management actions the agent can call. It never returns secret values.
                </p>
                <div className="divide-y divide-[var(--border-default)] rounded-[var(--radius-button)] border border-[var(--border-default)]">
                  {workspaceAgent.tools.map((tool) => (
                    <div key={tool.name} className="px-3 py-2.5">
                      <code className="text-xs font-medium text-foreground">{tool.name}</code>
                      {tool.description && (
                        <p className="mt-0.5 text-xs text-muted-foreground">{tool.description}</p>
                      )}
                    </div>
                  ))}
                </div>
              </section>
            </>
          ) : null}

          {/* Duplicate workspace (Notion-template style). Export bundles your
              workers + knowledge packs + workspace agent config into one .zip;
              import unpacks one into this workspace. Secrets/connections are
              NEVER bundled — you reconnect those after import. */}
          <section className="space-y-4 border-t border-[var(--border-default)] pt-8">
            <div className="space-y-1">
              <h2 className="text-sm font-medium text-muted-foreground">Duplicate workspace</h2>
              <p className="text-sm text-muted-foreground">
                Move or share your whole setup as a template.
              </p>
            </div>

            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="text-sm font-medium">Export this workspace as a template</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Bundles your workers and knowledge packs into one .zip. Secrets and
                  connections are not included — you&apos;ll reconnect those.
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="shrink-0"
                onClick={handleExportWorkspace}
                disabled={exporting}
              >
                {exporting ? "Exporting..." : "Export template"}
              </Button>
            </div>

            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="text-sm font-medium">Import a workspace template</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Adds the template&apos;s workers and knowledge packs to this workspace.
                  Existing items are kept — nothing is overwritten.
                </p>
              </div>
              <input
                ref={importFileRef}
                type="file"
                accept=".zip,application/zip"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void handleImportWorkspace(file);
                }}
              />
              <Button
                variant="outline"
                size="sm"
                className="shrink-0"
                onClick={() => importFileRef.current?.click()}
                disabled={importing}
              >
                {importing ? "Importing..." : "Import template"}
              </Button>
            </div>

            {importResult ? (
              <Alert>
                <CheckCircle2 className="size-4" />
                <AlertTitle>
                  Imported {importResult.workers_imported.length}{" "}
                  {importResult.workers_imported.length === 1 ? "worker" : "workers"} and{" "}
                  {importResult.contexts_imported.length}{" "}
                  {importResult.contexts_imported.length === 1 ? "knowledge pack" : "knowledge packs"}
                </AlertTitle>
                <AlertDescription>
                  <div className="mt-2 space-y-2 text-xs">
                    {importResult.workers_imported.length > 0 && (
                      <p>
                        Workers:{" "}
                        <span className="text-foreground">
                          {importResult.workers_imported.join(", ")}
                        </span>
                      </p>
                    )}
                    {importResult.contexts_imported.length > 0 && (
                      <p>
                        Knowledge packs:{" "}
                        <span className="text-foreground">
                          {importResult.contexts_imported.join(", ")}
                        </span>
                      </p>
                    )}
                    {importResult.skipped.length > 0 && (
                      <p className="text-muted-foreground">
                        Skipped {importResult.skipped.length} item
                        {importResult.skipped.length === 1 ? "" : "s"} that already existed.
                      </p>
                    )}
                    {(importResult.required_secrets.length > 0 ||
                      importResult.required_connections.length > 0) && (
                      <p className="text-muted-foreground">
                        Reconnect these so the imported workers can run:{" "}
                        <span className="text-foreground">
                          {[
                            ...importResult.required_secrets,
                            ...importResult.required_connections,
                          ].join(", ")}
                        </span>
                        .
                      </p>
                    )}
                  </div>
                </AlertDescription>
              </Alert>
            ) : null}
          </section>
        </TabsContent>

        <TabsContent value="notifications" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-medium">Email notifications</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <ToggleRow
                title="Email on run failure"
                description="Send an email when a worker run ends in error."
                disabled
              />
              <ToggleRow
                title="Email on connection expiry"
                description="Warn when a connected account is about to lose access."
                disabled
              />
              <p className="text-xs text-muted-foreground">
                Email delivery is not wired up yet. Toggles will activate once
                outbound email is configured.
              </p>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="appearance" className="space-y-3">
          {/* S29z: explicit three-button toggle (System / Light / Dark)
              instead of a single cycling button. Sidebar keeps the
              compact cycle button; here we show all three at once. */}
          <h2 className="text-sm font-medium text-muted-foreground">Theme</h2>
          <p className="text-sm text-muted-foreground">
            Choose how Floom looks. System follows your operating system.
          </p>
          <ThemeModeToggleGroup />
        </TabsContent>

        <TabsContent value="data" className="space-y-6">
          <section className="space-y-3">
            <div>
              <h2 className="text-sm font-medium text-muted-foreground">Product telemetry</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Telemetry is workspace-scoped and sanitized before storage. Token-shaped
                strings, email addresses, cookies, authorization headers, and secret-like
                fields are redacted server-side.
              </p>
            </div>

            <div className="flex items-start justify-between gap-4 rounded-[var(--radius-card)] border border-[var(--border-default)] bg-card p-4">
              <div className="min-w-0">
                <p className="text-sm font-medium">Collect product telemetry</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Used for product quality, reliability, and usage analytics for this workspace.
                </p>
              </div>
              <Switch
                checked={Boolean(telemetryEnabled)}
                disabled={telemetryLoading || telemetrySaving || telemetryEnabled === null}
                onCheckedChange={(checked) => void updateTelemetryPreference(checked)}
              />
            </div>

            {telemetryLoading ? (
              <div className="text-xs text-muted-foreground">Loading data controls...</div>
            ) : null}
          </section>

          <section className="space-y-3 border-t border-[var(--border-default)] pt-6">
            <div>
              <h2 className="text-sm font-medium text-muted-foreground">Export and deletion</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Download or delete product telemetry events for the active workspace.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleExportTelemetry}
                disabled={telemetryExporting}
              >
                <Download className="size-3.5" />
                {telemetryExporting ? "Exporting..." : "Export telemetry"}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleDeleteTelemetry}
                disabled={telemetryDeleting}
                className="text-destructive hover:text-destructive"
              >
                <Trash2 className="size-3.5" />
                {telemetryDeleting ? "Deleting..." : "Delete telemetry"}
              </Button>
            </div>

            {telemetryLastExportCount !== null ? (
              <p className="text-xs text-muted-foreground">
                Last export contained {telemetryLastExportCount} event
                {telemetryLastExportCount === 1 ? "" : "s"}.
              </p>
            ) : null}
          </section>
        </TabsContent>

        <TabsContent value="danger" className="space-y-4">
          <Card className="border-destructive/40">
            <CardHeader>
              <CardTitle className="text-sm font-medium text-destructive">Danger zone</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-3">
                <div>
                  <p className="text-sm font-medium">Clear run history</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Deletes all runs, logs, artifacts, and approvals. Cannot be undone.
                  </p>
                </div>
                {/* PR S19 (I-44): type-to-confirm, same pattern as delete-worker.
                    Previous version was a single-click after a tap → click chain
                    which is too easy to fat-finger. */}
                <Label htmlFor="clear-runs-confirm" className="text-xs text-muted-foreground">
                  Type <code className="text-foreground">DELETE ALL RUNS</code> to confirm.
                </Label>
                <Input
                  id="clear-runs-confirm"
                  value={clearConfirmText}
                  onChange={(e) => setClearConfirmText(e.target.value)}
                  placeholder="DELETE ALL RUNS"
                  className="max-w-sm"
                />
                <Button
                  variant="destructive"
                  size="sm"
                  className="shrink-0"
                  onClick={handleClearRuns}
                  disabled={clearing || clearConfirmText.trim() !== "DELETE ALL RUNS"}
                >
                  {clearing ? "Clearing..." : "Delete all runs"}
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function Row({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className={`font-medium ${mono ? "font-mono" : ""}`}>{value}</span>
    </div>
  );
}

const WS_KEY = "workeros.activeWorkspaceId";

function WorkspaceSettingsTab() {
  const [wsId, setWsId] = useState<string | null>(null);
  const [wsName, setWsName] = useState<string>("");
  const [editName, setEditName] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [memberCount, setMemberCount] = useState<number | null>(null);

  useEffect(() => {
    const id = typeof window !== "undefined" ? window.localStorage.getItem(WS_KEY) : null;
    if (!id || id === "local-default") return;
    setWsId(id);
    // Fetch workspace list to get name + role
    fetch(`${API_PROXY_BASE}/workspaces`, { headers: activeWorkspaceHeaders() })
      .then((r) => r.json())
      .then((d: { workspaces?: { id: string; name: string; role: string }[] }) => {
        const ws = (d.workspaces ?? []).find((w) => w.id === id);
        if (ws) { setWsName(ws.name); setEditName(ws.name); }
      })
      .catch(() => {});
    // Fetch member count (returns 403 for non-admins — silently ignored)
    fetch(`${API_PROXY_BASE}/workspaces/${id}/members`, { headers: activeWorkspaceHeaders() })
      .then((r) => r.ok ? r.json() : null)
      .then((d: { members?: unknown[] } | null) => {
        if (d) setMemberCount((d.members ?? []).length);
      })
      .catch(() => {});
  }, []);

  async function handleRename() {
    if (!wsId || !editName.trim() || editName.trim() === wsName) return;
    setSaving(true);
    try {
      const res = await fetch(`${API_PROXY_BASE}/workspaces/${wsId}`, {
        method: "PATCH",
        headers: activeWorkspaceHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ name: editName.trim() }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const updated = (await res.json()) as { name: string };
      setWsName(updated.name);
      setEditName(updated.name);
      toast.success("Workspace renamed");
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to rename workspace");
    } finally {
      setSaving(false);
    }
  }

  if (!wsId) {
    return (
      <p className="text-sm text-muted-foreground py-4">No active workspace selected.</p>
    );
  }

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <h2 className="text-sm font-medium text-muted-foreground">Workspace name</h2>
        <div className="flex gap-2 max-w-sm">
          <Input
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void handleRename(); }}
            className="text-sm"
            placeholder="Workspace name"
          />
          <Button
            size="sm"
            disabled={saving || !editName.trim() || editName.trim() === wsName}
            onClick={() => void handleRename()}
          >
            {saving ? "Saving…" : "Rename"}
          </Button>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium text-muted-foreground">Team</h2>
        <div className="flex items-center justify-between max-w-sm rounded-lg border border-border bg-card p-3">
          <div>
            <p className="text-sm font-medium">Members</p>
            {memberCount !== null && (
              <p className="text-xs text-muted-foreground">
                {memberCount} active {memberCount === 1 ? "member" : "members"}
              </p>
            )}
          </div>
          <Link href="/members" className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2">
            Manage →
          </Link>
        </div>
      </section>
    </div>
  );
}

function ToggleRow({
  title,
  description,
  disabled,
}: {
  title: string;
  description: string;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <p className="text-sm font-medium">{title}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
      </div>
      <Switch disabled={disabled} />
      {disabled ? (
        <Badge variant="outline" className="text-xs">
          Soon
        </Badge>
      ) : null}
    </div>
  );
}

"use client";

export const dynamic = "force-dynamic";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { ArrowLeft, Link2, Lock, Globe, Copy, Check } from "lucide-react";
import { toast } from "sonner";

const API_BASE = process.env.NEXT_PUBLIC_API_PROXY_BASE ?? "/api/proxy";
const WS_KEY = "workeros.activeWorkspaceId";

function wsHeaders(init?: HeadersInit): Headers {
  const h = new Headers(init);
  if (typeof window !== "undefined") {
    const id = window.localStorage.getItem(WS_KEY);
    if (id && id !== "local-default") h.set("x-workeros-workspace", id);
  }
  if (!h.has("Content-Type")) h.set("Content-Type", "application/json");
  return h;
}

async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: wsHeaders(options?.headers),
  });
  if (!res.ok) {
    let msg = "";
    try { const b = await res.json(); msg = b.detail ?? JSON.stringify(b); } catch { msg = ""; }
    throw new Error(msg || `HTTP ${res.status}`);
  }
  if (res.status === 204) return null as T;
  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------

type Worker = {
  id: string;
  name: string;
  visibility: "private" | "shared";
  published_at: string | null;
};

// ---------------------------------------------------------------------------
// loading skeleton
// ---------------------------------------------------------------------------

function LoadingSkeleton({ workerId }: { workerId: string }) {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-1">
        <Skeleton className="h-4 w-4 rounded" />
        <Skeleton className="h-4 w-24 rounded" />
      </div>
      <div className="space-y-1.5">
        <Skeleton className="h-7 w-48 rounded" />
        <Skeleton className="h-4 w-32 rounded" />
      </div>
      <Skeleton className="h-px w-full" />
      <div className="max-w-xl space-y-4">
        <Skeleton className="h-24 w-full rounded-lg" />
        <Skeleton className="h-24 w-full rounded-lg" />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// page
// ---------------------------------------------------------------------------

export default function WorkerSharePage() {
  const params = useParams();
  const workerId =
    typeof params?.id === "string"
      ? params.id
      : Array.isArray(params?.id)
      ? params.id[0]
      : "";

  const [worker, setWorker] = useState<Worker | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [cloneToken, setCloneToken] = useState<string | null>(null);
  const [cloneExpires, setCloneExpires] = useState<string | null>(null);
  const [generatingLink, setGeneratingLink] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!workerId) return;
    void load();
  }, [workerId]);

  async function load() {
    setLoading(true);
    try {
      const data = await apiFetch<Worker>(`/workers/${workerId}`);
      setWorker(data);
    } catch {
      setNotFound(true);
    } finally {
      setLoading(false);
    }
  }

  async function handleVisibilityToggle(next: "private" | "shared") {
    if (!worker || toggling) return;
    setToggling(true);
    try {
      const updated = await apiFetch<{ visibility: string; published_at?: string }>(
        `/workers/${worker.id}/visibility`,
        { method: "PATCH", body: JSON.stringify({ visibility: next }) }
      );
      setWorker((prev) =>
        prev
          ? { ...prev, visibility: updated.visibility as "private" | "shared", published_at: updated.published_at ?? prev.published_at }
          : prev
      );
      toast.success(next === "shared" ? "Worker shared with all members" : "Worker set to private");
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to update visibility");
    } finally {
      setToggling(false);
    }
  }

  async function handleGenerateCloneLink() {
    if (!worker || generatingLink) return;
    setGeneratingLink(true);
    setCloneToken(null);
    try {
      const data = await apiFetch<{ token: string; expires_at: string }>(
        `/workers/${worker.id}/clone-link`,
        { method: "POST" }
      );
      setCloneToken(data.token);
      setCloneExpires(data.expires_at);
      toast.success("Clone link created — copy it now, it won't be shown again");
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to generate clone link");
    } finally {
      setGeneratingLink(false);
    }
  }

  function handleCopy() {
    if (!cloneToken) return;
    const url = cloneUrl(cloneToken);
    void navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  function cloneUrl(token: string) {
    const base = (process.env.NEXT_PUBLIC_API_PROXY_BASE ?? "").replace("/api/proxy", "");
    return `${base}/app/workers/clone/${token}`;
  }

  // ---- render ---------------------------------------------------------------

  if (loading) return <LoadingSkeleton workerId={workerId} />;

  if (notFound || !worker) {
    return (
      <div className="space-y-4">
        <Link href="/workers" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-3.5" /> Workers
        </Link>
        <p className="text-sm text-muted-foreground">Worker not found.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">

      {/* breadcrumb */}
      <Link
        href={`/workers/${worker.id}`}
        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        <ArrowLeft className="size-3.5" />
        {worker.name}
      </Link>

      {/* header */}
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Share &amp; clone</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Control who can see this worker and generate one-time clone links.
        </p>
      </div>

      <Separator />

      <div className="max-w-xl space-y-6">

        {/* ---- visibility section ---- */}
        <section className="space-y-4">
          <div>
            <h2 className="text-sm font-semibold">Visibility</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              Private workers are only visible to you and workspace admins. Shared workers appear on every
              member's Workers page.
            </p>
          </div>

          <div className="rounded-lg border border-border divide-y divide-border">
            {/* private option */}
            <button
              type="button"
              disabled={toggling || worker.visibility === "private"}
              onClick={() => void handleVisibilityToggle("private")}
              className="flex w-full items-start gap-4 p-4 text-left transition-colors hover:bg-[var(--active-nav-bg)] disabled:cursor-default"
            >
              <div className={`mt-0.5 rounded-full p-1.5 ${worker.visibility === "private" ? "bg-foreground text-background" : "bg-muted text-muted-foreground"}`}>
                <Lock className="w-3.5 h-3.5" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">Private</span>
                  {worker.visibility === "private" && (
                    <Badge variant="secondary" className="text-xs h-4 px-1.5">Current</Badge>
                  )}
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Only you and workspace admins can see this worker.
                </p>
              </div>
            </button>

            {/* shared option */}
            <button
              type="button"
              disabled={toggling || worker.visibility === "shared"}
              onClick={() => void handleVisibilityToggle("shared")}
              className="flex w-full items-start gap-4 p-4 text-left transition-colors hover:bg-[var(--active-nav-bg)] disabled:cursor-default"
            >
              <div className={`mt-0.5 rounded-full p-1.5 ${worker.visibility === "shared" ? "bg-foreground text-background" : "bg-muted text-muted-foreground"}`}>
                <Globe className="w-3.5 h-3.5" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">Shared</span>
                  {worker.visibility === "shared" && (
                    <Badge variant="secondary" className="text-xs h-4 px-1.5">Current</Badge>
                  )}
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">
                  All workspace members can see and trigger this worker.
                  {worker.visibility !== "shared" && " Members will only see runs from the moment you share it."}
                </p>
              </div>
            </button>
          </div>

          {worker.published_at && (
            <p className="text-xs text-muted-foreground">
              {worker.visibility === "shared"
                ? <>Shared since <strong>{new Date(worker.published_at).toLocaleDateString()}</strong>. Members see run history from this date.</>
                : <>Previously shared on <strong>{new Date(worker.published_at).toLocaleDateString()}</strong>. Re-sharing will use this same date — member run history is preserved.</>
              }
            </p>
          )}
        </section>

        <Separator />

        {/* ---- clone link section ---- */}
        <section className="space-y-4">
          <div>
            <h2 className="text-sm font-semibold">Clone link</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              Generate a one-time link so anyone can clone this worker into their own workspace.
            </p>
          </div>

          <div className="rounded-lg border border-border bg-muted/40 p-4 space-y-1.5 text-xs text-muted-foreground">
            <p>• The clone copies worker files and auto-wires connections by app name.</p>
            <p>• <strong className="text-foreground">Secrets, run history, and brain data are not copied.</strong></p>
            <p>• Links expire in 7 days. Each token can only be used once.</p>
          </div>

          {!cloneToken ? (
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5"
              disabled={generatingLink}
              onClick={() => void handleGenerateCloneLink()}
            >
              <Link2 className="w-3.5 h-3.5" />
              {generatingLink ? "Generating…" : "Generate clone link"}
            </Button>
          ) : (
            <div className="space-y-3">
              <div className="rounded-lg border border-amber-200 bg-amber-50 dark:border-amber-900/50 dark:bg-amber-950/20 px-4 py-3 text-xs text-amber-800 dark:text-amber-300">
                Copy this link now — it cannot be retrieved again.
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Clone URL</Label>
                <div className="flex gap-1.5">
                  <Input
                    readOnly
                    value={cloneUrl(cloneToken)}
                    className="font-mono text-xs"
                    onFocus={(e) => e.target.select()}
                  />
                  <Button size="sm" variant="secondary" onClick={handleCopy} className="gap-1 shrink-0">
                    {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                    {copied ? "Copied!" : "Copy"}
                  </Button>
                </div>
                {cloneExpires && (
                  <p className="text-xs text-muted-foreground">
                    Expires {new Date(cloneExpires).toLocaleString()}
                  </p>
                )}
              </div>
              <Button
                size="sm"
                variant="ghost"
                className="text-xs h-7 px-2"
                onClick={() => { setCloneToken(null); setCloneExpires(null); }}
              >
                Generate another link
              </Button>
            </div>
          )}
        </section>

      </div>
    </div>
  );
}

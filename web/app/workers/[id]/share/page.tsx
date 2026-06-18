"use client";

export const dynamic = "force-dynamic";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { ArrowLeft, Link2, Share2, Copy, Check, Users } from "lucide-react";
import { toast } from "sonner";

const API_BASE = process.env.NEXT_PUBLIC_API_PROXY_BASE ?? "/api/proxy";
const WS_KEY = "workeros.activeWorkspaceId";

function wsHeaders(init?: HeadersInit): Headers {
  const h = new Headers(init);
  if (typeof window !== "undefined" && window.localStorage) {
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

type Worker = { id: string; name: string; visibility?: string };

function LoadingSkeleton() {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-1">
        <Skeleton className="h-4 w-4 rounded" />
        <Skeleton className="h-4 w-24 rounded" />
      </div>
      <div className="space-y-1.5">
        <Skeleton className="h-7 w-48 rounded" />
        <Skeleton className="h-4 w-72 rounded" />
      </div>
      <Skeleton className="h-px w-full" />
      <div className="max-w-xl space-y-4">
        <Skeleton className="h-28 w-full rounded-lg" />
        <Skeleton className="h-28 w-full rounded-lg" />
      </div>
    </div>
  );
}

export default function WorkerSharePage() {
  const params = useParams();
  const workerId =
    typeof params?.id === "string" ? params.id : Array.isArray(params?.id) ? params.id[0] : "";

  const [worker, setWorker] = useState<Worker | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  // share-to-workspace state
  const [sharing, setSharing] = useState(false);
  const [sharedWorkerId, setSharedWorkerId] = useState<string | null>(null);

  // clone-link state
  const [cloneToken, setCloneToken] = useState<string | null>(null);
  const [cloneExpires, setCloneExpires] = useState<string | null>(null);
  const [generatingLink, setGeneratingLink] = useState(false);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiFetch<Worker>(`/workers/${workerId}`);
      setWorker(data);
    } catch {
      setNotFound(true);
    } finally {
      setLoading(false);
    }
  }, [workerId]);

  useEffect(() => {
    if (!workerId) return;
    void load();
  }, [load, workerId]);

  async function handleShareToWorkspace() {
    if (!worker || sharing) return;
    setSharing(true);
    try {
      const result = await apiFetch<{ id?: string; worker_id?: string }>(
        `/workers/${worker.id}/share-to-workspace`,
        { method: "POST" }
      );
      const newId = result.id || result.worker_id || "";
      setSharedWorkerId(newId);
      toast.success("Worker shared to workspace — members can now trigger it");
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to share worker");
    } finally {
      setSharing(false);
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
    void navigator.clipboard.writeText(cloneUrl(cloneToken)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  function cloneUrl(token: string) {
    const base = (process.env.NEXT_PUBLIC_API_PROXY_BASE ?? "").replace("/api/proxy", "");
    return `${base}/app/workers/clone/${token}`;
  }

  if (loading) return <LoadingSkeleton />;

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
          Share this worker with your workspace or generate a one-time clone link.
        </p>
      </div>

      <Separator />

      <div className="max-w-xl space-y-6">

        {/* ---- share to workspace ---- */}
        <section className="space-y-4">
          <div>
            <h2 className="text-sm font-semibold">Share to workspace</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              Creates a fresh copy of this worker, owned by the workspace admin. All members can
              trigger it and see every run. Requires admin access.
            </p>
          </div>

          <div className="rounded-lg border border-border bg-muted/40 p-4 space-y-1.5 text-xs text-muted-foreground">
            <p>• The workspace copy starts with a clean brain and no run history.</p>
            <p>• Runs using <strong className="text-foreground">admin&apos;s secrets</strong> — admin configures them once, applies to everyone.</p>
            <p>• <strong className="text-foreground">Secrets, brain data, and history from this private worker are not copied.</strong></p>
          </div>

          {sharedWorkerId ? (
            <div className="rounded-lg border border-border bg-card p-4 space-y-2">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Users className="w-4 h-4 text-muted-foreground" />
                Shared — workspace copy created
              </div>
              <p className="text-xs text-muted-foreground">
                The workspace worker is now live. You can share again to create another copy.
              </p>
              <Link
                href={`/workers/${sharedWorkerId}`}
                className="text-xs underline underline-offset-2 hover:text-foreground transition-colors"
              >
                Open workspace worker →
              </Link>
            </div>
          ) : (
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5"
              disabled={sharing}
              onClick={() => void handleShareToWorkspace()}
            >
              <Share2 className="w-3.5 h-3.5" />
              {sharing ? "Sharing…" : "Share to workspace"}
            </Button>
          )}
        </section>

        <Separator />

        {/* ---- clone link ---- */}
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

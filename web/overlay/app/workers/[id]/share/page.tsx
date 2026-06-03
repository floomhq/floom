"use client";

export const dynamic = "force-dynamic";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";

const API_BASE = process.env.NEXT_PUBLIC_API_PROXY_BASE ?? "/api/proxy";

function apiUrl(path: string) {
  return `${API_BASE}${path}`;
}

type Worker = {
  id: string;
  name: string;
  visibility: "private" | "shared";
  published_at: string | null;
};

export default function WorkerSharePage() {
  const params = useParams();
  const workerId = typeof params?.id === "string" ? params.id : Array.isArray(params?.id) ? params.id[0] : "";

  const [worker, setWorker] = useState<Worker | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [togglingVisibility, setTogglingVisibility] = useState(false);

  // Clone link state
  const [cloneLinkOpen, setCloneLinkOpen] = useState(false);
  const [cloneToken, setCloneToken] = useState<string | null>(null);
  const [cloneExpires, setCloneExpires] = useState<string | null>(null);
  const [cloneBusy, setCloneBusy] = useState(false);
  const [cloneCopied, setCloneCopied] = useState(false);

  useEffect(() => {
    if (workerId) void loadWorker();
  }, [workerId]);

  async function loadWorker() {
    setLoading(true);
    setError(null);
    try {
      const resp = await fetch(apiUrl(`/workers/${workerId}`));
      if (!resp.ok) {
        setError("Worker not found.");
        return;
      }
      const data = (await resp.json()) as Worker;
      setWorker(data);
    } catch {
      setError("Failed to load worker.");
    } finally {
      setLoading(false);
    }
  }

  async function handleVisibilityToggle(checked: boolean) {
    if (!worker || togglingVisibility) return;
    const newVisibility = checked ? "shared" : "private";
    setTogglingVisibility(true);
    try {
      const resp = await fetch(apiUrl(`/workers/${worker.id}/visibility`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ visibility: newVisibility }),
      });
      if (resp.ok) {
        const updated = (await resp.json()) as { visibility: string; published_at?: string };
        setWorker((prev) =>
          prev
            ? {
                ...prev,
                visibility: updated.visibility as "private" | "shared",
                published_at: updated.published_at ?? prev.published_at,
              }
            : prev
        );
      }
    } finally {
      setTogglingVisibility(false);
    }
  }

  async function handleCreateCloneLink() {
    if (!worker || cloneBusy) return;
    setCloneBusy(true);
    setCloneToken(null);
    try {
      const resp = await fetch(apiUrl(`/workers/${worker.id}/clone-link`), { method: "POST" });
      if (resp.ok) {
        const data = (await resp.json()) as { token: string; expires_at: string };
        setCloneToken(data.token);
        setCloneExpires(data.expires_at);
        setCloneLinkOpen(true);
        setCloneCopied(false);
      }
    } finally {
      setCloneBusy(false);
    }
  }

  function cloneUrl(token: string) {
    const base = process.env.NEXT_PUBLIC_API_PROXY_BASE?.replace("/api/proxy", "") ?? "";
    return `${base}/app/workers/clone/${token}`;
  }

  function handleCopy(text: string) {
    void navigator.clipboard.writeText(text).then(() => {
      setCloneCopied(true);
      setTimeout(() => setCloneCopied(false), 2000);
    });
  }

  if (loading) {
    return <div className="text-sm text-muted-foreground">Loading…</div>;
  }

  if (error || !worker) {
    return <div className="text-sm text-destructive">{error ?? "Worker not found."}</div>;
  }

  return (
    <div className="max-w-xl space-y-8">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Share settings</h1>
        <p className="text-sm text-muted-foreground mt-0.5">{worker.name}</p>
      </div>

      {/* Visibility toggle */}
      <section className="rounded-lg border p-5 space-y-4">
        <div>
          <h2 className="text-sm font-semibold">Visibility</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Shared workers are visible to all workspace members. Private workers are only visible to you
            and workspace admins.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Switch
            id="visibility-toggle"
            checked={worker.visibility === "shared"}
            disabled={togglingVisibility}
            onCheckedChange={(checked) => void handleVisibilityToggle(checked)}
          />
          <Label htmlFor="visibility-toggle" className="text-sm cursor-pointer">
            {worker.visibility === "shared" ? (
              <span className="flex items-center gap-1.5">
                <Badge variant="secondary">Shared</Badge>
                <span className="text-muted-foreground">— visible to all members</span>
              </span>
            ) : (
              <span className="flex items-center gap-1.5">
                <Badge variant="outline">Private</Badge>
                <span className="text-muted-foreground">— only you and admins</span>
              </span>
            )}
          </Label>
        </div>
        {worker.visibility === "shared" && worker.published_at && (
          <p className="text-xs text-muted-foreground">
            Shared since {new Date(worker.published_at).toLocaleDateString()}. Members see runs from
            this date onwards only.
          </p>
        )}
        {worker.visibility === "private" && worker.published_at && (
          <p className="text-xs text-muted-foreground">
            Previously shared on {new Date(worker.published_at).toLocaleDateString()}. Re-sharing will
            keep the original share date — members will see the same run history window.
          </p>
        )}
      </section>

      {/* Clone link */}
      <section className="rounded-lg border p-5 space-y-4">
        <div>
          <h2 className="text-sm font-semibold">Clone link</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Share a one-time link so others can clone this worker. The clone copies the worker&apos;s
            files and auto-wires existing connections by app name.
          </p>
        </div>
        <div className="rounded-md bg-muted/60 border px-3 py-2.5 text-xs text-muted-foreground space-y-0.5">
          <p>• Connections are auto-wired by app name (first active connection).</p>
          <p>• Secrets, run history, and brain data are <strong>not</strong> copied.</p>
          <p>• Links expire in 7 days and can only be used once per token.</p>
        </div>
        <Button
          size="sm"
          variant="secondary"
          disabled={cloneBusy}
          onClick={() => void handleCreateCloneLink()}
        >
          {cloneBusy ? "Generating…" : "Generate clone link"}
        </Button>
      </section>

      {/* Clone token dialog */}
      <Dialog open={cloneLinkOpen} onOpenChange={setCloneLinkOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Clone link created</DialogTitle>
            <DialogDescription>
              This link is shown once. Copy it now — it cannot be retrieved again.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="rounded-md bg-muted/60 border px-3 py-2.5 text-xs text-muted-foreground space-y-0.5">
              <p>• Secrets, run history, and brain data are not included.</p>
              <p>• Connections auto-wired by app name (first active match).</p>
              <p>• Review and test the clone before using in production.</p>
            </div>
            {cloneToken && (
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Clone URL</Label>
                <div className="flex gap-1.5">
                  <Input
                    readOnly
                    value={cloneUrl(cloneToken)}
                    className="font-mono text-xs"
                    onFocus={(e) => e.target.select()}
                  />
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => handleCopy(cloneUrl(cloneToken!))}
                  >
                    {cloneCopied ? "Copied!" : "Copy"}
                  </Button>
                </div>
                {cloneExpires && (
                  <p className="text-xs text-muted-foreground">
                    Expires {new Date(cloneExpires).toLocaleString()}
                  </p>
                )}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button onClick={() => setCloneLinkOpen(false)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

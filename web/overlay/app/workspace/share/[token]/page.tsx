"use client";

import { useEffect, useState } from "react";
import { ArrowLeft, CheckCircle2, Download, Loader2 } from "lucide-react";
import Link from "next/link";

import { Button } from "@/components/ui/button";

const PROXY_BASE = process.env.NEXT_PUBLIC_API_PROXY_BASE || "/api/proxy";

interface SharePreview {
  workspace_name: string;
  expires_at?: string | null;
  max_uses?: number | null;
  use_count: number;
}

interface ImportResult {
  workers_imported: string[];
  contexts_imported: string[];
  skipped: { type?: string; id?: string; reason?: string }[];
  required_secrets: string[];
  required_connections: string[];
}

async function proxyJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${PROXY_BASE}${path}`, init);
  if (res.status === 401) {
    window.location.href = `/login?next=${encodeURIComponent(window.location.pathname)}`;
    throw new Error("Sign in required");
  }
  if (!res.ok) {
    let detail = "";
    try {
      const body = (await res.json()) as { detail?: string };
      detail = body.detail || JSON.stringify(body);
    } catch {
      detail = res.statusText || `HTTP ${res.status}`;
    }
    throw new Error(detail);
  }
  return res.json() as Promise<T>;
}

export default function WorkspaceSharePage({ params }: { params: Promise<{ token: string }> }) {
  const [token, setToken] = useState<string | null>(null);
  const [preview, setPreview] = useState<SharePreview | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    params
      .then(({ token: resolved }) => {
        if (cancelled) return;
        setToken(resolved);
        return proxyJson<SharePreview>(`/workspaces/shares/${encodeURIComponent(resolved)}`);
      })
      .then((data) => {
        if (cancelled || !data) return;
        setPreview(data);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setError(err.message || "Share link failed");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [params]);

  async function importTemplate() {
    if (!token) return;
    setImporting(true);
    setError(null);
    try {
      const data = await proxyJson<ImportResult>(
        `/workspaces/shares/${encodeURIComponent(token)}/import`,
        { method: "POST" }
      );
      setResult(data);
    } catch (err) {
      setError((err as Error).message || "Import failed");
    } finally {
      setImporting(false);
    }
  }

  return (
    <main className="min-h-screen bg-[var(--paper)] px-6 py-10 text-[var(--ink)]">
      <div className="mx-auto max-w-2xl space-y-6">
        <Link
          href="/overview"
          className="inline-flex h-8 items-center gap-2 rounded-[var(--radius-button)] px-3 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          Back
        </Link>

        <section className="rounded-[var(--radius-card)] border border-[var(--border-default)] bg-card p-6 shadow-sm">
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Loading share link
            </div>
          ) : error && !preview ? (
            <div className="space-y-2">
              <h1 className="text-xl font-semibold">Share link unavailable</h1>
              <p className="text-sm text-muted-foreground">{error}</p>
            </div>
          ) : preview ? (
            <div className="space-y-5">
              <div className="space-y-1">
                <h1 className="text-2xl font-semibold">Import workspace template</h1>
                <p className="text-sm text-muted-foreground">
                  {preview.workspace_name} will be copied into your active workspace.
                </p>
              </div>

              <div className="rounded-[var(--radius-button)] border border-[var(--border-default)] bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                Secrets, OAuth tokens, and API tokens are excluded. Imported workers list the
                connections and secrets to reconnect.
              </div>

              <Button onClick={importTemplate} disabled={importing || Boolean(result)} className="gap-2">
                {importing ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
                {result ? "Imported" : importing ? "Importing..." : "Import template"}
              </Button>

              {error ? <p className="text-sm text-red-500">{error}</p> : null}

              {result ? (
                <div className="space-y-3 rounded-[var(--radius-button)] border border-[var(--border-default)] bg-muted/20 p-4 text-sm">
                  <div className="flex items-center gap-2 font-medium">
                    <CheckCircle2 className="size-4 text-emerald-600" />
                    Import complete
                  </div>
                  <p className="text-muted-foreground">
                    {result.workers_imported.length} workers and {result.contexts_imported.length} brain packs imported.
                  </p>
                  {[...result.required_secrets, ...result.required_connections].length > 0 ? (
                    <p className="text-muted-foreground">
                      Reconnect: {[...result.required_secrets, ...result.required_connections].join(", ")}
                    </p>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}
        </section>
      </div>
    </main>
  );
}

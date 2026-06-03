"use client";

export const dynamic = "force-dynamic";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { Check, Copy, Users } from "lucide-react";

const API_BASE = process.env.NEXT_PUBLIC_API_PROXY_BASE ?? "/api/proxy";
const WS_KEY = "workeros.activeWorkspaceId";

async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...options?.headers },
  });
  if (!res.ok) {
    let msg = "";
    try { const b = await res.json(); msg = b.detail ?? JSON.stringify(b); } catch { msg = ""; }
    throw new Error(msg || `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export default function JoinPage() {
  return (
    <Suspense>
      <JoinContent />
    </Suspense>
  );
}

function JoinContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const urlToken = searchParams?.get("invite") ?? "";

  const [token, setToken] = useState(urlToken);
  const [accepting, setAccepting] = useState(false);
  const [pat, setPat] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Auto-accept if a token is in the URL
  useEffect(() => {
    if (urlToken) void handleAccept(urlToken);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleAccept(t: string = token) {
    if (!t.trim()) { toast.error("Paste your invitation token"); return; }
    setAccepting(true);
    try {
      const result = await apiFetch<{ workspace_id: string; role: string; pat_token: string }>(
        "/workspaces/accept-invite",
        { method: "POST", body: JSON.stringify({ token: t.trim() }) }
      );
      window.localStorage.setItem(WS_KEY, result.workspace_id);
      setPat(result.pat_token);
      toast.success("You've joined the workspace");
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Invalid or expired invitation");
    } finally {
      setAccepting(false);
    }
  }

  function handleCopy() {
    if (!pat) return;
    void navigator.clipboard.writeText(pat).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-[var(--bg-app)] p-4">
      <div className="w-full max-w-md space-y-6">
        {/* Header */}
        <div className="text-center space-y-3">
          <div className="inline-flex items-center justify-center size-12 rounded-full bg-muted mx-auto">
            <Users className="size-6 text-muted-foreground" />
          </div>
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Join workspace</h1>
            <p className="text-sm text-muted-foreground mt-1">
              {pat
                ? "You're in. Save your API token before continuing."
                : urlToken
                ? "Accepting your invitation…"
                : "Paste your invitation token below to join."}
            </p>
          </div>
        </div>

        {/* Token input — shown only when no URL token and not yet accepted */}
        {!pat && !urlToken && (
          <div className="space-y-3">
            <Input
              autoFocus
              placeholder="wsi_…"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void handleAccept(); }}
              className="font-mono text-sm"
            />
            <Button
              className="w-full"
              disabled={accepting || !token.trim()}
              onClick={() => void handleAccept()}
            >
              {accepting ? "Joining…" : "Accept invitation"}
            </Button>
          </div>
        )}

        {/* Loading state while auto-accepting */}
        {!pat && urlToken && accepting && (
          <div className="text-center text-sm text-muted-foreground">Joining…</div>
        )}

        {/* PAT display — shown once after successful accept */}
        {pat && (
          <div className="rounded-xl border border-border bg-card p-5 space-y-4">
            <div className="space-y-1">
              <p className="text-sm font-medium">Your API token</p>
              <p className="text-xs text-muted-foreground">
                This is shown <strong>once only</strong> and can't be retrieved again.
                Use it as your <code className="bg-muted rounded px-1 font-mono">x-floom-token</code> header.
              </p>
            </div>
            <div className="flex gap-2">
              <Input
                readOnly
                value={pat}
                className="font-mono text-xs"
                onFocus={(e) => e.target.select()}
              />
              <Button size="sm" variant="secondary" onClick={handleCopy} className="gap-1.5 shrink-0">
                {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
            <Button
              className="w-full"
              onClick={() => router.push("/app/workers")}
            >
              Go to workspace
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

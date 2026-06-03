"use client";

export const dynamic = "force-dynamic";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FloomMark } from "@/components/layout/sidebar";

function LoginContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // Only allow same-origin relative redirects (block open-redirect via ?next=).
  const rawNext = searchParams.get("next") || "/";
  const next = rawNext.startsWith("/") && !rawNext.startsWith("//") ? rawNext : "/";

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!secret || busy) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secret }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { detail?: string };
        setError(body.detail || "Invalid access secret.");
        return;
      }
      // Cookie is set; navigate to the originally requested page.
      router.replace(next);
      router.refresh();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-4 py-10">
      <div className="mb-6 flex items-center gap-2">
        <FloomMark size={22} />
        <span className="text-base font-semibold tracking-tight">Floom Workers</span>
      </div>
      <h1 className="text-xl font-semibold tracking-tight">Sign in</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Enter your access secret to continue.
      </p>
      <form onSubmit={submit} className="mt-6 space-y-4">
        <div className="space-y-2">
          <label
            className="text-xs font-medium text-muted-foreground"
            htmlFor="access-secret"
          >
            Access secret
          </label>
          <Input
            id="access-secret"
            type="password"
            autoComplete="current-password"
            autoFocus
            placeholder="••••••••••••"
            value={secret}
            onChange={(event) => setSecret(event.target.value)}
          />
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <Button type="submit" disabled={!secret || busy} className="w-full">
          {busy ? "Signing in…" : "Sign in"}
        </Button>
      </form>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginContent />
    </Suspense>
  );
}

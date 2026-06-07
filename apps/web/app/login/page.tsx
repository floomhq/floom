"use client";

export const dynamic = "force-dynamic";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FloomMark } from "@/components/layout/sidebar";

type LoginMode = "loading" | "setup" | "username" | "secret";

function LoginContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [mode, setMode] = useState<LoginMode>("loading");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const rawNext = searchParams.get("next") || "/overview";
  const next = rawNext.startsWith("/") && !rawNext.startsWith("//") ? rawNext : "/overview";

  useEffect(() => {
    void (async () => {
      try {
        // Check if backend multi-member is active
        const res = await fetch("/api/auth/setup", { cache: "no-store" });
        if (res.ok) {
          const data = (await res.json()) as { required?: boolean };
          if (data.required) {
            setMode("setup");
          } else {
            setMode("username");
          }
          return;
        }
      } catch {
        // backend not reachable or no multi-member — fall back to secret mode
      }
      setMode("secret");
    })();
  }, []);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");

    try {
      if (mode === "setup") {
        const res = await fetch("/api/auth/setup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username: username.trim(), password, display_name: displayName.trim() || undefined }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { detail?: string };
          setError(body.detail || "Setup failed.");
          return;
        }
      } else if (mode === "username") {
        const res = await fetch("/api/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username: username.trim(), password }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { detail?: string };
          setError(body.detail || "Invalid credentials.");
          return;
        }
      } else {
        // secret mode
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
      }

      router.replace(next);
      router.refresh();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  if (mode === "loading") {
    return (
      <div className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-4 py-10">
        <div className="mb-6 flex items-center gap-2">
          <FloomMark size={22} />
          <span className="text-base font-semibold tracking-tight">Workeros</span>
        </div>
        <p className="text-sm text-muted-foreground">Loading…</p>
      </div>
    );
  }

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-4 py-10">
      <div className="mb-6 flex items-center gap-2">
        <FloomMark size={22} />
        <span className="text-base font-semibold tracking-tight">Workeros</span>
      </div>

      {mode === "setup" ? (
        <>
          <h1 className="text-xl font-semibold tracking-tight">Create your workspace</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Set up the first admin account for this Workeros instance.
          </p>
        </>
      ) : mode === "username" ? (
        <>
          <h1 className="text-xl font-semibold tracking-tight">Sign in</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Enter your username and password to continue.
          </p>
        </>
      ) : (
        <>
          <h1 className="text-xl font-semibold tracking-tight">Sign in</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Enter your access secret to continue.
          </p>
        </>
      )}

      <form onSubmit={handleSubmit} className="mt-6 space-y-4">
        {mode === "secret" ? (
          <div className="space-y-2">
            <Label htmlFor="access-secret" className="text-xs font-medium text-muted-foreground">
              Access secret
            </Label>
            <Input
              id="access-secret"
              type="password"
              autoComplete="current-password"
              autoFocus
              placeholder="••••••••••••"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
            />
          </div>
        ) : (
          <>
            {mode === "setup" && (
              <div className="space-y-2">
                <Label htmlFor="display-name" className="text-xs font-medium text-muted-foreground">
                  Display name <span className="text-muted-foreground/60">(optional)</span>
                </Label>
                <Input
                  id="display-name"
                  type="text"
                  autoComplete="name"
                  autoFocus
                  placeholder="Alice"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                />
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="username" className="text-xs font-medium text-muted-foreground">
                Username
              </Label>
              <Input
                id="username"
                type="text"
                autoComplete="username"
                autoFocus={mode === "username"}
                placeholder="alice"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password" className="text-xs font-medium text-muted-foreground">
                Password
              </Label>
              <Input
                id="password"
                type="password"
                autoComplete={mode === "setup" ? "new-password" : "current-password"}
                placeholder="••••••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
          </>
        )}

        {error && <p className="text-sm text-destructive">{error}</p>}

        <Button
          type="submit"
          disabled={busy || (mode === "secret" ? !secret : (!username.trim() || !password))}
          className="w-full"
        >
          {busy ? (mode === "setup" ? "Creating…" : "Signing in…") : (mode === "setup" ? "Create workspace" : "Sign in")}
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

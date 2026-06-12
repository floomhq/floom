"use client";

export const dynamic = "force-dynamic";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FloomMark } from "@/components/layout/sidebar";

type LoginMode = "loading" | "setup" | "username" | "secret";

function BrandPanel() {
  return (
    <section className="order-2 flex min-h-[240px] flex-col justify-between gap-12 bg-[var(--bg-app)] px-6 py-8 text-[var(--ink)] sm:px-12 lg:order-1 lg:min-h-screen lg:px-14 lg:py-12">
      <div className="flex items-center gap-2">
        <FloomMark size={22} />
        <span className="text-base font-semibold tracking-tight">WorkerOS</span>
      </div>

      <div className="max-w-md space-y-4">
        <h2 className="text-4xl font-semibold leading-tight tracking-tight sm:text-5xl">
          Hire AI workers.
        </h2>
        <p className="max-w-sm text-sm leading-6 text-[var(--muted-text)]">
          Jobs that run themselves on a schedule, from a message, or on demand. You get the
          output, not the mechanics.
        </p>
      </div>
    </section>
  );
}

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
  // Manual escape hatch: lets the user switch to secret mode regardless of the
  // auto-detected mode (needed on deployments that have no username accounts).
  const [forceSecret, setForceSecret] = useState(false);

  const installChannel = searchParams.get("install");
  const INSTALL_ROUTES: Record<string, string> = {
    slack: "/settings?from_install=slack#slack",
    whatsapp: "/overview?from_install=whatsapp",
    discord: "/overview?from_install=discord",
    cli: "/settings?from_install=cli",
  };
  const rawNext = searchParams.get("next") ||
    (installChannel ? (INSTALL_ROUTES[installChannel] ?? "/overview") : "/overview");
  const next = rawNext.startsWith("/") && !rawNext.startsWith("//") ? rawNext : "/overview";

  const effectiveMode: LoginMode = forceSecret && (mode === "username" || mode === "setup") ? "secret" : mode;

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/auth/setup", { cache: "no-store" });
        if (res.ok) {
          const data = (await res.json()) as { required?: boolean };
          setMode(data.required ? "setup" : "username");
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
      if (effectiveMode === "setup") {
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
      } else if (effectiveMode === "username") {
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
        const res = await fetch("/api/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ secret }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { detail?: string };
          setError(body.detail || "Invalid credentials.");
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

  const heading =
    effectiveMode === "setup" ? "Create your workspace" : "Sign in";
  const sub =
    effectiveMode === "setup"
      ? "Set up the first admin account for this WorkerOS instance."
      : effectiveMode === "username"
      ? "Enter your username and password to continue."
      : "Enter your access secret to continue.";

  return (
    <div className="grid min-h-screen w-full bg-[var(--bg-app)] text-[var(--ink)] lg:grid-cols-2">
      <BrandPanel />

      <section className="order-1 flex min-h-screen flex-col justify-center bg-[var(--bg-card)] px-6 py-10 sm:px-12 lg:order-2">
        <div className="mx-auto w-full max-w-sm">
          <div className="mb-8 flex items-center gap-2">
            <FloomMark size={22} />
            <span className="text-base font-semibold tracking-tight">WorkerOS</span>
          </div>

          {mode === "loading" ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : (
            <>
              <h1 className="text-xl font-semibold tracking-tight">{heading}</h1>
              <p className="mt-1 text-sm text-muted-foreground">{sub}</p>
              <p className="mt-4 text-xs text-[var(--ink-faint)]">
                Your first sign-in creates your workspace.
              </p>

              <form onSubmit={handleSubmit} className="mt-6 space-y-4">
                {effectiveMode === "secret" ? (
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
                    {effectiveMode === "setup" && (
                      <div className="space-y-2">
                        <Label htmlFor="display-name" className="text-xs font-medium text-muted-foreground">
                          Display name <span className="text-muted-foreground/60">(optional)</span>
                        </Label>
                        <Input
                          id="display-name"
                          type="text"
                          autoComplete="name"
                          autoFocus
                          placeholder="Your name"
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
                        autoFocus={effectiveMode === "username"}
                        placeholder="username"
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
                        autoComplete={effectiveMode === "setup" ? "new-password" : "current-password"}
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
                  disabled={busy || (effectiveMode === "secret" ? !secret : (!username.trim() || !password))}
                  className="w-full bg-[var(--accent)] text-white hover:bg-[color-mix(in_srgb,var(--accent)_88%,black_12%)] active:not-aria-[haspopup]:bg-[color-mix(in_srgb,var(--accent)_80%,black_20%)]"
                >
                  {busy ? (effectiveMode === "setup" ? "Creating…" : "Signing in…") : (effectiveMode === "setup" ? "Create workspace" : "Sign in")}
                </Button>
              </form>

              {/* Escape hatch: manual toggle for deployments that use secret-only auth. */}
              {(mode === "username" || mode === "setup") && (
                <p className="mt-4 text-center text-xs text-muted-foreground/60">
                  <button
                    type="button"
                    className="underline-offset-2 hover:text-muted-foreground hover:underline"
                    onClick={() => { setForceSecret((v) => !v); setError(""); }}
                  >
                    {forceSecret ? "Back to username sign-in" : "Sign in with admin secret"}
                  </button>
                </p>
              )}
            </>
          )}
        </div>
      </section>
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

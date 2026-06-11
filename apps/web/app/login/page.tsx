"use client";

export const dynamic = "force-dynamic";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FloomMark } from "@/components/layout/sidebar";

type LoginMode = "loading" | "setup" | "username" | "secret";

// §5a2: the sign-in page is SPLIT — a dark product-proof panel on the left
// (mark + "Hire AI workers." + a real-looking "This week" artifact card, never
// a bare form) and the form on the right. Industry pattern; no centered card.
function ProofPanel() {
  return (
    <div className="relative hidden flex-col justify-between overflow-hidden bg-[#16171A] p-10 text-white lg:flex">
      <div className="flex items-center gap-2">
        <FloomMark size={22} />
        <span className="text-base font-semibold tracking-tight">WorkerOS</span>
      </div>

      <div className="space-y-6">
        <h2 className="max-w-sm text-3xl font-semibold leading-tight tracking-tight">
          Hire AI workers.
        </h2>
        <p className="max-w-sm text-sm text-white/60">
          Jobs that run themselves — on a schedule, from a message, or on demand. You get the
          output, not the mechanics.
        </p>

        {/* "This week" artifact card — show what they get. */}
        <div className="max-w-sm rounded-2xl bg-white/[0.06] p-5 ring-1 ring-white/10">
          <p className="text-[11px] font-medium uppercase tracking-wide text-white/40">This week</p>
          <div className="mt-3 grid grid-cols-3 gap-4">
            {[
              { n: "142", l: "runs" },
              { n: "8", l: "workers" },
              { n: "3", l: "approved" },
            ].map((s) => (
              <div key={s.l}>
                <div className="text-2xl font-semibold tracking-tight">{s.n}</div>
                <div className="text-[11px] text-white/40">{s.l}</div>
              </div>
            ))}
          </div>
          <div className="mt-4 space-y-2 border-t border-white/10 pt-4">
            {[
              { w: "Weekly sales summary", t: "2h ago" },
              { w: "Invoice reconciliation", t: "5h ago" },
              { w: "Standup digest", t: "yesterday" },
            ].map((r) => (
              <div key={r.w} className="flex items-center justify-between text-xs">
                <span className="text-white/80">{r.w}</span>
                <span className="text-white/35">{r.t}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <p className="text-xs text-white/30">Your first sign-in creates your workspace.</p>
    </div>
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

  const heading =
    effectiveMode === "setup" ? "Create your workspace" : "Sign in";
  const sub =
    effectiveMode === "setup"
      ? "Set up the first admin account for this WorkerOS instance."
      : effectiveMode === "username"
      ? "Enter your username and password to continue."
      : "Enter your access secret to continue.";

  return (
    <div className="grid min-h-screen w-full lg:grid-cols-2">
      <ProofPanel />

      {/* Right: the form. */}
      <div className="flex flex-col justify-center px-6 py-10 sm:px-12">
        <div className="mx-auto w-full max-w-sm">
          {/* Mark shows on mobile (where the proof panel is hidden). */}
          <div className="mb-8 flex items-center gap-2 lg:hidden">
            <FloomMark size={22} />
            <span className="text-base font-semibold tracking-tight">WorkerOS</span>
          </div>

          {mode === "loading" ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : (
            <>
              <h1 className="text-xl font-semibold tracking-tight">{heading}</h1>
              <p className="mt-1 text-sm text-muted-foreground">{sub}</p>

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
                        autoFocus={effectiveMode === "username"}
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
                  className="w-full"
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
      </div>
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

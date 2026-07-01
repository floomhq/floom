"use client";

export const dynamic = "force-dynamic";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FloomMark } from "@/components/layout/sidebar";
import { sanitizeRedirect } from "@/lib/redirects";
import { capturePostHogEvent } from "@/lib/posthog";

type LoginMode = "loading" | "setup" | "username" | "secret";

function BrandPanel() {
  return (
    <section className="order-2 flex min-h-[240px] flex-col justify-between gap-10 bg-[var(--bg-app)] px-6 py-8 text-[var(--ink)] sm:px-12 lg:order-1 lg:min-h-screen lg:px-14 lg:py-12">
      <div className="flex items-center gap-2.5">
        <FloomMark size={22} />
        <span className="text-sm font-semibold tracking-tight">Floom</span>
      </div>

      <div className="max-w-sm space-y-5">
        <h2 className="text-3xl font-semibold leading-tight tracking-tight sm:text-4xl">
          Hire AI workers for your company.
        </h2>
        <p className="text-sm leading-relaxed text-[var(--muted-text)]">
          Jobs that run themselves on a schedule, from a message, or on demand. You get the output, not the mechanics.
        </p>
        <div className="grid gap-2 text-xs text-[var(--muted-text)] sm:grid-cols-2">
          {["Connected accounts stay yours", "No telemetry key by default", "Sandboxed worker runtime", "Open-source engine"].map((item) => (
            <div key={item} className="rounded-[var(--radius-card)] bg-[var(--bg-2)] px-3 py-2">
              {item}
            </div>
          ))}
        </div>
      </div>

      <div className="hidden max-w-sm rounded-[var(--radius-card)] bg-[var(--bg-2)] p-4 text-xs text-[var(--muted-text)] lg:block">
        <div className="mb-3 flex items-center justify-between">
          <span className="font-medium text-[var(--ink)]">Daily revenue report</span>
          <span className="rounded-[var(--radius-pill)] bg-[var(--bg-3)] px-2 py-0.5 text-[11px] text-[var(--ink-soft)]">Ready</span>
        </div>
        <div className="space-y-2 font-mono text-[11px] leading-5">
          <p>09:00 Read Stripe payouts</p>
          <p>09:02 Match invoices in Sheets</p>
          <p>09:04 Send Slack summary</p>
        </div>
      </div>
    </section>
  );
}

function FormSkeleton() {
  return (
    <div className="space-y-4 animate-pulse">
      <div className="h-5 w-24 rounded-[var(--radius-button)] bg-[var(--bg-2)]" />
      <div className="h-4 w-48 rounded-[var(--radius-button)] bg-[var(--bg-2)]" />
      <div className="mt-6 space-y-4">
        <div className="space-y-1.5">
          <div className="h-3 w-16 rounded-[var(--radius-button)] bg-[var(--bg-2)]" />
          <div className="h-8 w-full rounded-[var(--radius-input)] bg-[var(--bg-2)]" />
        </div>
        <div className="space-y-1.5">
          <div className="h-3 w-14 rounded-[var(--radius-button)] bg-[var(--bg-2)]" />
          <div className="h-8 w-full rounded-[var(--radius-input)] bg-[var(--bg-2)]" />
        </div>
        <div className="h-8 w-full rounded-[var(--radius-button)] bg-[var(--bg-2)]" />
      </div>
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
  const next = sanitizeRedirect(rawNext);

  const effectiveMode: LoginMode = forceSecret && (mode === "username" || mode === "setup") ? "secret" : mode;

  // #1702: a failed magic-link redirect lands here with ?error=<code>. Surface a
  // human message and a clear re-login action instead of a raw JSON dead-end.
  const errorParam = searchParams.get("error");
  useEffect(() => {
    if (!errorParam) return;
    const ERROR_MESSAGES: Record<string, string> = {
      expired_link: "This sign-in link expired or was already used. Request a new one below.",
      account_disabled: "This account has been disabled. Contact your workspace admin.",
    };
    setError(ERROR_MESSAGES[errorParam] || "Could not sign you in. Please try again.");
  }, [errorParam]);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/auth/setup", { cache: "no-store" });
        if (res.ok) {
          const data = (await res.json()) as { required?: boolean };
          const nextMode = data.required ? "setup" : "username";
          setMode(nextMode);
          // INTENT: the first-admin signup form is being shown.
          if (nextMode === "setup") {
            capturePostHogEvent("signup_started", { method: "password" });
          }
          return;
        }
      } catch {
        // backend not reachable or no multi-member -- fall back to secret mode
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
        // INTENT: signup form submitted (before the server confirms).
        capturePostHogEvent("signup_submitted", { method: "password" });
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
      ? "Set up the first admin account for this Floom instance."
      : effectiveMode === "username"
      ? "Enter your username and password to continue."
      : "Enter your access secret to continue.";

  return (
    <div className="grid min-h-screen w-full bg-[var(--bg-app)] text-[var(--ink)] lg:grid-cols-2">
      <BrandPanel />

      <section className="order-1 flex min-h-screen flex-col bg-[var(--bg-card)] px-6 py-8 sm:px-12 lg:order-2">
        <div className="flex flex-1 items-center">
        <div className="mx-auto w-full max-w-[360px]">
          {/* Logo mark -- visible only on mobile (brand panel hidden on small screens) */}
          <div className="mb-8 flex items-center gap-2.5 lg:hidden">
            <FloomMark size={22} />
            <span className="text-sm font-semibold tracking-tight">Floom</span>
          </div>

          {mode === "loading" ? (
            <FormSkeleton />
          ) : (
            <>
              <h1 className="text-xl font-semibold tracking-tight">{heading}</h1>
              <p className="mt-1.5 text-sm text-[var(--muted-text)]">{sub}</p>
              {effectiveMode === "setup" && (
                <p className="mt-3 text-xs text-[var(--ink-faint)]">
                  This creates the first admin account for your workspace.
                </p>
              )}

              <form onSubmit={handleSubmit} className="mt-6 space-y-4">
                {effectiveMode === "secret" ? (
                  <div className="space-y-1.5">
                    <Label htmlFor="access-secret" className="text-xs font-medium text-[var(--muted-text)]">
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
                      <div className="space-y-1.5">
                        <Label htmlFor="display-name" className="text-xs font-medium text-[var(--muted-text)]">
                          Display name{" "}
                          <span className="text-[var(--ink-faint)]">(optional)</span>
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
                    <div className="space-y-1.5">
                      <Label htmlFor="username" className="text-xs font-medium text-[var(--muted-text)]">
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
                    <div className="space-y-1.5">
                      <Label htmlFor="password" className="text-xs font-medium text-[var(--muted-text)]">
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
                  size="lg"
                  disabled={busy || (effectiveMode === "secret" ? !secret : (!username.trim() || !password))}
                  className="w-full"
                >
                  {busy
                    ? (effectiveMode === "setup" ? "Creating..." : "Signing in...")
                    : (effectiveMode === "setup" ? "Create workspace" : "Sign in")}
                </Button>
              </form>

              {/* Escape hatch: manual toggle for deployments that use secret-only auth. */}
              {(mode === "username" || mode === "setup") && (
                <p className="mt-5 text-center text-xs text-[var(--ink-faint)]">
                  <button
                    type="button"
                    className="underline-offset-2 hover:text-[var(--muted-text)] hover:underline"
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
        <footer className="mx-auto flex w-full max-w-[520px] flex-wrap items-center justify-center gap-x-4 gap-y-2 pt-8 text-xs text-[var(--ink-faint)]">
          <Link className="hover:text-[var(--muted-text)]" href="/terms">Terms</Link>
          <Link className="hover:text-[var(--muted-text)]" href="/privacy">Privacy</Link>
          <a className="hover:text-[var(--muted-text)]" href="https://github.com/floomhq/floom/security/policy" rel="noreferrer" target="_blank">Security</a>
          <a className="hover:text-[var(--muted-text)]" href="https://github.com/floomhq/floom#readme" rel="noreferrer" target="_blank">Docs</a>
        </footer>
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

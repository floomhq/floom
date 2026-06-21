"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, CheckCircle2, ExternalLink, Loader2, ShieldCheck } from "lucide-react";
import { api } from "@/lib/api";
import { sanitizeRedirect } from "@/lib/redirects";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ProviderLogos } from "@/components/connections/ProviderLogos";

type RedirectPhase = "preparing" | "ready" | "waiting_click" | "waiting" | "done" | "error" | "api_key";

function RedirectInner() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const slug = (searchParams.get("app") || "").trim().toLowerCase();
  const returnTo = normalizeReturnTo(searchParams.get("return_to"));
  const providerName = useMemo(() => formatProviderName(slug), [slug]);

  const [phase, setPhase] = useState<RedirectPhase>("preparing");
  const [redirectUrl, setRedirectUrl] = useState("");
  const [connectionId, setConnectionId] = useState("");
  const [error, setError] = useState("");
  // True once we've auto-launched the Composio tab but the browser blocked the
  // popup (window.open returned null). We then fall back to the manual link.
  const [popupBlocked, setPopupBlocked] = useState(false);
  // Don't use a ref guard — it survives Fast Refresh rebuilds and prevents
  // the effect from re-firing after a hot reload, leaving the page stuck in
  // "preparing" forever. The slug dep on the effect is the dedup guard instead.
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Dedup guard so the auto-open effect fires exactly once per redirectUrl,
  // even across React StrictMode double-invokes / re-renders.
  const autoOpenedRef = useRef("");

  // Poll connections list until the new connection appears as active,
  // then navigate back. Stops after 2 minutes.
  const startPolling = useCallback(() => {
    setPhase("waiting");
    const deadline = Date.now() + 2 * 60 * 1000;
    const tick = async () => {
      try {
        // Sync status from Composio first so our DB reflects reality.
        // The Composio /connected_accounts/link flow never calls our callback
        // URL — without this sync our DB stays "initiated" forever even after
        // the user has completed OAuth on Composio's hosted page.
        if (connectionId) {
          await api.connections.status(connectionId).catch(() => null);
        }
        const list = await api.connections.list();
        const active = list.find(
          (c) => c.app_name?.toLowerCase() === slug && c.status === "active"
        );
        if (active) {
          setPhase("done");
          setTimeout(() => router.replace(returnTo), 1200);
          return;
        }
      } catch { /* ignore */ }
      if (Date.now() < deadline) {
        pollRef.current = setTimeout(tick, 3000);
      }
    };
    pollRef.current = setTimeout(tick, 2000);
  }, [slug, returnTo, router, connectionId]);

  useEffect(() => {
    return () => {
      if (pollRef.current) clearTimeout(pollRef.current);
    };
  }, []);

  // Auto-launch: as soon as the Composio authorization URL is ready, open it in
  // a new tab automatically AND start polling for completion — the user should
  // never have to hunt for a button. Composio's hosted /connected_accounts/link
  // page does NOT redirect back to us after success, so polling is what brings
  // the user home. If the browser blocks the popup, we surface a manual link.
  useEffect(() => {
    if (phase !== "ready" || !redirectUrl) return;
    if (autoOpenedRef.current === redirectUrl) return;
    autoOpenedRef.current = redirectUrl;

    const opened = window.open(redirectUrl, "_blank", "noopener,noreferrer");
    if (!opened) {
      // Popup blocked — keep the user on "ready" with a visible manual link.
      setPopupBlocked(true);
      return;
    }
    // Tab launched: begin polling so we detect success on Composio's hosted page
    // and navigate back automatically, with no extra click required.
    startPolling();
  }, [phase, redirectUrl, startPolling]);

  useEffect(() => {
    if (!slug) {
      setPhase("error");
      setError("Missing integration name.");
      return;
    }

    // Reset to preparing whenever slug changes so re-navigating to a
    // different app starts fresh.
    setPhase("preparing");
    setRedirectUrl("");
    setError("");

    let cancelled = false;
    (async () => {
      try {
        const result = await api.connections.initiate(slug);
        if (cancelled) return;
        if (result.redirect_url) {
          setRedirectUrl(result.redirect_url);
          setConnectionId(result.id ?? "");
          setPhase("ready");
          return;
        }
        router.replace(returnTo);
      } catch (caught) {
        if (cancelled) return;
        const message = caught instanceof Error ? caught.message : "Failed to start authorization.";
        if (message.startsWith("api_key_only:")) {
          setPhase("api_key");
          setError(`${providerName} uses an API key instead of OAuth.`);
        } else {
          setPhase("error");
          setError(message);
        }
      }
    })();

    return () => { cancelled = true; };
  }, [slug, providerName, returnTo, router]);

  return (
    <div className="min-h-[calc(100vh-4rem)] flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-md">
        <Link
          href={returnTo}
          className="mb-6 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          Back
        </Link>

        <Card>
          <CardContent className="p-8 text-center">
            <ProviderLogos providerIcon={slug || "composio"} />

            {phase === "api_key" ? (
              <>
                <div className="mx-auto mt-6 flex size-10 items-center justify-center rounded-[var(--radius-pill)] [border:var(--bd-card)] bg-muted">
                  <ShieldCheck className="size-5 text-muted-foreground" />
                </div>
                <h1 className="mt-4 text-xl font-semibold">Add a secret for {providerName}</h1>
                <p className="mt-2 text-sm text-muted-foreground">{error}</p>
                <div className="mt-6 flex flex-col gap-2">
                  <Link
                    href={`/connections/secrets?prefill=${encodeURIComponent(`${slug.toUpperCase()}_API_KEY`)}`}
                    className={buttonVariants({ className: "w-full" })}
                  >
                    Add secret
                  </Link>
                  <Link href={returnTo} className={buttonVariants({ variant: "ghost", className: "w-full" })}>
                    Cancel
                  </Link>
                </div>
              </>

            ) : phase === "error" ? (
              <>
                <div className="mx-auto mt-6 flex size-10 items-center justify-center rounded-[var(--radius-pill)] [border:var(--bd-card)] bg-muted">
                  <ShieldCheck className="size-5 text-muted-foreground" />
                </div>
                <h1 className="mt-4 text-xl font-semibold">Authorization could not start</h1>
                <p className="mt-2 text-sm text-muted-foreground">{error}</p>
                <div className="mt-6 flex flex-col gap-2">
                  <Button type="button" onClick={() => window.location.reload()}>Try again</Button>
                  <Link href={returnTo} className={buttonVariants({ variant: "ghost", className: "w-full" })}>
                    Cancel
                  </Link>
                </div>
              </>

            ) : phase === "done" ? (
              <>
                <div className="mx-auto mt-6 flex size-10 items-center justify-center rounded-[var(--radius-button)] [border:var(--bd-card)] bg-[color-mix(in_srgb,var(--positive)_8%,transparent)]">
                  <CheckCircle2 className="size-5 text-[var(--positive)]" />
                </div>
                <h1 className="mt-4 text-xl font-semibold">Connected!</h1>
                <p className="mt-2 text-sm text-muted-foreground">
                  {providerName} is now connected. Taking you back…
                </p>
              </>

            ) : phase === "waiting_click" ? (
              <>
                <div className="mx-auto mt-6 flex size-10 items-center justify-center rounded-[var(--radius-pill)] [border:var(--bd-card)] bg-muted">
                  <ExternalLink className="size-5 text-muted-foreground" />
                </div>
                <h1 className="mt-4 text-xl font-semibold">Finish authorization in Composio</h1>
                <p className="mt-2 text-sm text-muted-foreground">
                  Complete the authorization in the Composio tab that opened, then return here.
                </p>
                <ComposioExplainer providerName={providerName} />
                <Button
                  className="mt-4 w-full"
                  onClick={startPolling}
                >
                  I&apos;ve authorized: take me back
                </Button>
                <Link href={returnTo} className={buttonVariants({ variant: "ghost", className: "mt-2 w-full" })}>
                  Go to connections
                </Link>
              </>

            ) : phase === "waiting" ? (
              <>
                <div className="mx-auto mt-6 flex size-10 items-center justify-center rounded-[var(--radius-pill)] [border:var(--bd-card)] bg-muted">
                  <Loader2 className="size-5 animate-spin text-muted-foreground" />
                </div>
                <h1 className="mt-4 text-xl font-semibold">Authorize {providerName} in the new tab</h1>
                <p className="mt-2 text-sm text-muted-foreground">
                  We opened <strong>Composio</strong> in a new tab to authorize {providerName}.
                  Finish there and we&apos;ll bring you back here automatically.
                </p>
                <ComposioExplainer providerName={providerName} />
                {redirectUrl && (
                  <a
                    href={redirectUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={buttonVariants({ variant: "outline", className: "mt-4 w-full" })}
                  >
                    <ExternalLink className="size-4 mr-2" />
                    Tab didn&apos;t open? Open Composio
                  </a>
                )}
                <Link href={returnTo} className={buttonVariants({ variant: "ghost", className: "mt-2 w-full" })}>
                  Go to connections
                </Link>
              </>

            ) : phase === "ready" ? (
              <>
                <div className="mx-auto mt-6 flex size-10 items-center justify-center rounded-[var(--radius-pill)] [border:var(--bd-card)] bg-muted">
                  <ExternalLink className="size-5 text-muted-foreground" />
                </div>
                <h1 className="mt-4 text-xl font-semibold">Authorize {providerName}</h1>
                <p className="mt-2 text-sm text-muted-foreground">
                  {popupBlocked
                    ? "Your browser blocked the pop-up. Click below to open Composio and authorize "
                    : "Click below to open Composio and authorize "}
                  {providerName}.
                </p>
                <ComposioExplainer providerName={providerName} />
                <a
                  href={redirectUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={buttonVariants({ className: "mt-4 w-full" })}
                  onClick={() => {
                    autoOpenedRef.current = redirectUrl;
                    startPolling();
                  }}
                >
                  <ExternalLink className="size-4 mr-2" />
                  Open Composio →
                </a>
                <Button
                  variant="outline"
                  className="mt-2 w-full"
                  onClick={startPolling}
                >
                  I&apos;ve authorized: take me back
                </Button>
              </>

            ) : (
              /* preparing */
              <>
                <div className="mx-auto mt-6 flex size-10 items-center justify-center rounded-[var(--radius-pill)] [border:var(--bd-card)] bg-muted">
                  <Loader2 className="size-5 animate-spin text-muted-foreground" />
                </div>
                <h1 className="mt-4 text-xl font-semibold">Connecting {providerName} via Composio…</h1>
                <p className="mt-2 text-sm text-muted-foreground">
                  Getting the authorization link. A Composio tab will open in a moment.
                </p>
                <ComposioExplainer providerName={providerName} />
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

// Compact, reassuring explanation of what Composio is and what the user is
// about to do. Surfaced on every connect step so the OAuth hand-off never feels
// like an unexplained jump to a third-party page.
function ComposioExplainer({ providerName }: { providerName: string }) {
  return (
    <div className="mt-5 rounded-[var(--radius-card)] [border:var(--bd-card)] bg-muted/40 p-4 text-left">
      <div className="flex items-start gap-2.5">
        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="text-xs leading-relaxed text-muted-foreground">
          <p className="font-medium text-foreground">What is Composio?</p>
          <p className="mt-1">
            Floom uses <strong>Composio</strong> as its secure integrations layer.
            You authorize {providerName} on Composio&apos;s page, then you come back
            here automatically. Floom never sees your {providerName} password.
          </p>
        </div>
      </div>
    </div>
  );
}

function normalizeReturnTo(value: string | null): string {
  return sanitizeRedirect(value, "/connections");
}

function formatProviderName(slug: string): string {
  if (!slug) return "this app";
  return slug
    .split(/[-_]/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export default function ConnectionsRedirectPage() {
  return (
    <Suspense fallback={<div className="text-sm text-muted-foreground">Preparing authorization...</div>}>
      <RedirectInner />
    </Suspense>
  );
}

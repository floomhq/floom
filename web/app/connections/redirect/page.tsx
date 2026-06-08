"use client";

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, ExternalLink, Loader2, ShieldCheck } from "lucide-react";
import { api } from "@/lib/api";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ProviderLogos } from "@/components/connections/ProviderLogos";

type RedirectPhase = "preparing" | "redirecting" | "error" | "api_key";

function RedirectInner() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const slug = (searchParams.get("app") || "").trim().toLowerCase();
  const returnTo = normalizeReturnTo(searchParams.get("return_to"));
  const providerName = useMemo(() => formatProviderName(slug), [slug]);

  const [phase, setPhase] = useState<RedirectPhase>("preparing");
  const [redirectUrl, setRedirectUrl] = useState("");
  const [error, setError] = useState("");
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    if (!slug) {
      setPhase("error");
      setError("Missing integration name.");
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const result = await api.connections.initiate(slug);
        if (cancelled) return;

        if (result.redirect_url) {
          setRedirectUrl(result.redirect_url);
          setPhase("redirecting");
          // Don't auto-navigate — window.location.assign() is unreliable in
          // dev (Fast Refresh rebuilds interrupt it) and some browsers block
          // automatic navigation to external domains. Show an explicit button
          // instead so the user always has a clear, clickable path forward.
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

    return () => {
      cancelled = true;
    };
  }, [providerName, returnTo, router, slug]);

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
                <div className="mx-auto mt-6 flex size-10 items-center justify-center rounded-full border border-border bg-muted">
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
                <div className="mx-auto mt-6 flex size-10 items-center justify-center rounded-full border border-border bg-muted">
                  <ShieldCheck className="size-5 text-muted-foreground" />
                </div>
                <h1 className="mt-4 text-xl font-semibold">Authorization could not start</h1>
                <p className="mt-2 text-sm text-muted-foreground">{error}</p>
                <div className="mt-6 flex flex-col gap-2">
                  <Button type="button" onClick={() => window.location.reload()}>
                    Try again
                  </Button>
                  <Link href={returnTo} className={buttonVariants({ variant: "ghost", className: "w-full" })}>
                    Cancel
                  </Link>
                </div>
              </>
            ) : (
              <>
                <div className="mx-auto mt-6 flex size-10 items-center justify-center rounded-full border border-border bg-muted">
                  {redirectUrl ? (
                    <ExternalLink className="size-5 text-muted-foreground" />
                  ) : (
                    <Loader2 className="size-5 animate-spin text-muted-foreground" />
                  )}
                </div>
                <h1 className="mt-4 text-xl font-semibold">
                  {redirectUrl ? `Authorize ${providerName}` : "Preparing authorization…"}
                </h1>
                <p className="mt-2 text-sm text-muted-foreground">
                  {redirectUrl
                    ? "Click the button below to continue to Composio and authorize the connection."
                    : "Getting the authorization URL, please wait."}
                </p>
                {redirectUrl ? (
                  <a
                    href={redirectUrl}
                    target="_self"
                    rel="noopener noreferrer"
                    className={buttonVariants({ className: "mt-6 w-full" })}
                  >
                    <ExternalLink className="size-4 mr-2" />
                    Continue to Composio →
                  </a>
                ) : (
                  <Button disabled className="mt-6 w-full">
                    <Loader2 className="size-4 animate-spin mr-2" />
                    Preparing…
                  </Button>
                )}
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function normalizeReturnTo(value: string | null): string {
  if (value && value.startsWith("/") && !value.startsWith("//")) return value;
  return "/connections";
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

"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ProviderLogos } from "@/components/connections/ProviderLogos";

type AppMeta = {
  slug: string;
  name: string;
  description: string;
};

export default function ConnectAppPage() {
  const params = useParams<{ app: string }>();
  const searchParams = useSearchParams();
  const router = useRouter();
  const slug = (params?.app || "").toLowerCase();
  const returnTo = searchParams.get("return_to") || "/connections";

  const [meta, setMeta] = useState<AppMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);

  useEffect(() => {
    if (!slug) return;
    let cancelled = false;
    (async () => {
      try {
        const result = await api.integrations.catalog({ search: slug, limit: 10 });
        if (cancelled) return;
        const match =
          result.items.find((it) => it.slug.toLowerCase() === slug) || result.items[0];
        if (match) {
          setMeta({
            slug: match.slug,
            name: match.name,
            description: match.description || "",
          });
        } else {
          setMeta({ slug, name: slug, description: "" });
        }
      } catch {
        if (!cancelled) setMeta({ slug, name: slug, description: "" });
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slug]);

  async function handleConnect() {
    if (connecting) return;
    setConnecting(true);
    const oauthTab = window.open("", "_blank");
    if (oauthTab) oauthTab.opener = null;
    try {
      const result = await api.connections.initiate(slug);
      if (result.redirect_url) {
        if (oauthTab) {
          oauthTab.location.href = result.redirect_url;
        } else {
          window.open(result.redirect_url, "_blank", "noopener,noreferrer");
        }
        toast.success(`Authorize ${meta?.name || slug} in the new tab`);
        router.push(returnTo);
      } else {
        oauthTab?.close();
        toast.success("Connection initiated");
        router.push(returnTo);
      }
    } catch (e) {
      oauthTab?.close();
      toast.error(e instanceof Error ? e.message : "Failed to start connection");
      setConnecting(false);
    }
  }

  const providerName = meta?.name || slug;

  // PR S19 (I-31): primary button was rendering invisible because the
  // hardcoded bg-[var(--ink)] + text-[var(--surface)] tokens didn't survive
  // theme switches (--surface doesn't exist in this project; we have --paper).
  // Replaced with shadcn Button (default variant), Card primitives.
  return (
    <div className="min-h-[calc(100vh-4rem)] flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-md">
        <Link
          href={returnTo}
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground mb-6"
        >
          <ArrowLeft className="size-4" />
          Back
        </Link>

        <Card>
          <CardContent className="p-8">
            <ProviderLogos providerIcon={slug} />

            <h1 className="mt-6 text-center text-xl font-semibold">
              Floom wants to connect to {providerName}
            </h1>

            {meta?.description && (
              <p className="mt-2 text-center text-sm text-muted-foreground">
                {meta.description}
              </p>
            )}

            <div className="mt-6 rounded-lg border bg-muted/40 p-4">
              <p className="text-sm font-medium">What this allows</p>
              <ul className="mt-2 space-y-1 text-sm text-muted-foreground list-disc list-inside">
                <li>Read your {providerName} data on your behalf</li>
                <li>Perform actions in {providerName} that your workers ask for</li>
                <li>You can revoke this at any time from the Connections page</li>
              </ul>
            </div>

            <Button
              type="button"
              onClick={handleConnect}
              disabled={loading || connecting}
              className="mt-6 w-full"
              size="lg"
            >
              {connecting ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Opening...
                </>
              ) : (
                `Connect to ${providerName}`
              )}
            </Button>

            <Link
              href={returnTo}
              className="mt-3 block text-center text-sm text-muted-foreground hover:text-foreground"
            >
              Cancel
            </Link>

            <p className="mt-6 text-center text-xs text-muted-foreground leading-relaxed">
              You will be redirected to {providerName} to authenticate. Floom uses
              Composio as its integrations layer, so you may see Composio&apos;s
              name on the next screen. That is expected.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, CheckCircle2, Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ProviderLogos } from "@/components/connections/ProviderLogos";
import type { ConnectedAccountSummary } from "@/lib/types";

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
  const returnTo = normalizeReturnTo(searchParams.get("return_to"));

  const [meta, setMeta] = useState<AppMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  // X9 / N5-1: surface an existing connection so the user isn't silently
  // re-OAuthing an app+account they already connected (which would dupe a row).
  const [existingAccounts, setExistingAccounts] = useState<ConnectedAccountSummary[]>([]);

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

  useEffect(() => {
    if (!slug) return;
    let cancelled = false;
    (async () => {
      try {
        const state = await api.connections.byApp(slug);
        if (cancelled) return;
        setExistingAccounts(state.connected ? state.accounts ?? [] : []);
      } catch {
        if (!cancelled) setExistingAccounts([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slug]);

  function handleConnect() {
    if (connecting) return;
    setConnecting(true);
    router.push(
      `/connections/redirect?app=${encodeURIComponent(slug)}&return_to=${encodeURIComponent(returnTo)}`
    );
  }

  const providerName = meta?.name || slug;
  const alreadyConnected = existingAccounts.length > 0;
  const primaryLabel = alreadyConnected
    ? `Reconnect ${providerName}`
    : `Connect to ${providerName}`;

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
              Workeros wants to connect to {providerName}
            </h1>

            {meta?.description && (
              <p className="mt-2 text-center text-sm text-muted-foreground">
                {meta.description}
              </p>
            )}

            {alreadyConnected && (
              <div className="mt-6 rounded-lg border border-[color-mix(in_srgb,var(--positive)_30%,var(--border))] bg-[color-mix(in_srgb,var(--positive)_8%,transparent)] p-4">
                <div className="flex items-start gap-2">
                  <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-[var(--positive)]" />
                  <div className="text-sm">
                    <p className="font-medium">
                      {providerName} is already connected
                    </p>
                    <ul className="mt-1 space-y-0.5 text-muted-foreground">
                      {existingAccounts.map((acct) => (
                        <li key={acct.id}>
                          {acct.account_label || "Connected account"}
                        </li>
                      ))}
                    </ul>
                    <p className="mt-2 text-muted-foreground">
                      Reconnecting refreshes access for the same account — it
                      won&apos;t create a duplicate. Connect a different account
                      to add it alongside this one.
                    </p>
                  </div>
                </div>
              </div>
            )}

            <div className="mt-6">
              <p className="text-sm font-medium text-muted-foreground">What this allows</p>
              <ul className="mt-2 space-y-1 text-sm text-muted-foreground list-none">
                <li>· Read your {providerName} data on your behalf</li>
                <li>· Perform actions in {providerName} that your workers ask for</li>
                <li>· Revoke access at any time from the Connections page</li>
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
                primaryLabel
              )}
            </Button>

            <Link
              href={returnTo}
              className="mt-3 block text-center text-sm text-muted-foreground hover:text-foreground"
            >
              Cancel
            </Link>

            <p className="mt-6 text-center text-xs text-muted-foreground leading-relaxed">
              You will be redirected to {providerName} to authenticate. Workeros uses
              Composio as its integrations layer, so you may see Composio&apos;s
              name on the next screen. That is expected.
            </p>
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

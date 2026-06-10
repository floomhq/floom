"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { AlertTriangle, Loader2 } from "lucide-react";

import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";

const CHANNEL_LABELS: Record<string, string> = {
  slack: "Slack",
  whatsapp: "WhatsApp",
  discord: "Discord",
  cli: "CLI",
};

export default function InstallChannelPage() {
  const params = useParams<{ channel?: string }>();
  const router = useRouter();
  const channel = String(params.channel || "").toLowerCase();
  const [error, setError] = useState<string | null>(null);

  const label = useMemo(() => CHANNEL_LABELS[channel] ?? "channel", [channel]);

  useEffect(() => {
    let cancelled = false;
    async function start() {
      if (channel === "slack") {
        try {
          const result = await api.slack.installUrl("/assistant?from_install=slack");
          if (!cancelled) window.location.href = result.install_url;
        } catch (err) {
          if (!cancelled) {
            setError(err instanceof Error ? err.message : "Slack install is not configured");
          }
        }
        return;
      }
      if (channel === "cli") {
        router.replace("/connections/mcp?from_install=cli");
        return;
      }
      if (channel === "whatsapp" || channel === "discord") {
        setError(`${label} install requires platform OAuth credentials before it can be completed.`);
        return;
      }
      setError("Unknown install channel.");
    }
    void start();
    return () => {
      cancelled = true;
    };
  }, [channel, label, router]);

  return (
    <main className="grid min-h-screen place-items-center bg-[var(--bg-app)] p-6">
      <div className="w-full max-w-md space-y-4 rounded-lg border border-border bg-card p-6 shadow-sm">
        {error ? (
          <>
            <div className="flex items-start gap-3">
              <AlertTriangle className="mt-0.5 size-5 text-amber-600" aria-hidden="true" />
              <div>
                <h1 className="text-base font-semibold">Install {label}</h1>
                <p className="mt-1 text-sm text-muted-foreground">{error}</p>
              </div>
            </div>
            <div className="flex gap-2">
              <Button size="sm" onClick={() => router.push("/settings")}>
                Open settings
              </Button>
              <Button size="sm" variant="secondary" onClick={() => router.push("/assistant")}>
                Open assistant
              </Button>
            </div>
          </>
        ) : (
          <div className="flex items-center gap-3 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            Starting {label} install...
          </div>
        )}
      </div>
    </main>
  );
}

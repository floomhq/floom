import { ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StatusPill } from "@/components/collection/StatusPill";
import { BrandLogo } from "./BrandLogo";
import type { SupportedConnectionApp } from "./connection-data";

export function ConnectAppRow({
  app,
  connected,
  connecting,
  onConnect,
}: {
  app: SupportedConnectionApp;
  connected: boolean;
  connecting: boolean;
  onConnect: (slug: string) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-[var(--radius-ui)] bg-[var(--glass-bg)] p-3 transition-colors hover:bg-[var(--paper-2)]">
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-[var(--radius-ui)] bg-[var(--paper)]">
          <BrandLogo icon={app.icon} className="size-4" />
        </div>
        <span className="truncate text-sm font-medium text-[var(--ink)]">
          {app.displayName}
        </span>
        {connected && <StatusPill spec={{ tone: "ok", label: "Connected" }} />}
      </div>
      <Button
        type="button"
        size="sm"
        variant={connected ? "outline" : "default"}
        className="w-[100px]"
        onClick={() => onConnect(app.slug)}
        disabled={connecting}
      >
        <ExternalLink className="size-3.5" />
        {connecting ? "Opening" : connected ? "Reconnect" : "Connect"}
      </Button>
    </div>
  );
}

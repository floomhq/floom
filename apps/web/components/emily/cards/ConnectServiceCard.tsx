"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { StatusPill } from "@/components/collection/StatusPill";
import { BrandLogo } from "@/components/connections/BrandLogo";
import type { ConnectServiceCard as ConnectServiceCardType } from "@/lib/emily-chat-types";

const APP_DESCRIPTIONS: Record<string, string> = {
  gmail: "Allow Emily to send emails from your Gmail account.",
  slack: "Allow Emily to post messages to your Slack workspace.",
  github: "Allow Emily to read your repositories and pull requests.",
  stripe: "Allow Emily to monitor your Stripe payment events.",
  hubspot: "Allow Emily to read and update your HubSpot CRM data.",
  notion: "Allow Emily to read and write your Notion pages.",
  "google-calendar": "Allow Emily to read and create calendar events.",
  "google-drive": "Allow Emily to read files from your Google Drive.",
};

export function ConnectServiceCard({ card }: { card: ConnectServiceCardType }) {
  const [connected, setConnected] = useState(card.connected);
  const description = APP_DESCRIPTIONS[card.appName] ?? `Allow Emily to use ${card.label}.`;

  return (
    <div className="rounded-lg bg-card overflow-hidden text-sm">
      <div className="flex items-center gap-2.5 px-3.5 py-2.5">
        <BrandLogo icon={card.appName} className="size-4 shrink-0" />
        <span className="font-medium flex-1">{connected ? card.label : `Connect ${card.label}`}</span>
        {connected && <StatusPill spec={{ tone: "ok", label: "Connected" }} />}
      </div>
      <div className="px-3.5 pb-3 space-y-2">
        {!connected ? (
          <>
            <p className="text-xs text-muted-foreground">{description}</p>
            <Button
              size="sm"
              className="h-7 text-xs gap-2 font-normal"
              style={{ background: "var(--primary)", color: "var(--primary-foreground)" }}
              onClick={() => setConnected(true)}
            >
              <BrandLogo icon={card.appName} className="size-3.5" />
              Connect {card.label}
            </Button>
          </>
        ) : (
          <p className="text-xs text-muted-foreground">Connected and ready.</p>
        )}
      </div>
    </div>
  );
}

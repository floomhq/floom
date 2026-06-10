"use client";

import { useState } from "react";
import { Share2 } from "lucide-react";
import type { AssetVisibility } from "@/lib/types";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { ShareModal } from "@/components/sharing/ShareModal";

// SPEC §5: opens the Drive-pattern Share modal (General access + link), wiring
// the BUILT worker visibility + share-link endpoints.
export function ShareWorkerButton({
  workerId,
  workerName,
  initialVisibility = "private",
  variant = "button",
}: {
  workerId: string;
  workerName?: string;
  initialVisibility?: AssetVisibility;
  variant?: "button" | "icon";
}) {
  const [open, setOpen] = useState(false);
  const [visibility, setVisibility] = useState<AssetVisibility>(initialVisibility);

  const onOpen = (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setOpen(true);
  };

  const modal = (
    <ShareModal
      open={open}
      onOpenChange={setOpen}
      title={workerName ?? "worker"}
      visibility={visibility}
      onSetVisibility={async (v) => {
        await api.workers.setVisibility(workerId, v);
        setVisibility(v);
      }}
      getShareLink={async () => (await api.workers.shareLink(workerId)).url}
    />
  );

  if (variant === "icon") {
    return (
      <>
        <button
          type="button"
          title="Share worker"
          aria-label="Share worker"
          onClick={onOpen}
          className="size-7 flex items-center justify-center rounded text-muted-foreground/50 hover:text-foreground transition-colors shrink-0"
        >
          <Share2 className="size-3.5" />
        </button>
        {modal}
      </>
    );
  }

  return (
    <>
      <Button variant="outline" size="sm" className="shrink-0" onClick={onOpen}>
        <Share2 className="w-4 h-4 mr-1.5" />
        Share
      </Button>
      {modal}
    </>
  );
}

"use client";

import { useState } from "react";
import { Check, Share2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";

export function ShareWorkerButton({
  workerId,
  workerName,
  variant = "button",
}: {
  workerId: string;
  workerName?: string;
  variant?: "button" | "icon";
}) {
  const [copied, setCopied] = useState(false);
  const [loading, setLoading] = useState(false);

  const share = async (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (loading) return;
    setLoading(true);
    try {
      const link = await api.workers.shareLink(workerId);
      await navigator.clipboard.writeText(link.url);
      setCopied(true);
      toast.success(workerName ? `Share link copied for ${workerName}` : "Share link copied");
      window.setTimeout(() => setCopied(false), 1600);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to create share link");
    } finally {
      setLoading(false);
    }
  };

  if (variant === "icon") {
    return (
      <button
        type="button"
        title="Share worker"
        aria-label="Share worker"
        onClick={share}
        disabled={loading}
        className="size-7 flex items-center justify-center rounded text-muted-foreground/50 hover:text-foreground transition-colors shrink-0 disabled:opacity-50"
      >
        {copied ? <Check className="size-3.5 text-[var(--success)]" /> : <Share2 className="size-3.5" />}
      </button>
    );
  }

  return (
    <Button variant="outline" size="sm" className="shrink-0" onClick={share} disabled={loading}>
      {copied ? <Check className="w-4 h-4 mr-1.5 text-[var(--success)]" /> : <Share2 className="w-4 h-4 mr-1.5" />}
      {copied ? "Copied" : "Share"}
    </Button>
  );
}

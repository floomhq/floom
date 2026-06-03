"use client";

import { useState } from "react";
import { Share2, Copy, ExternalLink, Check } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

/**
 * Share a worker as a public, read-only "skill card" page.
 *
 * The link is the worker's `public_link` (a deterministic signed HMAC URL the
 * API mints on the owner's authenticated fetch — same pattern as the approvals
 * Copy-link / Open-as-page UX). The public page exposes only safe fields
 * (name, purpose, I/O, tools) — never secrets, source, or run history.
 *
 * Two surfaces:
 *  - `variant="button"` — full button for the worker detail header
 *  - `variant="icon"` — compact icon button for the worker card
 */
export function ShareWorkerButton({
  publicLink,
  variant = "button",
}: {
  publicLink?: string | null;
  variant?: "button" | "icon";
}) {
  const [copied, setCopied] = useState(false);

  if (!publicLink) return null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(publicLink);
      setCopied(true);
      toast.success("Link copied");
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Failed to copy");
    }
  };

  const openPage = () => {
    window.open(publicLink, "_blank", "noopener,noreferrer");
  };

  return (
    <Dialog>
      <DialogTrigger
        render={
          variant === "icon" ? (
            <button
              type="button"
              title="Share worker"
              aria-label="Share worker"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
              }}
              className="size-7 flex items-center justify-center rounded text-muted-foreground/50 hover:text-foreground transition-colors shrink-0"
            >
              <Share2 className="size-3.5" />
            </button>
          ) : (
            <Button variant="outline" size="sm" className="shrink-0">
              <Share2 className="w-4 h-4 mr-1.5" />
              Share
            </Button>
          )
        }
      />
      <DialogContent className="sm:max-w-md" onClick={(e) => e.stopPropagation()}>
        <DialogHeader>
          <DialogTitle>Share worker</DialogTitle>
          <DialogDescription>
            Anyone with this link can view a read-only card for this worker — its
            purpose, inputs, outputs, and tools. No secrets, source, or run
            history are shared.
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2">
          <code className="flex-1 min-w-0 truncate text-xs font-mono bg-muted border border-border rounded px-2 py-2">
            {publicLink}
          </code>
          <button
            type="button"
            title="Copy link"
            onClick={copy}
            className="shrink-0 p-2 rounded border border-border bg-card hover:bg-muted transition-colors"
          >
            {copied ? (
              <Check className="w-4 h-4 text-emerald-600" />
            ) : (
              <Copy className="w-4 h-4 text-muted-foreground" />
            )}
          </button>
        </div>
        <DialogFooter className="sm:justify-start gap-2">
          <Button variant="outline" size="sm" onClick={copy}>
            <Copy className="w-3.5 h-3.5 mr-1.5" />
            Copy link
          </Button>
          <Button variant="outline" size="sm" onClick={openPage}>
            <ExternalLink className="w-3.5 h-3.5 mr-1.5" />
            Open page
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

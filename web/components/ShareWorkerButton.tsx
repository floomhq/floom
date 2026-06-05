"use client";

import { useState } from "react";
import { Share2, Copy, ExternalLink, Check, Download, Play } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

/**
 * Share a worker as a public "skill pack" card.
 *
 * C2 redesign: the link shown is the full `publicLink` (HMAC-signed worker URL).
 * A short `floom.dev/s/fls_<id>` link requires a backend short-link endpoint
 * (POST /workers/{id}/short-link → { short_url, short_id }).
 *
 * Backend contract needed (Codex lane):
 *   POST /workers/{id}/short-link
 *   → { short_url: "https://floom.dev/s/fls_<nanoid>", short_id: "fls_..." }
 *
 *   GET  /s/[id]  (new Next.js route at app/s/[id]/page.tsx)
 *   → resolves short_id → worker HMAC token → redirect to /w/[id]?token=...
 *     OR renders the card inline (Run on Floom / Install as skill)
 *
 * Until the backend ships, this component falls back to the long publicLink.
 * The UI shape and both CTAs are ready.
 *
 * Two surfaces:
 *  - `variant="button"` — full button for the worker detail header
 *  - `variant="icon"`   — compact icon button for the worker card
 */
export function ShareWorkerButton({
  publicLink,
  workerName,
  variant = "button",
}: {
  publicLink?: string | null;
  workerName?: string;
  variant?: "button" | "icon";
}) {
  const [copied, setCopied] = useState(false);

  if (!publicLink) return null;

  // TODO(backend): call POST /workers/{id}/short-link and use the returned
  // short_url once the endpoint exists. For now, show the full public link.
  const shareUrl = publicLink;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      toast.success("Link copied");
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Failed to copy");
    }
  };

  const openPage = () => {
    window.open(shareUrl, "_blank", "noopener,noreferrer");
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
      {/* N23: offset left by half the sidebar width on md+ so the modal centres
          over the content pane rather than the full viewport (which includes the
          240px sidebar, pulling the modal left under the sidebar rail). */}
      <DialogContent className="sm:max-w-md p-0 overflow-hidden md:translate-x-[120px]" onClick={(e) => e.stopPropagation()}>
        {/* Card header */}
        <div className="px-5 pt-5 pb-4 border-b border-[var(--border-soft)]">
          <DialogHeader>
            <DialogTitle className="text-base font-semibold">
              {workerName ? `Share "${workerName}"` : "Share worker"}
            </DialogTitle>
          </DialogHeader>
          <p className="mt-1 text-xs text-muted-foreground">
            Anyone with this link can view a read-only skill card — purpose, inputs, outputs, and tools. No secrets or run history.
          </p>
        </div>

        {/* Link row */}
        <div className="px-5 py-3 flex items-center gap-2 bg-[var(--bg-2)] border-b border-[var(--border-soft)]">
          <code className="flex-1 min-w-0 truncate text-xs font-mono text-muted-foreground">
            {shareUrl}
          </code>
          <button
            type="button"
            title="Copy link"
            onClick={copy}
            className="shrink-0 size-7 flex items-center justify-center rounded-md border border-[var(--border-default)] bg-[var(--bg-card)] hover:bg-muted transition-colors"
          >
            {copied ? (
              <Check className="w-3.5 h-3.5 text-emerald-600" />
            ) : (
              <Copy className="w-3.5 h-3.5 text-muted-foreground" />
            )}
          </button>
        </div>

        {/* Two primary actions */}
        <div className="px-5 py-4 space-y-2.5">
          <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            What recipients can do
          </p>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={openPage}
              className="flex flex-col items-start gap-1.5 rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] px-3.5 py-3 text-left transition-colors hover:bg-[var(--active-nav-bg)] hover:border-[var(--border-soft)]"
            >
              <span className="flex size-7 items-center justify-center rounded-lg bg-[var(--primary)] text-[var(--primary-text)]">
                <Play className="size-3.5" />
              </span>
              <span className="text-xs font-medium text-foreground">Run on Floom</span>
              <span className="text-[10px] text-muted-foreground leading-relaxed">
                Open the worker card and run it directly on Floom Workers.
              </span>
            </button>
            <button
              type="button"
              onClick={copy}
              className="flex flex-col items-start gap-1.5 rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] px-3.5 py-3 text-left transition-colors hover:bg-[var(--active-nav-bg)] hover:border-[var(--border-soft)]"
            >
              <span className="flex size-7 items-center justify-center rounded-lg bg-[var(--bg-2)] border border-[var(--border-default)]">
                <Download className="size-3.5 text-muted-foreground" />
              </span>
              <span className="text-xs font-medium text-foreground">Install as skill</span>
              <span className="text-[10px] text-muted-foreground leading-relaxed">
                Copy the link to install this worker as a reusable skill anywhere.
              </span>
            </button>
          </div>
        </div>

        {/* Footer copy-link button */}
        <div className="px-5 pb-5">
          <Button variant="outline" size="sm" onClick={copy} className="w-full">
            {copied ? (
              <Check className="w-3.5 h-3.5 mr-1.5 text-emerald-600" />
            ) : (
              <Copy className="w-3.5 h-3.5 mr-1.5" />
            )}
            {copied ? "Copied!" : "Copy link"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

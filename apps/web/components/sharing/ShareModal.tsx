"use client";

import { useState } from "react";
import { Copy, ExternalLink, Lock } from "lucide-react";
import { toast } from "sonner";
import type { AssetVisibility } from "@/lib/types";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  GENERAL_ACCESS_OPTIONS,
  shareSummary,
  SHARE_GAPS,
} from "@/lib/sharing/share-model";

// APP-UI-V4-SPEC §5: Drive-pattern Share modal — invite input → people list →
// General access [Private|Workspace] → public-link toggle ("view & duplicate") →
// footer Copy link / Open / Done. Generic over the asset (worker, brain folder,
// system prompt, run, approval, workspace): the caller supplies the current
// visibility, a setter, and a share-link getter.
export interface ShareModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  visibility: AssetVisibility;
  /** BUILT: PUT .../visibility. Returns once persisted. */
  onSetVisibility: (v: AssetVisibility) => Promise<void> | void;
  /** BUILT: create/return the standalone share URL. */
  getShareLink: () => Promise<string>;
}

export function ShareModal({
  open,
  onOpenChange,
  title,
  visibility,
  onSetVisibility,
  getShareLink,
}: ShareModalProps) {
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState<string | null>(null);

  const ensureLink = async (): Promise<string | null> => {
    if (link) return link;
    try {
      const url = await getShareLink();
      setLink(url);
      return url;
    } catch {
      toast.error("Could not create a share link.");
      return null;
    }
  };

  const copy = async () => {
    const url = await ensureLink();
    if (!url) return;
    await navigator.clipboard.writeText(url);
    toast.success("Share link copied");
  };

  const openLink = async () => {
    const url = await ensureLink();
    if (url) window.open(url, "_blank", "noopener");
  };

  const setVis = async (v: AssetVisibility) => {
    if (v === visibility) return;
    setBusy(true);
    try {
      await onSetVisibility(v);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Share “{title}”</DialogTitle>
        </DialogHeader>

        {/* Invite by email — specific-people grants are backend-pending (#767). */}
        <div className="space-y-1.5">
          <input
            className="c-srch w-full"
            style={{ maxWidth: "none" }}
            placeholder="Invite people by email"
            disabled
            title={`Inviting specific people is coming soon (#${SHARE_GAPS.invite})`}
          />
          {/* People-with-access list (#768): only the owner is known today. */}
          <p className="text-xs text-muted-foreground">
            You have access. {/* TODO(#768): list people with access. */}
          </p>
        </div>

        {/* General access — Private | Workspace ONLY (rule #8: no public level). */}
        <div className="space-y-1.5">
          <p className="text-[11px] font-medium uppercase text-muted-foreground">General access</p>
          <div className="flex gap-1.5">
            {GENERAL_ACCESS_OPTIONS.map((o) => (
              <button
                key={o.value}
                type="button"
                disabled={busy}
                onClick={() => void setVis(o.value)}
                className="c-vpill"
                style={{
                  padding: "6px 11px",
                  background: visibility === o.value ? "var(--accent-soft)" : undefined,
                  color: visibility === o.value ? "var(--ink)" : undefined,
                }}
                title={o.description}
              >
                {o.value === "private" && <Lock size={12} />} {o.label}
              </button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">{shareSummary(visibility)}</p>
        </div>

        {/* Public link toggle (#766) — view & duplicate. Backend pending. */}
        <label
          className="flex items-center justify-between text-sm opacity-60"
          title={`Per-asset public links are coming soon (#${SHARE_GAPS.publicLinkToggle})`}
        >
          <span>Anyone with the link can view &amp; duplicate</span>
          <input type="checkbox" disabled />
        </label>

        <div className="flex items-center gap-2 pt-1">
          <button type="button" className="c-vpill" style={{ padding: "7px 12px" }} onClick={() => void copy()}>
            <Copy size={13} /> Copy link
          </button>
          <button type="button" className="c-vpill" style={{ padding: "7px 12px" }} onClick={() => void openLink()}>
            <ExternalLink size={13} /> Open
          </button>
          <button
            type="button"
            className="c-addbtn"
            style={{ padding: "7px 14px", marginLeft: "auto" }}
            onClick={() => onOpenChange(false)}
          >
            Done
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

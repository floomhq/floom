"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, Copy, ExternalLink, Lock, X } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { reportError } from "@/lib/notify";
import type { AssetVisibility } from "@/lib/types";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
  /** #767/#768: when provided, the invite-by-email + people-with-access list go live. */
  grantAsset?: { type: string; id: string };
}

export function ShareModal({
  open,
  onOpenChange,
  title,
  visibility,
  onSetVisibility,
  getShareLink,
  grantAsset,
}: ShareModalProps) {
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const [grants, setGrants] = useState<import("@/lib/types").ShareGrant[]>([]);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteBusy, setInviteBusy] = useState(false);

  useEffect(() => {
    if (!open || !grantAsset) return;
    api.share
      .listGrants(grantAsset.type, grantAsset.id)
      .then(setGrants)
      .catch((err) => reportError("Could not load the share links.", err));
  }, [open, grantAsset]);

  const invite = async () => {
    const email = inviteEmail.trim();
    if (!email || !grantAsset) return;
    setInviteBusy(true);
    try {
      const g = await api.share.addGrant(grantAsset.type, grantAsset.id, email);
      setGrants((prev) => (prev.some((p) => p.id === g.id) ? prev : [...prev, g]));
      setInviteEmail("");
    } catch (err) {
      toast.error((err as Error).message || "Could not invite this person.");
    } finally {
      setInviteBusy(false);
    }
  };

  const revoke = async (id: string) => {
    try {
      await api.share.revokeGrant(id);
      setGrants((prev) => prev.filter((g) => g.id !== id));
    } catch {
      toast.error("Could not remove access.");
    }
  };

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

        {/* #767/#768: invite by email + people-with-access (when the caller
            supplies grantAsset). Owner-scoped assets (runs) omit it. */}
        {grantAsset ? (
          <div className="space-y-2">
            <div className="flex gap-2">
              <input
                className="c-srch w-full"
                style={{ maxWidth: "none" }}
                placeholder="Invite people by email"
                value={inviteEmail}
                disabled={inviteBusy}
                onChange={(e) => setInviteEmail(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void invite();
                }}
              />
              <button
                type="button"
                className="c-addbtn"
                style={{ padding: "7px 12px" }}
                disabled={inviteBusy || !inviteEmail.trim()}
                onClick={() => void invite()}
              >
                Invite
              </button>
            </div>
            <ul className="space-y-1">
              <li className="text-xs text-muted-foreground">You (owner)</li>
              {grants.map((g) => (
                <li key={g.id} className="flex items-center justify-between text-xs">
                  <span>{g.email}</span>
                  <button
                    type="button"
                    onClick={() => void revoke(g.id)}
                    className="text-muted-foreground hover:text-destructive"
                    aria-label={`Remove ${g.email}`}
                  >
                    <X size={13} />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <div className="space-y-1.5">
            <input
              className="c-srch w-full"
              style={{ maxWidth: "none" }}
              placeholder="Invite people by email"
              disabled
              title={`Inviting specific people is coming soon (#${SHARE_GAPS.invite})`}
            />
            <p className="text-xs text-muted-foreground">You have access.</p>
          </div>
        )}

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

        {/* Workspace sharing TRANSFERS ownership (workers only; shown
            unconditionally when the asset type is unknown). */}
        {visibility === "workspace" && (!grantAsset || grantAsset.type === "worker") && (
          <Alert variant="destructive">
            <AlertTriangle className="size-4" />
            <AlertTitle>Ownership transfer</AlertTitle>
            <AlertDescription>
              Sharing transfers this worker to the workspace. You will lose edit
              access, and an admin must configure its connections and secrets
              before it can run.
            </AlertDescription>
          </Alert>
        )}

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

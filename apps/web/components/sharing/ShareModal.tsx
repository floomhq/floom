"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Copy, ExternalLink, Globe, Lock, Trash2, Users, X } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { reportError } from "@/lib/notify";
import type { AssetVisibility, ShareGrant } from "@/lib/types";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import {
  GENERAL_ACCESS_OPTIONS,
  PUBLIC_LINK_UNLISTED_NOTE,
  publicLinkScope,
  shareSummary,
  type ShareAssetType,
  type ShareGrantAssetType,
} from "@/lib/sharing/share-model";

// ONE reusable Share modal across every shareable surface (worker / run / brain
// pack or file / approval). Three DISTINCT mechanisms, deliberately separated so
// users never conflate them:
//   1. Company access  — Private | Workspace visibility (workspace TRANSFERS a
//      worker to the workspace) + invite specific teammates by email (grants).
//   2. Public link      — an anonymous, no-sign-in standalone URL (view & duplicate).
// Sharing is always view-and-duplicate, never live collaboration.
//
// The public share-link backend is create-or-ROTATE and stores only sha256(token)
// (#934): there is NO GET, so we cannot read whether a link is live. The honest
// model is a session state machine — we only ever know the URL we minted in THIS
// mounted session. We never claim a link does or does not exist across reloads.

type PublicLinkState =
  | { status: "unknown" }
  | { status: "creating" }
  | { status: "active"; url: string }
  | { status: "confirm_revoke"; url: string }
  | { status: "revoking"; url: string }
  | { status: "revoked" };

type Vis = Extract<AssetVisibility, "private" | "workspace">;

export interface ShareModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;

  asset: {
    type: ShareAssetType;
    /** Display name shown in the title. */
    name: string;
  };

  /** Company-access (visibility + grants). Omit for assets without an internal tier (approval). */
  companyAccess?: {
    visibility: AssetVisibility;
    /** PUT .../visibility; resolves once persisted. */
    setVisibility: (v: Vis) => Promise<AssetVisibility | void> | void;
    /** Specific-people grants (invite by email). Omit to hide the invite row. */
    grantAsset?: { type: ShareGrantAssetType; id: string };
  };

  /** Public anonymous link. Omit to hide the whole Public-link section. */
  publicLink?: {
    /** POST .../share-link → returns the URL. Create-or-rotate. */
    create: () => Promise<string>;
    /** DELETE .../share-link. Omit when the link is non-revocable (approval HMAC). */
    revoke?: () => Promise<void>;
    /** A deterministic, always-valid URL (e.g. approval review link). When set,
        we skip the create/revoke state machine and just show Copy/Open. */
    staticUrl?: string;
    /** Override the default Public-link section label (e.g. "Decision link"). */
    label?: string;
  };
}

export function ShareModal({ open, onOpenChange, asset, companyAccess, publicLink }: ShareModalProps) {
  const grantAsset = companyAccess?.grantAsset;
  const visibility = companyAccess?.visibility;
  const isWorker = asset.type === "worker";

  const [grants, setGrants] = useState<ShareGrant[]>([]);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteBusy, setInviteBusy] = useState(false);
  const [visBusy, setVisBusy] = useState(false);
  const [pendingWorkspace, setPendingWorkspace] = useState(false);
  const [pub, setPub] = useState<PublicLinkState>({ status: "unknown" });
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!open || !grantAsset) return;
    api.share
      .listGrants(grantAsset.type, grantAsset.id)
      .then(setGrants)
      .catch((err) => reportError("Could not load the share links.", err));
  }, [open, grantAsset]);

  // -------- Specific-people grants (#767/#768) --------
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

  const removeGrant = async (id: string) => {
    try {
      await api.share.revokeGrant(id);
      setGrants((prev) => prev.filter((g) => g.id !== id));
    } catch {
      toast.error("Could not remove access.");
    }
  };

  // -------- Company access (visibility) --------
  const applyVisibility = async (next: Vis) => {
    if (!companyAccess || next === visibility) return;
    setVisBusy(true);
    try {
      await companyAccess.setVisibility(next);
    } catch (err) {
      toast.error((err as Error).message || "Could not update access.");
    } finally {
      setVisBusy(false);
      setPendingWorkspace(false);
    }
  };

  const selectVisibility = (next: Vis) => {
    // Workspace on a worker transfers ownership — confirm inline first.
    if (next === "workspace" && isWorker && visibility !== "workspace") {
      setPendingWorkspace(true);
      return;
    }
    void applyVisibility(next);
  };

  // -------- Public link state machine (#765/#766) --------
  const createLink = async () => {
    if (!publicLink) return;
    setPub({ status: "creating" });
    try {
      const url = await publicLink.create();
      if (mounted.current) setPub({ status: "active", url });
    } catch {
      if (mounted.current) setPub({ status: "unknown" });
      toast.error("Could not create public link.");
    }
  };

  const confirmRevoke = (url: string) => setPub({ status: "confirm_revoke", url });

  const revokeLink = async (url: string) => {
    if (!publicLink?.revoke) return;
    setPub({ status: "revoking", url });
    try {
      await publicLink.revoke();
      if (mounted.current) setPub({ status: "revoked" });
      toast.success("Public link revoked.");
    } catch {
      if (mounted.current) setPub({ status: "active", url });
      toast.error("Could not revoke public link.");
    }
  };

  const copy = async (url: string) => {
    await navigator.clipboard.writeText(url);
    toast.success("Link copied.");
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Share &ldquo;{asset.name}&rdquo;</DialogTitle>
        </DialogHeader>

        {/* ============ Inside your company ============ */}
        {companyAccess && (
          <section className="space-y-3">
            <p className="text-[11px] font-medium uppercase tracking-wide text-[var(--ink-mute)]">
              Inside your company
            </p>

            {/* Invite specific teammates by email (#767/#768) */}
            {grantAsset ? (
              <div className="space-y-2">
                <div className="flex gap-2">
                  <div className="c-srch" style={{ maxWidth: "none" }}>
                    <input
                      placeholder="Add teammate by email"
                      value={inviteEmail}
                      disabled={inviteBusy}
                      onChange={(e) => setInviteEmail(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void invite();
                      }}
                    />
                  </div>
                  <button
                    type="button"
                    className="c-addbtn"
                    disabled={inviteBusy || !inviteEmail.trim()}
                    onClick={() => void invite()}
                  >
                    Invite
                  </button>
                </div>
                <ul className="space-y-1.5 text-sm">
                  <li className="text-[var(--ink-mute)]">You</li>
                  {grants.length === 0 && (
                    <li className="text-xs text-[var(--ink-mute)]">No teammates invited yet.</li>
                  )}
                  {grants.map((g) => (
                    <li key={g.id} className="flex items-center justify-between">
                      <span className="text-[var(--ink)]">{g.email}</span>
                      <button
                        type="button"
                        onClick={() => void removeGrant(g.id)}
                        className="text-[var(--ink-mute)] transition-colors hover:text-[var(--ink)]"
                        aria-label={`Remove ${g.email}`}
                      >
                        <X size={14} />
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="text-sm text-[var(--ink-mute)]">You have access.</p>
            )}

            {/* Company access selector — Private | Workspace */}
            <div className="space-y-2">
              <p className="text-xs font-medium text-[var(--ink-soft)]">Company access</p>
              <div className="flex gap-2">
                {GENERAL_ACCESS_OPTIONS.map((o) => {
                  const active = visibility === o.value;
                  const Icon = o.value === "private" ? Lock : Users;
                  return (
                    <button
                      key={o.value}
                      type="button"
                      disabled={visBusy}
                      onClick={() => selectVisibility(o.value)}
                      className="flex items-center gap-1.5 rounded-[var(--radius-button)] px-3 py-1.5 text-sm transition-colors"
                      style={{
                        border: "var(--bd-input)",
                        background: active ? "var(--accent-soft)" : "var(--bg-2)",
                        color: active ? "var(--ink)" : "var(--muted-foreground)",
                      }}
                    >
                      <Icon size={13} />
                      {o.label}
                      {active && <Check size={13} />}
                    </button>
                  );
                })}
              </div>

              {/* Inline transfer confirmation (worker → workspace) */}
              {pendingWorkspace ? (
                <div className="space-y-2 rounded-[var(--radius-button)] bg-[var(--bg-2)] p-3" style={{ border: "var(--bd-input)" }}>
                  <p className="text-sm font-medium text-[var(--ink)]">Transfer worker to workspace?</p>
                  <p className="text-xs text-[var(--ink-mute)]">
                    This moves ownership to the workspace. You lose edit access. An admin must
                    configure connections and secrets before the worker can run.
                  </p>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      className="rounded-[var(--radius-button)] px-3 py-1.5 text-sm text-[var(--muted-foreground)]"
                      style={{ border: "var(--bd-input)" }}
                      onClick={() => setPendingWorkspace(false)}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      className="c-addbtn"
                      disabled={visBusy}
                      onClick={() => void applyVisibility("workspace")}
                    >
                      Transfer to workspace
                    </button>
                  </div>
                </div>
              ) : (
                <p className="text-xs text-[var(--ink-mute)]">{shareSummary(visibility)}</p>
              )}
            </div>
          </section>
        )}

        {companyAccess && publicLink && <Separator />}

        {/* ============ Public link ============ */}
        {publicLink && (
          <section className="space-y-2">
            <p className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-[var(--ink-mute)]">
              <Globe size={12} /> {publicLink.label ?? "Public link"}
            </p>
            <p className="text-xs text-[var(--ink-mute)]">{PUBLIC_LINK_UNLISTED_NOTE}</p>

            {/* Static, always-valid link (e.g. approval review HMAC) — no revoke. */}
            {publicLink.staticUrl ? (
              <PublicLinkRow
                url={publicLink.staticUrl}
                scope={publicLinkScope(asset.type)}
                onCopy={() => void copy(publicLink.staticUrl!)}
              />
            ) : pub.status === "active" || pub.status === "revoking" || pub.status === "confirm_revoke" ? (
              <div className="space-y-2">
                <PublicLinkRow
                  url={pub.url}
                  scope={publicLinkScope(asset.type)}
                  onCopy={() => void copy(pub.url)}
                  onRevoke={publicLink.revoke ? () => confirmRevoke(pub.url) : undefined}
                  revoking={pub.status === "revoking"}
                />
                <p className="text-xs text-[var(--ink-mute)]">
                  This is the only time we can show this exact URL. Save it before closing this tab.
                </p>
                {pub.status === "confirm_revoke" && (
                  <div className="space-y-2 rounded-[var(--radius-button)] bg-[var(--bg-2)] p-3" style={{ border: "var(--bd-input)" }}>
                    <p className="text-sm font-medium text-[var(--ink)]">Revoke public link?</p>
                    <p className="text-xs text-[var(--ink-mute)]">
                      Anyone using this link will lose access. You can create a new link later.
                    </p>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        className="rounded-[var(--radius-button)] px-3 py-1.5 text-sm text-[var(--muted-foreground)]"
                        style={{ border: "var(--bd-input)" }}
                        onClick={() => setPub({ status: "active", url: pub.url })}
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        className="rounded-[var(--radius-button)] px-3 py-1.5 text-sm font-medium text-[var(--destructive,#b42318)]"
                        style={{ border: "var(--bd-input)" }}
                        onClick={() => void revokeLink(pub.url)}
                      >
                        Revoke link
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ) : pub.status === "revoked" ? (
              <div className="space-y-2">
                <p className="text-sm text-[var(--ink-soft)]">Public link revoked</p>
                <p className="text-xs text-[var(--ink-mute)]">
                  The last link created in this tab no longer works.
                </p>
                <button type="button" className="c-addbtn" onClick={() => void createLink()}>
                  Create new link
                </button>
              </div>
            ) : (
              <div className="space-y-2">
                <p className="text-sm text-[var(--ink-soft)]">{publicLinkScope(asset.type)}</p>
                <p className="text-xs text-[var(--ink-mute)]">
                  Creating a new link disables any previous public link for this item.
                </p>
                <button
                  type="button"
                  className="c-addbtn"
                  disabled={pub.status === "creating"}
                  onClick={() => void createLink()}
                >
                  {pub.status === "creating" ? "Creating…" : "Create public link"}
                </button>
              </div>
            )}
          </section>
        )}

        <div className="flex justify-end pt-1">
          <button
            type="button"
            className="rounded-[var(--radius-button)] px-4 py-1.5 text-sm text-[var(--muted-foreground)]"
            style={{ border: "var(--bd-input)" }}
            onClick={() => onOpenChange(false)}
          >
            Done
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function PublicLinkRow({
  url,
  scope,
  onCopy,
  onRevoke,
  revoking,
}: {
  url: string;
  scope: string;
  onCopy: () => void;
  onRevoke?: () => void;
  revoking?: boolean;
}) {
  return (
    <div className="space-y-2">
      <p className="text-sm text-[var(--ink-soft)]">{scope}</p>
      <div className="flex items-center gap-2">
        <div className="c-srch flex-1 truncate" style={{ maxWidth: "none" }}>
          <span className="truncate text-[var(--accent,#2563eb)]">{url}</span>
        </div>
        <button
          type="button"
          className="c-vpill"
          style={{ padding: "7px 11px" }}
          onClick={onCopy}
          aria-label="Copy link"
        >
          <Copy size={13} /> Copy
        </button>
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="c-vpill"
          style={{ padding: "7px 11px" }}
          aria-label="Open link"
        >
          <ExternalLink size={13} /> Open
        </a>
        {onRevoke && (
          <button
            type="button"
            className="c-vpill"
            style={{ padding: "7px 11px" }}
            disabled={revoking}
            onClick={onRevoke}
            aria-label="Revoke link"
          >
            <Trash2 size={13} /> {revoking ? "Revoking…" : "Revoke"}
          </button>
        )}
      </div>
    </div>
  );
}

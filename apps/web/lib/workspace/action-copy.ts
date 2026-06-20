/**
 * Copy for the WorkspaceSwitcher "Workspace actions" group (#1005).
 *
 * Self-hosted installs use template-zip vocabulary ("Export workspace" /
 * "Share as template link" / "Duplicate workspace"); managed multi-tenant
 * deployments may prefer invite vocabulary ("Download copy" / "Invite someone
 * by link" / "Make a local copy"). Gating the copy here lets downstream hosts
 * consume the engine WorkspaceSwitcher directly instead of forking it.
 *
 * The underlying actions are identical in both modes; only the user-facing
 * wording changes.
 */
export interface WorkspaceActionCopy {
  exportLabel: string;
  exporting: string;
  exportHelp: string;
  exportToast: string;
  duplicateLabel: string;
  duplicating: string;
  duplicateHelp: string;
  shareLabel: string;
  sharing: string;
  shareHelp: string;
  shareCopied: string;
  shareReady: string;
  shareFailed: string;
}

const OSS_COPY: WorkspaceActionCopy = {
  exportLabel: "Export workspace",
  exporting: "Exporting…",
  exportHelp: "Download a zip of agents + instructions (no secrets)",
  exportToast: "Workspace template exported",
  duplicateLabel: "Duplicate workspace",
  duplicating: "Duplicating…",
  duplicateHelp:
    "Copies agents + instructions. Connections & secrets are not copied; reconnect after.",
  shareLabel: "Share as template link",
  sharing: "Creating link…",
  shareHelp: "Shareable link to the exported zip (no secrets included)",
  shareCopied: "Template link copied to clipboard",
  shareReady: "Template link ready",
  shareFailed: "Failed to create template link",
};

const CLOUD_COPY: WorkspaceActionCopy = {
  exportLabel: "Download copy",
  exporting: "Downloading…",
  exportHelp: "Download a zip of agents + instructions (no secrets)",
  exportToast: "Workspace downloaded",
  duplicateLabel: "Make a local copy",
  duplicating: "Copying…",
  duplicateHelp:
    "Copies agents + instructions into a new workspace. Connections & secrets are not copied; reconnect after.",
  shareLabel: "Invite someone by link",
  sharing: "Creating invite…",
  shareHelp: "Shareable invite link to this workspace (no secrets included)",
  shareCopied: "Invite link copied to clipboard",
  shareReady: "Invite link ready",
  shareFailed: "Failed to create invite link",
};

/** Resolve the action copy for the current deploy mode. */
export function getWorkspaceActionCopy(isCloudMode: boolean): WorkspaceActionCopy {
  return isCloudMode ? CLOUD_COPY : OSS_COPY;
}

/** True when the bundle is built for a managed multi-tenant deployment. */
export function isCloudMode(): boolean {
  return process.env.NEXT_PUBLIC_WORKEROS_DEPLOY === "cloud";
}

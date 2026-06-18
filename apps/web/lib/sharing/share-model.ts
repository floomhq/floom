// Share-modal model (APP-UI-V4-SPEC §5, rule #8).
//
// Sharing = others can VIEW & DUPLICATE — never collaborate live. Company access
// is Private | Workspace ONLY; there is NO "public" company-access level (killed
// deliberately, rule #8). "Public" is a SEPARATE, anonymous link (the standalone
// share-link backend, #765/#766) framed as "anyone outside your workspace".
//
// All three backends are now LIVE: specific-people grants (#767/#768), per-asset
// public share-link create/revoke (#765/#766), and workspace visibility. The
// previous "Backend pending" affordances are gone.
import type { AssetVisibility } from "@/lib/types";

/** The asset types the Share modal renders. */
export type ShareAssetType =
  | "worker"
  | "run"
  | "brain_pack"
  | "brain_file"
  | "approval";

/** Backend grant asset_type — coarser than the UI asset type. */
export type ShareGrantAssetType = "worker" | "run" | "brain" | "workspace";

export interface GeneralAccessOption {
  value: Extract<AssetVisibility, "private" | "workspace">;
  label: string;
  description: string;
}

// Order + copy for the Company access selector. No "public" entry by design.
export const GENERAL_ACCESS_OPTIONS: GeneralAccessOption[] = [
  { value: "private", label: "Private", description: "Only you and invited teammates can view and duplicate this." },
  {
    value: "workspace",
    label: "Workspace",
    description:
      "Transfers this worker to the workspace. Members can view and run it; admins configure secrets and connections.",
  },
];

/** Human label for any stored visibility (incl. specific_people grants). */
export function generalAccessLabel(v: AssetVisibility | undefined): string {
  switch (v) {
    case "workspace":
      return "Workspace";
    case "specific_people":
      return "Specific people";
    case "private":
    default:
      return "Private";
  }
}

/** One-line summary shown under the Company-access selector. View-and-duplicate. */
export function shareSummary(v: AssetVisibility | undefined): string {
  switch (v) {
    case "workspace":
      return "Anyone in the workspace can view and duplicate this.";
    case "specific_people":
      return "Only invited people can view and duplicate this.";
    case "private":
    default:
      return "Only you and invited teammates can view and duplicate this.";
  }
}

/** Per-asset description of what a PUBLIC (anonymous, no-sign-in) link exposes. */
export function publicLinkScope(type: ShareAssetType): string {
  switch (type) {
    case "run":
      return "They can view this run, including inputs, steps, tool calls, output, and cost.";
    case "brain_pack":
      return "They can view and duplicate this brain pack.";
    case "brain_file":
      return "They can view and duplicate this file.";
    case "approval":
      return "Anyone with this link can review, approve, or reject this pending approval.";
    case "worker":
    default:
      return "They can view the worker, inspect its files, and duplicate it.";
  }
}

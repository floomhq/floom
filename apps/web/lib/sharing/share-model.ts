// Drive-pattern Share modal model (APP-UI-V4-SPEC §5, rule #8).
//
// Sharing = others can VIEW & DUPLICATE — never collaborate live. "General
// access" is Private | Workspace ONLY; there is NO "public" level (killed
// deliberately, rule #8). The invite/grants row (#767), people-with-access list
// (#768) and per-asset public-link toggle (#766) are backend-pending — the model
// marks them so the UI can show honest disabled affordances, not dead buttons.
import type { AssetVisibility } from "@/lib/types";

export interface GeneralAccessOption {
  value: Extract<AssetVisibility, "private" | "workspace">;
  label: string;
  description: string;
}

// Order + copy for the General access selector. No "public" entry by design.
export const GENERAL_ACCESS_OPTIONS: GeneralAccessOption[] = [
  { value: "private", label: "Private", description: "Only you can access this." },
  {
    value: "workspace",
    label: "Workspace",
    description:
      "Transfers this worker to the workspace. Members can view and run it; only admins can edit it.",
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

/** One-line summary shown under the selector. Always view-and-duplicate. */
export function shareSummary(v: AssetVisibility | undefined): string {
  switch (v) {
    case "workspace":
      return "Anyone in the workspace can view and duplicate this.";
    case "specific_people":
      return "Only invited people can view and duplicate this.";
    case "private":
    default:
      return "Only you can access this.";
  }
}

// Backend gaps surfaced in the modal as honest disabled affordances.
export const SHARE_GAPS = {
  invite: 767, // specific-people grants (invite by email)
  peopleList: 768, // people-with-access listing
  publicLinkToggle: 766, // per-asset enable/disable/revoke public link
} as const;

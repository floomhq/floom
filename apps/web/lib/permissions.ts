/**
 * Permission helper (SPEC §6, §12 + BACKEND-MAP "the clean win").
 *
 * The backend returns a per-asset `permissions` object (AssetPermissions) on
 * worker/context/assistant detail. The UI gates Edit/Delete/Share/Run directly
 * off it — NO custom role logic in the frontend. When `permissions` is absent
 * (OSS single-tenant, or list endpoints that don't compute it), we fall back to
 * "allowed" so the single-user experience is unchanged.
 */
import type { AssetPermissions, AssetVisibility } from "./types";

export type AssetAction = "edit" | "delete" | "share" | "run" | "view";

export interface HasPermissions {
  permissions?: AssetPermissions | null;
  visibility?: AssetVisibility | null;
  owner_id?: string | null;
}

/** Gate an action off the asset's computed permissions (default-allow). */
export function can(action: AssetAction, item: HasPermissions | null | undefined): boolean {
  const p = item?.permissions;
  if (!p) return true; // no computed permissions → single-tenant, allow
  switch (action) {
    case "edit":
      return p.can_edit;
    case "delete":
      return p.can_delete;
    case "share":
      return p.can_share;
    case "run":
      return p.can_run;
    case "view":
      return p.can_view;
    default:
      return false;
  }
}

/** True when the viewer can SEE but not EDIT (drives the "View only" affordance). */
export function isViewOnly(item: HasPermissions | null | undefined): boolean {
  const p = item?.permissions;
  if (!p) return false;
  return p.can_view && !p.can_edit;
}

/**
 * Feedback is a first-class capability for anyone who can view an asset they
 * don't own (SPEC §12). The backend now serves `GET/POST /workers/{id}/feedback`
 * (migration 63 + FeedbackRepository), so the UI is live.
 */
export const FEEDBACK_BACKEND_AVAILABLE = true;

export function canLeaveFeedback(item: HasPermissions | null | undefined): boolean {
  return can("view", item) && !item?.permissions?.is_owner;
}

/** Private vs Shared label for the visibility pill (SPEC §12). */
export function visibilityLabel(v: AssetVisibility | null | undefined): "Private" | "Shared" {
  return v === "workspace" ? "Shared" : "Private";
}

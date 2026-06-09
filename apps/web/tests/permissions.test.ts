import { describe, it, expect } from "vitest";
import { can, isViewOnly, canLeaveFeedback, visibilityLabel } from "@/lib/permissions";
import type { AssetPermissions } from "@/lib/types";

const perms = (over: Partial<AssetPermissions>): AssetPermissions => ({
  is_owner: false,
  can_view: true,
  can_edit: false,
  can_run: false,
  can_delete: false,
  can_share: false,
  ...over,
});

describe("can (default-allow when no permissions)", () => {
  it("allows everything for single-tenant items (no permissions field)", () => {
    expect(can("edit", {})).toBe(true);
    expect(can("delete", { permissions: null })).toBe(true);
    expect(can("edit", undefined)).toBe(true);
  });

  it("gates strictly off the computed matrix", () => {
    const item = { permissions: perms({ can_edit: true, can_run: true }) };
    expect(can("edit", item)).toBe(true);
    expect(can("run", item)).toBe(true);
    expect(can("delete", item)).toBe(false);
    expect(can("share", item)).toBe(false);
  });
});

describe("isViewOnly", () => {
  it("true when viewer can see but not edit", () => {
    expect(isViewOnly({ permissions: perms({ can_view: true, can_edit: false }) })).toBe(true);
  });
  it("false when editable, or when no permissions computed", () => {
    expect(isViewOnly({ permissions: perms({ can_edit: true }) })).toBe(false);
    expect(isViewOnly({})).toBe(false);
  });
});

describe("canLeaveFeedback", () => {
  it("allowed for a viewer who is not the owner", () => {
    expect(canLeaveFeedback({ permissions: perms({ can_view: true, is_owner: false }) })).toBe(true);
  });
  it("not shown to the owner (they edit directly)", () => {
    expect(canLeaveFeedback({ permissions: perms({ is_owner: true }) })).toBe(false);
  });
});

describe("visibilityLabel", () => {
  it("maps workspace→Shared, everything else→Private", () => {
    expect(visibilityLabel("workspace")).toBe("Shared");
    expect(visibilityLabel("private")).toBe("Private");
    expect(visibilityLabel(null)).toBe("Private");
  });
});

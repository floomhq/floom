import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ShareModal } from "@/components/sharing/ShareModal";
import { GENERAL_ACCESS_OPTIONS } from "@/lib/sharing/share-model";

// Workspace sharing TRANSFERS worker ownership to the workspace: the sharer
// loses edit access and an admin must configure connections/secrets. Selecting
// "Workspace" on a worker shows an inline confirmation BEFORE the PUT fires.

const { listGrants, addGrant, revokeGrant } = vi.hoisted(() => ({
  listGrants: vi.fn(),
  addGrant: vi.fn(),
  revokeGrant: vi.fn(),
}));
vi.mock("@/lib/api", () => ({ api: { share: { listGrants, addGrant, revokeGrant } } }));

beforeEach(() => {
  vi.clearAllMocks();
  listGrants.mockResolvedValue([]);
});

const CONFIRM_TITLE = /Transfer worker to workspace\?/;
const CONFIRM_BODY =
  /This moves ownership to the workspace\. You lose edit access\. An admin must configure connections and secrets before the worker can run\./;

describe("share-transfer confirmation", () => {
  it("asks to confirm transfer before applying workspace visibility to a worker", () => {
    const setVisibility = vi.fn().mockResolvedValue("workspace");
    render(
      <ShareModal
        open
        onOpenChange={() => {}}
        asset={{ type: "worker", name: "My worker" }}
        companyAccess={{
          visibility: "private",
          setVisibility,
          grantAsset: { type: "worker", id: "alpha" },
        }}
      />
    );
    // Clicking Workspace surfaces the confirmation; the PUT does NOT fire yet.
    fireEvent.click(screen.getByRole("button", { name: /Workspace/ }));
    expect(screen.getByText(CONFIRM_TITLE)).toBeInTheDocument();
    expect(screen.getByText(CONFIRM_BODY)).toBeInTheDocument();
    expect(setVisibility).not.toHaveBeenCalled();
    // Confirming fires the PUT.
    fireEvent.click(screen.getByRole("button", { name: "Transfer to workspace" }));
    expect(setVisibility).toHaveBeenCalledWith("workspace");
  });

  it("does not show the transfer confirmation when already workspace", () => {
    render(
      <ShareModal
        open
        onOpenChange={() => {}}
        asset={{ type: "worker", name: "My worker" }}
        companyAccess={{
          visibility: "workspace",
          setVisibility: vi.fn(),
          grantAsset: { type: "worker", id: "alpha" },
        }}
      />
    );
    expect(screen.queryByText(CONFIRM_TITLE)).toBeNull();
  });

  it("share-model workspace description mentions the transfer", () => {
    const workspace = GENERAL_ACCESS_OPTIONS.find((o) => o.value === "workspace");
    expect(workspace?.description).toContain("Transfers");
    expect(workspace?.description).toContain(
      "Members can view and run it; admins configure secrets and connections."
    );
  });
});

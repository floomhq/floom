import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { ShareModal } from "@/components/sharing/ShareModal";
import { GENERAL_ACCESS_OPTIONS } from "@/lib/sharing/share-model";

// Workspace sharing now TRANSFERS worker ownership to the workspace: the
// sharer loses edit access and an admin must configure connections/secrets.

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

const WARNING =
  /Sharing transfers this worker to the workspace\. You will lose edit access, and an admin must configure its connections and secrets before it can run\./;

describe("share-transfer warning", () => {
  it("renders the transfer warning when workspace visibility is selected for a worker", () => {
    render(
      <ShareModal
        open
        onOpenChange={() => {}}
        title="My worker"
        visibility="workspace"
        onSetVisibility={vi.fn()}
        getShareLink={vi.fn().mockResolvedValue("u")}
        grantAsset={{ type: "worker", id: "alpha" }}
      />
    );
    expect(screen.getByText(WARNING)).toBeInTheDocument();
  });

  it("renders the warning unconditionally when the asset type is unknown", () => {
    render(
      <ShareModal
        open
        onOpenChange={() => {}}
        title="Untyped asset"
        visibility="workspace"
        onSetVisibility={vi.fn()}
        getShareLink={vi.fn().mockResolvedValue("u")}
      />
    );
    expect(screen.getByText(WARNING)).toBeInTheDocument();
  });

  it("does not render the warning for private visibility", () => {
    render(
      <ShareModal
        open
        onOpenChange={() => {}}
        title="My worker"
        visibility="private"
        onSetVisibility={vi.fn()}
        getShareLink={vi.fn().mockResolvedValue("u")}
        grantAsset={{ type: "worker", id: "alpha" }}
      />
    );
    expect(screen.queryByText(WARNING)).toBeNull();
  });

  it("share-model workspace description mentions the transfer", () => {
    const workspace = GENERAL_ACCESS_OPTIONS.find((o) => o.value === "workspace");
    expect(workspace?.description).toContain("Transfers");
    expect(workspace?.description).toContain(
      "Members can view and run it; only admins can edit it."
    );
  });
});

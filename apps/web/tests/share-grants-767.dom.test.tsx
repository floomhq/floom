import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor as rtlWaitFor } from "@testing-library/react";
import { ShareModal } from "@/components/sharing/ShareModal";

// #767/#768: ShareModal invite + people-with-access (when companyAccess.grantAsset is given).

const { listGrants, addGrant, revokeGrant } = vi.hoisted(() => ({
  listGrants: vi.fn(),
  addGrant: vi.fn(),
  revokeGrant: vi.fn(),
}));
vi.mock("@/lib/api", () => ({ api: { share: { listGrants, addGrant, revokeGrant } } }));

beforeEach(() => {
  vi.clearAllMocks();
  listGrants.mockResolvedValue([{ id: "g1", email: "bob@example.com", created_at: "" }]);
  addGrant.mockResolvedValue({ id: "g2", email: "carol@example.com", created_at: "" });
  revokeGrant.mockResolvedValue(null);
});

describe("ShareModal grants (#767/#768)", () => {
  it("lists existing people and invites a new one", async () => {
    render(
      <ShareModal
        open
        onOpenChange={() => {}}
        asset={{ type: "worker", name: "My worker" }}
        companyAccess={{
          visibility: "private",
          setVisibility: vi.fn(),
          grantAsset: { type: "worker", id: "alpha" },
        }}
      />
    );

    // #768: existing grant listed.
    expect(await screen.findByText("bob@example.com")).toBeInTheDocument();
    expect(screen.getByText("You")).toBeInTheDocument();

    // #767: invite a new person.
    fireEvent.change(screen.getByPlaceholderText("Add teammate by email"), {
      target: { value: "carol@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Invite" }));
    await rtlWaitFor(() => expect(addGrant).toHaveBeenCalledWith("worker", "alpha", "carol@example.com"));
    expect(await screen.findByText("carol@example.com")).toBeInTheDocument();
  });

  it("shows a fallback when companyAccess has no grantAsset", () => {
    render(
      <ShareModal
        open
        onOpenChange={() => {}}
        asset={{ type: "run", name: "run" }}
        companyAccess={{ visibility: "private", setVisibility: vi.fn() }}
      />
    );
    expect(screen.getByText("You have access.")).toBeInTheDocument();
  });
});

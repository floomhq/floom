import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor as rtlWaitFor } from "@testing-library/react";
import { ShareModal } from "@/components/sharing/ShareModal";

// #767/#768: ShareModal invite + people-with-access (when grantAsset is given).

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
        title="My worker"
        visibility="private"
        onSetVisibility={vi.fn()}
        getShareLink={vi.fn().mockResolvedValue("u")}
        grantAsset={{ type: "worker", id: "alpha" }}
      />
    );

    // #768: existing grant listed.
    expect(await screen.findByText("bob@example.com")).toBeInTheDocument();
    expect(screen.getByText("You (owner)")).toBeInTheDocument();

    // #767: invite a new person.
    fireEvent.change(screen.getByPlaceholderText("Invite people by email"), {
      target: { value: "carol@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Invite" }));
    await rtlWaitFor(() => expect(addGrant).toHaveBeenCalledWith("worker", "alpha", "carol@example.com"));
    expect(await screen.findByText("carol@example.com")).toBeInTheDocument();
  });

  it("keeps the invite disabled when no grantAsset is supplied", () => {
    render(
      <ShareModal
        open
        onOpenChange={() => {}}
        title="run"
        visibility="private"
        onSetVisibility={vi.fn()}
        getShareLink={vi.fn().mockResolvedValue("u")}
      />
    );
    expect((screen.getByPlaceholderText("Invite people by email") as HTMLInputElement).disabled).toBe(true);
  });
});

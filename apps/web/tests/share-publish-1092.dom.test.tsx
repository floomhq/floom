import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ShareModal } from "@/components/sharing/ShareModal";

// #1092: the Publish section makes a worker's /@handle/slug permalink public.
// A private worker shows a Publish CTA that confirms before firing; a public
// worker shows the live permalink + an Unpublish affordance.

vi.mock("@/lib/api", () => ({ api: { share: { listGrants: vi.fn().mockResolvedValue([]) } } }));

describe("ShareModal publish section (#1092)", () => {
  it("confirms before publishing a private worker", async () => {
    const onPublish = vi.fn().mockResolvedValue(undefined);
    render(
      <ShareModal
        open
        onOpenChange={() => {}}
        asset={{ type: "worker", name: "Meeting Prep" }}
        publish={{ isPublic: false, permalink: null, onPublish, onUnpublish: vi.fn() }}
      />
    );
    // CTA present; confirm required before the publish call fires.
    fireEvent.click(screen.getByRole("button", { name: /Publish to web/ }));
    expect(screen.getByText(/Publish this worker to the web\?/)).toBeInTheDocument();
    expect(onPublish).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Publish page/ }));
    await waitFor(() => expect(onPublish).toHaveBeenCalledTimes(1));
  });

  it("shows the live permalink and an unpublish control when public", () => {
    render(
      <ShareModal
        open
        onOpenChange={() => {}}
        asset={{ type: "worker", name: "Meeting Prep" }}
        publish={{
          isPublic: true,
          permalink: "https://floom.dev/@acme/meeting-prep",
          onPublish: vi.fn(),
          onUnpublish: vi.fn(),
        }}
      />
    );
    expect(screen.getByText("https://floom.dev/@acme/meeting-prep")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Unpublish/ })).toBeInTheDocument();
  });

  it("confirms before unpublishing", async () => {
    const onUnpublish = vi.fn().mockResolvedValue(undefined);
    render(
      <ShareModal
        open
        onOpenChange={() => {}}
        asset={{ type: "worker", name: "Meeting Prep" }}
        publish={{
          isPublic: true,
          permalink: "https://floom.dev/@acme/meeting-prep",
          onPublish: vi.fn(),
          onUnpublish,
        }}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /^Unpublish$/ }));
    expect(screen.getByText(/Unpublish this page\?/)).toBeInTheDocument();
    expect(onUnpublish).not.toHaveBeenCalled();
    // The confirm card's destructive button also reads "Unpublish"; pick the last.
    const unpublishButtons = screen.getAllByRole("button", { name: /Unpublish/ });
    fireEvent.click(unpublishButtons[unpublishButtons.length - 1]);
    await waitFor(() => expect(onUnpublish).toHaveBeenCalledTimes(1));
  });

  it("hides the publish section entirely when the prop is absent", () => {
    render(
      <ShareModal
        open
        onOpenChange={() => {}}
        asset={{ type: "worker", name: "Meeting Prep" }}
        companyAccess={{ visibility: "private", setVisibility: vi.fn(), grantAsset: { type: "worker", id: "w1" } }}
      />
    );
    expect(screen.queryByText(/Public page/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Publish to web/ })).not.toBeInTheDocument();
  });
});

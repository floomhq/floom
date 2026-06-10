import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ShareModal } from "@/components/sharing/ShareModal";

// #766: the public-link toggle creates a link when turned on and revokes it
// when turned off (only live when onRevokeShareLink is supplied).

beforeEach(() => vi.clearAllMocks());

describe("ShareModal public-link toggle (#766)", () => {
  it("creates on check and revokes on uncheck", async () => {
    const getShareLink = vi.fn().mockResolvedValue("https://x/s/fls_abc");
    const onRevoke = vi.fn().mockResolvedValue(undefined);

    render(
      <ShareModal
        open
        onOpenChange={() => {}}
        title="My worker"
        visibility="workspace"
        onSetVisibility={vi.fn()}
        getShareLink={getShareLink}
        onRevokeShareLink={onRevoke}
      />
    );

    const checkbox = screen.getByRole("checkbox") as HTMLInputElement;
    expect(checkbox.checked).toBe(false);

    fireEvent.click(checkbox); // turn on → create
    await waitFor(() => expect(getShareLink).toHaveBeenCalledTimes(1));
    await waitFor(() => expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(true));

    fireEvent.click(screen.getByRole("checkbox")); // turn off → revoke
    await waitFor(() => expect(onRevoke).toHaveBeenCalledTimes(1));
    await waitFor(() => expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(false));
  });

  it("is disabled when no revoke handler is provided (backend-pending fallback)", () => {
    render(
      <ShareModal
        open
        onOpenChange={() => {}}
        title="My worker"
        visibility="workspace"
        onSetVisibility={vi.fn()}
        getShareLink={vi.fn().mockResolvedValue("u")}
      />
    );
    expect((screen.getByRole("checkbox") as HTMLInputElement).disabled).toBe(true);
  });
});

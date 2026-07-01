import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { TermsAcceptanceGate } from "@/components/TermsAcceptanceGate";
import { api } from "@/lib/api";

vi.mock("@/lib/api", () => ({
  api: {
    me: vi.fn(),
  },
}));

describe("TermsAcceptanceGate", () => {
  const meMock = vi.mocked(api.me);

  beforeEach(() => {
    window.localStorage.clear();
    meMock.mockReset();
    meMock.mockResolvedValue({ user_id: "u_1", workspace_id: "w_1", terms_required: true, terms_accepted: false });
  });

  it("renders as a centered modal, not a bottom composer overlay", async () => {
    render(<TermsAcceptanceGate />);

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Accept Floom terms");
    expect(dialog.className).toContain("top-1/2");
    expect(dialog.className).toContain("left-1/2");
    expect(dialog.className).not.toContain("bottom-0");
    expect(screen.queryByRole("button", { name: "Not now" })).not.toBeInTheDocument();
  });

  it("stores acceptance and closes the gate", async () => {
    render(<TermsAcceptanceGate />);

    fireEvent.click(await screen.findByRole("button", { name: "Accept and continue" }));

    expect(window.localStorage.getItem("floom.terms.accepted.v1:w_1:u_1")).toBe("1");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("checks the current user before honoring local acceptance", async () => {
    window.localStorage.setItem("floom.terms.accepted.v1", "1");

    render(<TermsAcceptanceGate />);

    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(meMock).toHaveBeenCalledTimes(1);
  });
});

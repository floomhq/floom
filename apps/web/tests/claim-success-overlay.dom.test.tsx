import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ClaimSuccessOverlay } from "@/components/channels/ClaimSuccessOverlay";

// the operator 2026-06-11: successful channel claim shows a full-screen
// confirmation, channel-aware, with a continue action.

describe("ClaimSuccessOverlay", () => {
  it("renders a full-screen WhatsApp success with the warm Emily line", () => {
    render(<ClaimSuccessOverlay channel="whatsapp" onContinue={() => {}} />);
    const dialog = screen.getByRole("dialog");
    expect(dialog.className).toContain("fixed");
    expect(dialog.className).toContain("inset-0");
    expect(screen.getByText("You're connected")).toBeTruthy();
    expect(screen.getByText(/Emily will message you on WhatsApp/)).toBeTruthy();
  });

  it("uses Slack-specific copy for the slack channel", () => {
    render(<ClaimSuccessOverlay channel="slack" onContinue={() => {}} />);
    expect(screen.getByText("You're connected")).toBeTruthy();
    expect(screen.getByText(/Emily is ready in Slack/)).toBeTruthy();
  });

  it("fires onContinue when the primary button is clicked", () => {
    const onContinue = vi.fn();
    render(<ClaimSuccessOverlay channel="whatsapp" onContinue={onContinue} />);
    fireEvent.click(screen.getByRole("button", { name: /go to dashboard/i }));
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it("has no emoji in the success copy (real iconography only)", () => {
    const { container } = render(
      <ClaimSuccessOverlay channel="whatsapp" onContinue={() => {}} />,
    );
    // No emoji-as-icon anywhere in the rendered text.
    expect(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(container.textContent || "")).toBe(false);
  });
});

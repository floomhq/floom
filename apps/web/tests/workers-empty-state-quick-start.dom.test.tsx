import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { WorkersEmptyQuickStart } from "@/app/workers/WorkersCollection";

describe("WorkersEmptyQuickStart copy interaction", () => {
  it("copies the exact onboarding prompt and confirms the copied state", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    render(<WorkersEmptyQuickStart />);
    fireEvent.click(screen.getByRole("button", { name: "Copy prompt" }));

    expect(writeText).toHaveBeenCalledWith(
      "Read https://floom.dev/onboard and walk me through setting up Floom.",
    );
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();
    });
  });

  it("handles clipboard rejection without entering the copied state", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("clipboard unavailable"));
    const errorToast = vi.spyOn(toast, "error").mockImplementation(() => "toast-id");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    render(<WorkersEmptyQuickStart />);
    fireEvent.click(screen.getByRole("button", { name: "Copy prompt" }));

    await waitFor(() => {
      expect(errorToast).toHaveBeenCalledWith("Could not copy prompt");
    });
    expect(screen.getByRole("button", { name: "Copy prompt" })).toBeInTheDocument();
  });
});

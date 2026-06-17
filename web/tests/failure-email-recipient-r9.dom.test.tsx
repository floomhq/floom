import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// jsdom lacks PointerEvent, which @base-ui Switch dispatches on click.
if (typeof (globalThis as { PointerEvent?: unknown }).PointerEvent === "undefined") {
  class PointerEventPolyfill extends MouseEvent {
    constructor(type: string, props: PointerEventInit = {}) {
      super(type, props);
    }
  }
  (globalThis as { PointerEvent?: unknown }).PointerEvent = PointerEventPolyfill;
}

// Round-09 trust fix (silent no-op #2): the "Email me on run failures" toggle
// (`failure_email_enabled`) is read + enforced by the backend, but the recipient
// it sends to (`failure_email_to`) had NO UI input — so enabling the toggle
// emailed nobody (recipients empty → run_notifications skips the send). This
// locks the recipient field UI + the "required when the toggle is on" contract.

const { getSettings, setSetting } = vi.hoisted(() => ({
  getSettings: vi.fn(),
  setSetting: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/settings",
}));
vi.mock("@/lib/api", () => ({ API_BASE: "/api/proxy", api: { workspace: { getSettings, setSetting } } }));

// sonner is used for the validation error surfaced to the operator.
const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: toastError },
}));

beforeEach(() => {
  vi.clearAllMocks();
  getSettings.mockResolvedValue({});
  setSetting.mockResolvedValue(null);
});

describe("Failure-email recipient (Round-09 silent no-op #2)", () => {
  it("renders the recipient input alongside the failure-email toggle", async () => {
    const { BehaviourSettings } = await import("@/app/settings/page");
    render(<BehaviourSettings />);
    await screen.findByText("Email me on run failures");
    expect(screen.getByLabelText(/failure.*recipient|notify.*email|send failure emails to/i)).toBeInTheDocument();
  });

  it("blocks enabling the toggle when no recipient is set (no silent no-op)", async () => {
    getSettings.mockResolvedValue({ failure_email_enabled: "false" });
    const { BehaviourSettings } = await import("@/app/settings/page");
    render(<BehaviourSettings />);
    await screen.findByText("Email me on run failures");

    // The failure-email toggle is the 3rd switch (approval, auto_pause, failure).
    const switches = screen.getAllByRole("switch");
    const failureToggle = switches[2];
    fireEvent.click(failureToggle);

    // Must NOT persist failure_email_enabled=true with an empty recipient.
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(setSetting).not.toHaveBeenCalledWith("failure_email_enabled", "true");
  });

  it("persists the recipient (failure_email_to) and then allows enabling", async () => {
    getSettings.mockResolvedValue({ failure_email_enabled: "false" });
    const { BehaviourSettings } = await import("@/app/settings/page");
    render(<BehaviourSettings />);
    await screen.findByText("Email me on run failures");

    const recipient = screen.getByLabelText(/failure.*recipient|notify.*email|send failure emails to/i) as HTMLInputElement;
    fireEvent.change(recipient, { target: { value: "ops@acme.com" } });
    fireEvent.blur(recipient);
    await waitFor(() => expect(setSetting).toHaveBeenCalledWith("failure_email_to", "ops@acme.com"));

    const switches = screen.getAllByRole("switch");
    fireEvent.click(switches[2]);
    await waitFor(() => expect(setSetting).toHaveBeenCalledWith("failure_email_enabled", "true"));
  });
});

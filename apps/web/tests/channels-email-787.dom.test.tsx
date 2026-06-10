import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

// #787/#799: there is no email channel yet. The Channels settings must show
// Email as a quiet "Not connected" card — never a fake "Connected" state.

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/settings",
}));

// The in-file binding widgets and SlackConnect hit the API on mount — stub the
// whole api surface so ChannelsTab renders deterministically.
vi.mock("@/lib/api", () => ({
  api: {
    slack: { installUrl: vi.fn().mockResolvedValue({ url: "#" }), bindingMe: vi.fn().mockResolvedValue(null) },
    whatsapp: { qr: vi.fn().mockResolvedValue({ url: "#" }), bindingMe: vi.fn().mockResolvedValue(null) },
  },
}));
vi.mock("@/components/assistant/SlackConnect", () => ({ SlackConnect: () => null }));

beforeEach(() => vi.clearAllMocks());

describe("Email channel (#787/#799)", () => {
  it("renders Email as Not connected, not Connected", async () => {
    const { ChannelsTab } = await import("@/app/settings/page");
    render(<ChannelsTab />);
    expect(await screen.findByText("Email")).toBeInTheDocument();
    expect(screen.getByText("Not connected")).toBeInTheDocument();
    // Never claim the email channel is live.
    expect(screen.queryByText(/Email.*Connected[^a-z]/)).toBeNull();
  });
});

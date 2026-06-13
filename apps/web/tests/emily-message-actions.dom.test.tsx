import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const messages = [
  { id: "u1", role: "user", text: "Please check yesterday's runs." },
  {
    id: "a1",
    role: "assistant",
    parts: [{ type: "text", text: "I found 3 completed runs." }],
  },
];

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("@/lib/useChatStream", () => ({
  getAutoOpenRunDetailsHref: vi.fn(),
  shouldAutoOpenRunDetails: vi.fn(() => false),
  useChatStream: () => ({
    messages,
    conversationId: "c1",
    isStreaming: false,
    isHydrating: false,
    error: null,
    sendMessage: vi.fn(),
    newSession: vi.fn(),
    loadConversation: vi.fn(),
  }),
}));

vi.mock("@/lib/api", () => ({
  api: {
    conversations: {
      list: vi.fn().mockResolvedValue([]),
    },
  },
}));

describe("Emily chat message actions", () => {
  it("copies user prompts and assistant answers", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const { EmilyChatPage } = await import("@/components/emily/EmilyChat");

    render(<EmilyChatPage />);

    const copyButtons = screen.getAllByRole("button", { name: "Copy" });
    expect(copyButtons).toHaveLength(2);

    await user.click(copyButtons[0]);
    expect(writeText).toHaveBeenCalledWith("Please check yesterday's runs.");

    await user.click(copyButtons[1]);
    expect(writeText).toHaveBeenCalledWith("I found 3 completed runs.");
  });
});

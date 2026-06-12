// #541 (M19) — the assistant surface presents Emily as a coworker, not a
// settings object: presence dot, a direct "Talk to Emily" action into chat,
// and conversational copy. (The conversational surface itself is the v4 /chat
// page + dock; /assistant remains where her configuration lives.)
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/assistant",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/lib/api", () => ({
  api: {
    system: {
      workspaceAgent: vi.fn().mockResolvedValue({
        model: "claude-opus-4-8",
        visibility: "workspace",
        permissions: { can_share: true },
      }),
      setAssistantVisibility: vi.fn(),
    },
    assistant: {
      getBase: vi.fn().mockResolvedValue({ content: "persona", is_custom: false }),
      getInstructions: vi.fn().mockResolvedValue({ content: "" }),
      getCompiled: vi.fn().mockResolvedValue({ content: "" }),
    },
    agent: {
      base: vi.fn().mockResolvedValue({ content: "persona", is_custom: false }),
    },
    me: vi.fn().mockResolvedValue({ user_id: "u1" }),
  },
}));

import AssistantPage from "@/app/assistant/page";

describe("#541 assistant coworker chrome", () => {
  it("shows Emily with presence and a Talk to Emily action into /chat", async () => {
    render(<AssistantPage />);
    await waitFor(() => expect(screen.getByText("Emily")).toBeInTheDocument());
    expect(screen.getByLabelText("Online")).toBeInTheDocument();
    const talk = screen.getByText("Talk to Emily").closest("a")!;
    expect(talk.getAttribute("href")).toBe("/chat");
    expect(screen.getByText(/just talk to her/i)).toBeInTheDocument();
  });
});

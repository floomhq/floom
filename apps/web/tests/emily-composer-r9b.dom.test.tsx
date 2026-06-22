// Round-09b (Federico 2026-06-17) — Emily composer fixes:
//   B15: typing must stay possible WHILE Emily streams a reply. Only the SEND
//        action is disabled during the stream; the textarea stays editable.
//   E10: the composer is a flat, borderless box with a discoverable bg-2 fill.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/chat",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const mod = await importOriginal<Record<string, unknown>>();
  return {
    ...mod,
    api: {
      ...(mod.api as Record<string, unknown>),
      contexts: { list: vi.fn().mockResolvedValue([]) },
      chat: { uploadAttachments: vi.fn().mockResolvedValue([]) },
      conversations: { list: vi.fn().mockResolvedValue([]) },
      system: { overview: vi.fn().mockResolvedValue({ stats: { active_workers_count: 1 } }) },
      workspace: { getSettings: vi.fn().mockResolvedValue({}) },
    },
  };
});

// Mutable streaming flag so each test can flip isStreaming.
const streamState = { isStreaming: false };
const sendMessage = vi.fn();
vi.mock("@/lib/useChatStream", async (importOriginal) => {
  const mod = await importOriginal<Record<string, unknown>>();
  return {
    ...mod,
    useChatStream: () => ({
      // One assistant + user message so the active-chat composer (not the empty
      // state) renders the bottom PromptInput we are testing.
      messages: [
        { id: "u1", role: "user", text: "hi" },
        { id: "a1", role: "assistant", parts: [{ type: "text", text: "thinking…", streaming: streamState.isStreaming }] },
      ],
      conversationId: "c1",
      isStreaming: streamState.isStreaming,
      isHydrating: false,
      error: null,
      sendMessage,
      newSession: vi.fn(),
      loadConversation: vi.fn(),
    }),
  };
});

import { EmilyChatPage } from "@/components/emily/EmilyChat";

describe("Emily composer — B15 type while streaming", () => {
  beforeEach(() => {
    sendMessage.mockClear();
  });

  it("textarea stays EDITABLE while Emily streams (only send is gated)", async () => {
    streamState.isStreaming = true;
    const user = userEvent.setup();
    render(<EmilyChatPage />);

    const composer = screen.getByPlaceholderText(/Message/i) as HTMLTextAreaElement;
    expect(composer.tagName).toBe("TEXTAREA");
    // The textarea is NOT disabled mid-stream — the user can draft their reply.
    expect(composer).not.toBeDisabled();

    await user.click(composer);
    await user.type(composer, "next question");
    expect(composer.value).toBe("next question");

    // Send action IS disabled while streaming.
    expect(screen.getByRole("button", { name: /send message/i })).toBeDisabled();

    // Enter does NOT send while streaming (keystrokes already landed above).
    await user.keyboard("{Enter}");
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("send re-enables and Enter sends once streaming completes", async () => {
    streamState.isStreaming = false;
    const user = userEvent.setup();
    render(<EmilyChatPage />);

    const composer = screen.getByPlaceholderText(/Message/i) as HTMLTextAreaElement;
    await user.click(composer);
    await user.type(composer, "ready now");
    expect(screen.getByRole("button", { name: /send message/i })).not.toBeDisabled();

    await user.keyboard("{Enter}");
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
});

describe("Emily composer - E10 flat box, no outline", () => {
  it("default composer uses the borderless bg-2 fill", () => {
    streamState.isStreaming = false;
    render(<EmilyChatPage />);
    const composer = screen.getByPlaceholderText(/Message/i);
    // The composer container is the textarea's parent flex row.
    const box = composer.parentElement as HTMLElement;
    expect(box).toBeTruthy();
    const cls = box.className;
    // Default composer is discoverable with a bg-2 fill, not an outline.
    expect(cls).toContain("bg-[var(--bg-2)]");
    expect(cls).not.toContain("[border:var(--bd-div)]");
  });
});

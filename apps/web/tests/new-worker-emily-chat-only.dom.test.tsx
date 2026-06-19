// Maintainer 2026-06-18: "The new worker should literally just be an Emily chat
// with some pills. It's literally an Emily chat. That's it. Don't make it
// anything more." This test pins the create-mode surface to that spec:
//   - heading "Hire a new worker" + one-line subtext
//   - 2-3 suggestion PILLS that prime the SAME Emily composer
//   - the "Your previous chat is still running — find it in Recent chats" note
//     when (and only when) a prior Emily chat id is persisted
//   - it IS the EmilyChat component (real PromptInput composer), not a bespoke
//     create-worker form (no "Hire worker" submit button, no example CARDS).
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CONVERSATION_STORAGE_KEY } from "@/lib/emily-chat-storage";

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
    },
  };
});

vi.mock("@/lib/useChatStream", async (importOriginal) => {
  const mod = await importOriginal<Record<string, unknown>>();
  return {
    ...mod,
    useChatStream: () => ({
      messages: [],
      conversationId: null,
      isStreaming: false,
      isHydrating: false,
      error: null,
      sendMessage: vi.fn(),
      newSession: vi.fn(),
      loadConversation: vi.fn(),
    }),
  };
});

import { EmilyChatPage } from "@/components/emily/EmilyChat";

const PILLS = [
  "Summarise my Granola meetings → HubSpot daily",
  "Send me a GitHub PR digest at 9am",
  "Score new CRM contacts against a job brief",
];

afterEach(() => {
  window.localStorage.clear();
});

describe("new worker = literally an Emily chat with pills", () => {
  it("shows the spec heading + one-line subtext", () => {
    render(<EmilyChatPage createMode />);
    expect(screen.getByRole("heading", { name: "Hire a new worker" })).toBeInTheDocument();
    expect(
      screen.getByText(/Describe the job in one sentence\./i),
    ).toBeInTheDocument();
  });

  it("renders the SAME Emily composer — not a bespoke form", () => {
    render(<EmilyChatPage createMode />);
    const composer = screen.getByPlaceholderText("Create me: a worker that…");
    // The real PromptInput is a <textarea>; the removed bespoke hero had a
    // "Hire worker" submit button + example cards instead.
    expect(composer.tagName).toBe("TEXTAREA");
    expect(screen.queryByRole("button", { name: /hire worker/i })).not.toBeInTheDocument();
  });

  it("renders the 2-3 suggestion pills (no example cards)", () => {
    render(<EmilyChatPage createMode />);
    for (const pill of PILLS) {
      expect(screen.getByRole("button", { name: pill })).toBeInTheDocument();
    }
    expect(screen.queryByText(/Or start from an example/i)).not.toBeInTheDocument();
  });

  it("clicking a pill primes the composer with that prompt", async () => {
    const user = userEvent.setup();
    render(<EmilyChatPage createMode />);
    const composer = screen.getByPlaceholderText("Create me: a worker that…") as HTMLTextAreaElement;
    expect(composer.value).toBe("");
    await user.click(screen.getByRole("button", { name: PILLS[0] }));
    expect(composer.value).toBe(PILLS[0]);
  });

  it("shows the previous-chat note ONLY when a prior Emily chat is persisted", async () => {
    window.localStorage.setItem(CONVERSATION_STORAGE_KEY, "conv-123");
    render(<EmilyChatPage createMode />);
    await waitFor(() =>
      expect(screen.getByText(/Your previous chat is still running/i)).toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: /find it in Recent chats/i })).toBeInTheDocument();
  });

  it("hides the previous-chat note when no prior chat exists", () => {
    render(<EmilyChatPage createMode />);
    expect(screen.queryByText(/Your previous chat is still running/i)).not.toBeInTheDocument();
  });
});

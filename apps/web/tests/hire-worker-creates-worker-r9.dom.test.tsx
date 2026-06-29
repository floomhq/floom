// Create-mode now sends plain chat. Emily no longer drafts or creates workers
// from natural-language prompts.
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/chat",
  useSearchParams: () => new URLSearchParams(),
}));

// EmilyHomeEmpty (now shown in create mode too) reads these hooks — stub them.
vi.mock("@/lib/query/hooks", () => ({
  useOverview: () => ({
    data: { stats: { work_shipped_7d: 7 }, outcomes: [], recent_runs: [], scheduled_today: [], needs_attention: [] },
    isError: false,
    isLoading: false,
  }),
  useWorkers: () => ({
    data: [{ id: "w1", archived: false, system: false, is_example: false }],
    isError: false,
    isLoading: false,
  }),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const mod = await importOriginal<Record<string, unknown>>();
  return {
    ...mod,
    api: {
      ...(mod.api as Record<string, unknown>),
      me: vi.fn().mockResolvedValue({ display_name: "Fede", email: "fede@floom.dev" }),
      contexts: { list: vi.fn().mockResolvedValue([]) },
      chat: { uploadAttachments: vi.fn().mockResolvedValue([]) },
    },
  };
});

const sendMessage = vi.fn();

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
      sendMessage,
      newSession: vi.fn(),
      loadConversation: vi.fn(),
    }),
  };
});

import { EmilyChatCore, EmilyChatPage } from "@/components/emily/EmilyChat";
import { buildCreateWorkerMessage } from "@/components/emily/EmilyChat";

const PLAIN_JOB = "Summarize a URL and email me the result.";

describe("Create-mode chat", () => {
  it("create-mode submit sends the bare prompt", async () => {
    sendMessage.mockClear();
    const user = userEvent.setup();
    render(<EmilyChatCore fullPage createMode />);

    const composer = await screen.findByPlaceholderText("Message Emily...");
    await user.click(composer);
    await user.type(composer, PLAIN_JOB);
    await user.keyboard("{Enter}");

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const sent = sendMessage.mock.calls[0][0] as string;
    expect(sent).toBe(PLAIN_JOB);
  });

  it("default (non-create) mode sends the message unchanged", async () => {
    sendMessage.mockClear();
    const user = userEvent.setup();
    render(<EmilyChatPage />);

    const composer = screen.getByPlaceholderText("Message Emily...");
    await user.type(composer, "What workers do I have?");
    await user.keyboard("{Enter}");

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0][0]).toBe("What workers do I have?");
  });

  it("buildCreateWorkerMessage preserves the prompt", () => {
    expect(buildCreateWorkerMessage(PLAIN_JOB)).toBe(PLAIN_JOB);
  });

  it("buildCreateWorkerMessage is idempotent", () => {
    const once = buildCreateWorkerMessage(PLAIN_JOB);
    const twice = buildCreateWorkerMessage(once);
    expect(twice).toBe(once);
  });
});

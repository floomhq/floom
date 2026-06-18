// Round-09 P0 #2 — the "Hire a worker" hero must actually start worker creation,
// not send a plain chat message that Emily may answer as a query (the live bug:
// typing a job description + "Hire worker" listed existing workers instead of
// drafting one).
//
// Fix: in create-mode, the hero submit wraps the user's job description in a
// deterministic worker-draft directive so the backend reliably routes it to the
// worker-authoring path (matches the engine's worker-authoring intent detector
// and explicitly instructs Emily to draft + create + open the editor).
import { describe, expect, it, vi } from "vitest";
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

import { EmilyChatPage } from "@/components/emily/EmilyChat";
import { buildCreateWorkerMessage } from "@/components/emily/EmilyChat";
import { WORKER_AUTHORING_INTENT_RE } from "@/lib/emily-create-intent";

const PLAIN_JOB = "Summarize a URL and email me the result.";

describe("Round-09 #2 — Hire worker drafts a worker (create intent)", () => {
  it("create-mode submit sends a worker-DRAFT directive, not the bare prompt", async () => {
    sendMessage.mockClear();
    const user = userEvent.setup();
    render(<EmilyChatPage createMode />);

    const composer = screen.getByPlaceholderText("Create me: a worker that…");
    await user.click(composer);
    // Round-09 (Emily-native create hero): the bespoke "Hire worker" button was
    // replaced by the real PromptInput composer — submit is Enter-to-send.
    await user.type(composer, PLAIN_JOB);
    await user.keyboard("{Enter}");

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const sent = sendMessage.mock.calls[0][0] as string;
    // The raw job description is preserved verbatim inside the directive...
    expect(sent).toContain(PLAIN_JOB);
    // ...but it is NOT sent as a bare chat message — it carries an explicit
    // create-worker directive so the backend routes it to worker authoring.
    expect(sent).not.toBe(PLAIN_JOB);
    // It must trip the engine's worker-authoring intent detector.
    expect(WORKER_AUTHORING_INTENT_RE.test(sent)).toBe(true);
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

  it("buildCreateWorkerMessage wraps a prompt into an authoring directive", () => {
    const wrapped = buildCreateWorkerMessage(PLAIN_JOB);
    expect(wrapped).toContain(PLAIN_JOB);
    expect(WORKER_AUTHORING_INTENT_RE.test(wrapped)).toBe(true);
  });

  it("buildCreateWorkerMessage is idempotent — never double-wraps", () => {
    const once = buildCreateWorkerMessage(PLAIN_JOB);
    const twice = buildCreateWorkerMessage(once);
    expect(twice).toBe(once);
  });
});

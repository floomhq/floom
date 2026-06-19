// Round-09 (Maintainer 2026-06-17) — Emily + creation real-component build.
//   1. Worker-creation hero reuses the REAL PromptInput composer (not a bespoke
//      textarea + "Hire worker" button) and Enter submits.
//   2. Emily dock full-screen exposes an explicit CLOSE control + a
//      make-fullscreen (expand) control in the right sidebar header.
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
      conversations: { list: vi.fn().mockResolvedValue([]) },
      system: { overview: vi.fn().mockResolvedValue({ stats: { active_workers_count: 1 } }) },
      workspace: { getSettings: vi.fn().mockResolvedValue({}) },
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

import { EmilyChatPage, EmilyDock } from "@/components/emily/EmilyChat";
import { EmilyFullscreenProvider } from "@/components/emily/emily-fullscreen";

describe("Emily creation flow — native composer", () => {
  it("create hero uses the real PromptInput (auto-resize TEXTAREA, not a form button)", () => {
    render(<EmilyChatPage createMode />);
    const composer = screen.getByPlaceholderText("Create me: a worker that…");
    // The real PromptInput is a <textarea>; the old hand-rolled hero used a
    // separate "Hire worker" submit button which we removed.
    expect(composer.tagName).toBe("TEXTAREA");
    expect(screen.queryByRole("button", { name: /hire worker/i })).not.toBeInTheDocument();
  });

  it("Enter submits the create prompt (no click required)", async () => {
    const user = userEvent.setup();
    sendMessage.mockClear();
    render(<EmilyChatPage createMode />);
    const composer = screen.getByPlaceholderText("Create me: a worker that…");
    await user.click(composer);
    await user.keyboard("Send a daily digest{Enter}");
    // Enter fires exactly one submit (no click required).
    expect(sendMessage).toHaveBeenCalledTimes(1);
    // Round-09 #2: the FIRST create-mode message is wrapped in an explicit
    // worker-authoring directive so the backend drafts a worker instead of
    // answering as a chat query. The raw prompt is preserved verbatim inside it.
    expect(sendMessage.mock.calls[0][0]).toContain("Send a daily digest");
    expect(sendMessage.mock.calls[0][0]).not.toBe("Send a daily digest");
  });
});

describe("Emily dock — full screen controls", () => {
  const renderDock = () =>
    render(
      <EmilyFullscreenProvider>
        <EmilyDock />
      </EmilyFullscreenProvider>,
    );

  it("rail header exposes a make-fullscreen (Expand) control in the right sidebar", () => {
    renderDock();
    expect(screen.getByRole("button", { name: /expand emily/i })).toBeInTheDocument();
    // Not in full screen yet → no Close-full-screen control.
    expect(screen.queryByRole("button", { name: /close full screen/i })).not.toBeInTheDocument();
  });

  it("ONE click enters true fullscreen and reveals an explicit Close control; one click exits", async () => {
    const user = userEvent.setup();
    renderDock();
    // Single click → fullscreen (no rail→wide→full multi-step). Round-09 r9:
    // the primary expand control is now TRUE one-click fullscreen.
    await user.click(screen.getByRole("button", { name: /expand emily/i }));
    const close = screen.getByRole("button", { name: /close full screen/i });
    expect(close).toBeInTheDocument();
    // Toggle now reads "Shrink Emily" while full.
    expect(screen.getByRole("button", { name: /shrink emily/i })).toBeInTheDocument();
    await user.click(close);
    // Back to rail → Close gone, Expand back.
    expect(screen.queryByRole("button", { name: /close full screen/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /expand emily/i })).toBeInTheDocument();
  });

  it("fullscreen makes the dock flex-grow to fill the main area (not a fixed-width rail, not a fixed overlay)", async () => {
    const user = userEvent.setup();
    const { container } = renderDock();
    const dock = () => container.querySelector('[aria-label^="Emily dock"]') as HTMLElement;
    // Rail: fixed width, not flex-grow, no full-screen overlay.
    expect(dock().className).toContain("shrink-0");
    expect(dock().className).not.toContain("flex-1");
    await user.click(screen.getByRole("button", { name: /expand emily/i }));
    // Fullscreen: flex-1 (fills main area) and NOT fixed inset overlay (which
    // would cover the left nav — the regression Maintainer flagged).
    expect(dock().getAttribute("aria-label")).toMatch(/fullscreen/i);
    expect(dock().className).toContain("flex-1");
    expect(dock().className).not.toContain("fixed");
    expect(dock().className).not.toContain("inset-0");
  });

  it("full screen renders the chat core with fullPage layout (fixes composer dead space)", async () => {
    const user = userEvent.setup();
    const { container } = renderDock();
    // Not full yet → no centered fullPage thread container.
    expect(container.querySelector(".max-w-2xl.mx-auto")).toBeNull();
    await user.click(screen.getByRole("button", { name: /expand emily/i }));
    // In full mode the core is rendered with fullPage → max-w-2xl mx-auto w-full
    // wrapper, so the thread takes proper height and the composer is anchored.
    expect(container.querySelector(".max-w-2xl.mx-auto.w-full")).not.toBeNull();
  });
});

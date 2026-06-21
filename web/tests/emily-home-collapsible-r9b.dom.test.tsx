// Round-09 batch2 (Federico 2026-06-18): the HOME fullscreen Emily must be
// COLLAPSIBLE. Proves:
//   1. On the home route, the fullscreen Emily header shows a visible
//      collapse/minimize control (it was previously gated off on home).
//   2. Clicking it exits fullscreen (docks Emily to the rail) and the collapse
//      STICKS — the auto-fullscreen effect does NOT snap it back.
//   3. When collapsed on home a Maximize/Expand control is shown, and clicking
//      it returns Emily to fullscreen.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

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
      contexts: { list: vi.fn().mockResolvedValue([]) },
      chat: { uploadAttachments: vi.fn().mockResolvedValue([]) },
      conversations: { list: vi.fn().mockResolvedValue([]) },
      system: { overview: vi.fn().mockResolvedValue({ stats: { active_workers_count: 1 } }) },
      workspace: { getSettings: vi.fn().mockResolvedValue({}) },
    },
  };
});

import { EmilyDock } from "@/components/emily/EmilyChat";
import { EmilyFullscreenProvider } from "@/components/emily/emily-fullscreen";

const renderDock = () =>
  render(
    <EmilyFullscreenProvider>
      <EmilyDock />
    </EmilyFullscreenProvider>,
  );

describe("HOME fullscreen Emily is collapsible", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    );
  });

  it("shows a collapse control on the home fullscreen Emily; collapsing sticks (no snap-back), maximize returns", async () => {
    const user = userEvent.setup();
    const { container } = renderDock();

    const dock = () => container.querySelector('[aria-label^="Emily dock"]') as HTMLElement;
    // Home starts fullscreen.
    expect(await screen.findByLabelText(/emily dock \(fullscreen\)/i)).toBeInTheDocument();

    // A visible collapse control exists on home (was gated off before). The
    // full-screen toggle reads exactly "Exit full screen" while full (no longer
    // the ambiguous "Minimize Emily") so the affordance is unmistakable.
    const minimize = screen.getByRole("button", { name: /^exit full screen$/i });
    await user.click(minimize);

    // Collapse STICKS: dock is no longer fullscreen (back to a fixed-width rail).
    expect(dock().getAttribute("aria-label")).not.toMatch(/fullscreen/i);
    expect(dock().className).toContain("shrink-0");

    // The full-screen control now reads "Full screen"; clicking it returns to fullscreen.
    const expand = screen.getByRole("button", { name: /^full screen$/i });
    await user.click(expand);
    expect(dock().getAttribute("aria-label")).toMatch(/fullscreen/i);
  });
});

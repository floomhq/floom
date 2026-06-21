// P0 regression (Federico 2026-06-19): the home auto-fullscreen latched on across
// navigation. `fullscreen` is a route-unaware useState; the auto-fullscreen effect
// forced it true on home but had NO branch to exit when LEAVING home, so AppShell
// (emilyFull = fullscreen && isDesktop) hid <main> on EVERY route → Emily covered
// the page on Workers/Library/Runs/etc.
//
// This proves the fix: on the home → non-home TRANSITION the EmilyDock exits
// fullscreen (dock aria-label switches from the fullscreen variant to the rail
// variant), so the destination page pane is revealed instead of being hidden.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

const { pathname } = vi.hoisted(() => ({ pathname: vi.fn(() => "/") }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), refresh: vi.fn() }),
  usePathname: () => pathname(),
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
  useOverview: () => ({ data: { stats: { work_shipped_7d: 0 }, outcomes: [], recent_runs: [], scheduled_today: [], needs_attention: [] }, isError: false, isLoading: false }),
  useWorkers: () => ({ data: [], isError: false, isLoading: false }),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const mod = await importOriginal<Record<string, unknown>>();
  return {
    ...mod,
    api: {
      ...(mod.api as Record<string, unknown>),
      me: vi.fn().mockResolvedValue({ display_name: "Local user", email: "local@example.com" }),
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

describe("Emily fullscreen is route-scoped to home (P0)", () => {
  beforeEach(() => {
    pathname.mockReturnValue("/");
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    );
  });

  it("docks Emily out of fullscreen when navigating home → non-home (reveals the page pane)", async () => {
    const { rerender } = render(
      <EmilyFullscreenProvider>
        <EmilyDock />
      </EmilyFullscreenProvider>,
    );

    // On home → fullscreen (Emily fills the main area).
    expect(await screen.findByLabelText(/emily dock \(fullscreen\)/i)).toBeInTheDocument();

    // Navigate away from home (e.g. to /workers).
    pathname.mockReturnValue("/workers");
    rerender(
      <EmilyFullscreenProvider>
        <EmilyDock />
      </EmilyFullscreenProvider>,
    );

    // Fullscreen is reset → dock returns to the rail, so AppShell stops hiding
    // <main> and the Workers list is visible. No fullscreen dock remains.
    expect(await screen.findByLabelText(/emily dock \(rail\)/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/emily dock \(fullscreen\)/i)).not.toBeInTheDocument();
  });
});

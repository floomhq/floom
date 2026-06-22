// FIX2: when Emily is in fullscreen on a NON-home route (manually maximized) and
// the user navigates to ANOTHER non-home route, the fullscreen must auto-collapse
// so the destination page is revealed (AppShell hides <main> while Emily is
// fullscreen). The home→* and *→home transitions are covered by
// emily-fullscreen-route-scope; this proves the non-home→non-home gap.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";

const { pathname } = vi.hoisted(() => ({ pathname: vi.fn(() => "/workers") }));

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
  useOverview: () => ({ data: { stats: {}, outcomes: [], recent_runs: [], scheduled_today: [], needs_attention: [] }, isError: false, isLoading: false }),
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
import { EmilyFullscreenProvider, useEmilyFullscreen } from "@/components/emily/emily-fullscreen";

// Tiny harness button to MANUALLY open fullscreen (simulating the dock's
// maximize control) on a non-home route — the scenario the fix targets.
function OpenFullscreen() {
  const { setFullscreen } = useEmilyFullscreen();
  return (
    <button type="button" onClick={() => setFullscreen(true)}>
      force-full
    </button>
  );
}

describe("Emily fullscreen auto-collapses on non-home navigation (FIX2)", () => {
  beforeEach(() => {
    pathname.mockReturnValue("/workers");
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    );
  });

  it("docks Emily out of fullscreen when navigating between two non-home routes", async () => {
    const user = (await import("@testing-library/user-event")).default.setup();
    const { rerender } = render(
      <EmilyFullscreenProvider>
        <OpenFullscreen />
        <EmilyDock />
      </EmilyFullscreenProvider>,
    );

    // Manually maximize Emily on /workers.
    await user.click(screen.getByText("force-full"));
    expect(await screen.findByLabelText(/emily dock \(fullscreen\)/i)).toBeInTheDocument();

    // Navigate /workers → /runs (a real non-home → non-home navigation).
    await act(async () => {
      pathname.mockReturnValue("/runs");
      rerender(
        <EmilyFullscreenProvider>
          <OpenFullscreen />
          <EmilyDock />
        </EmilyFullscreenProvider>,
      );
    });

    // Fullscreen is dropped → the destination page (Runs) is revealed.
    expect(await screen.findByLabelText(/emily dock \(rail\)/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/emily dock \(fullscreen\)/i)).not.toBeInTheDocument();
  });
});

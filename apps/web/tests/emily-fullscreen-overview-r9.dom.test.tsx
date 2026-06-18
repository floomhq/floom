// Round-09 r9 (Federico 2026-06-17) — proves the BEHAVIOR, not just presence:
//   1. Emily TRUE fullscreen: clicking the make-fullscreen control hides the
//      page pane (<main>) so Emily fills the main content area, while the left
//      sidebar stays mounted. Clicking close restores the page pane. Verified at
//      the AppShell level where the page pane and the dock are sibling flex
//      children — the layer the earlier "verified the control exists" passes
//      never actually exercised.
//   2. Overview content column no longer hard-caps at 640px (the dead-gap cause)
//      — it fills the pane up to a wider sensible cap.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { pathname } = vi.hoisted(() => ({ pathname: vi.fn(() => "/overview") }));

vi.mock("next/navigation", () => ({
  usePathname: () => pathname(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/components/layout/sidebar", () => ({
  Sidebar: () => <aside data-testid="app-sidebar">nav</aside>,
  FloomMark: () => null,
}));

// Stub EmilyDock with a control that drives the REAL fullscreen context, so the
// AppShell page-pane-hiding behavior is exercised end-to-end.
vi.mock("@/components/emily/EmilyChat", async () => {
  const { useEmilyFullscreen } = await import("@/components/emily/emily-fullscreen");
  function FakeDock() {
    const { fullscreen, setFullscreen } = useEmilyFullscreen();
    return (
      <div data-testid="emily-dock">
        <button onClick={() => setFullscreen(!fullscreen)}>
          {fullscreen ? "exit emily fullscreen" : "enter emily fullscreen"}
        </button>
      </div>
    );
  }
  return { EmilyDock: FakeDock, EmilyMobileSheet: () => null };
});

vi.mock("@/components/overview/AlertsBell", () => ({ AlertsBell: () => null }));
vi.mock("@/components/CommandPalette", () => ({ CommandPalette: () => null }));
vi.mock("@/components/Ambient", () => ({ Ambient: () => null }));
vi.mock("@/components/IconSprite", () => ({ IconSprite: () => null }));
vi.mock("@/components/layout/DeepLinkRouter", () => ({ DeepLinkRouter: () => null }));
vi.mock("@/components/ui/sonner", () => ({ Toaster: () => null }));

function findPagePane(container: HTMLElement): HTMLElement {
  // The page pane is the <main> that wraps the route children. Identify it by
  // the page content it renders.
  const main = Array.from(container.querySelectorAll("main")).find((m) =>
    m.textContent?.includes("PAGE CONTENT"),
  );
  if (!main) throw new Error("page pane <main> not found");
  return main as HTMLElement;
}

describe("Emily fullscreen — AppShell hides the page pane, keeps the sidebar", () => {
  beforeEach(() => {
    pathname.mockReturnValue("/overview");
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    );
  });

  it("hides the page pane and keeps the sidebar when Emily goes fullscreen, restores on close", async () => {
    const user = userEvent.setup();
    const { AppShell } = await import("@/components/layout/AppShell");
    const { container } = render(
      <AppShell>
        <div>PAGE CONTENT</div>
      </AppShell>,
    );

    // Before: page pane visible (not hidden), sidebar present.
    expect(findPagePane(container).className).not.toContain("hidden");
    expect(screen.getByTestId("app-sidebar")).toBeInTheDocument();

    // Enter fullscreen.
    await user.click(screen.getByRole("button", { name: /enter emily fullscreen/i }));
    // Page pane is now hidden (display:none, still mounted) — Emily fills the area.
    expect(findPagePane(container).className).toContain("hidden");
    // Sidebar STAYS visible (Federico spec: keep nav).
    expect(screen.getByTestId("app-sidebar")).toBeInTheDocument();

    // Exit fullscreen → page pane restored.
    await user.click(screen.getByRole("button", { name: /exit emily fullscreen/i }));
    expect(findPagePane(container).className).not.toContain("hidden");
  });
});

describe("Overview — content column fills the container (no dead 640px cap)", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    );
  });

  it("the overview content column is not hard-capped at the narrow 640px width", async () => {
    // Drive the real component with seeded data so it renders the brief layout.
    vi.doMock("@/lib/query/hooks", () => ({
      useOverview: () => ({
        data: {
          stats: {
            work_shipped_7d: 12,
            work_shipped_previous_7d: 8,
            success_rate_7d: 0.9,
            runs_today: 3,
            active_workers_count: 2,
            paused_workers_count: 0,
          },
          needs_attention: [],
          recent_runs: [],
          outcomes: [],
        },
        isLoading: false,
        refetch: vi.fn(),
      }),
    }));
    vi.doMock("@/lib/api", () => ({
      api: { me: vi.fn().mockResolvedValue({ display_name: "Fede", email: "fede@floom.dev" }) },
    }));
    const { OverviewDashboard } = await import("@/components/overview/OverviewDashboard");
    const { container } = render(<OverviewDashboard />);

    // The greeting/stats/lists column must NOT carry the old narrow 640px cap.
    expect(container.querySelector(".max-w-\\[640px\\]")).toBeNull();
    // It should carry the widened cap so it fills the pane.
    expect(container.querySelector(".max-w-\\[920px\\]")).not.toBeNull();
  });
});

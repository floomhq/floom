// Cloud parallel of engine emily-fullscreen-overview-r9.dom.test.tsx
// (Federico 2026-06-17). The cloud dashboard renders its OWN overlay chrome
// (CloudAppChrome), not the engine AppShell. This proves the BEHAVIOR at the
// cloud-chrome layer: clicking the Emily make-fullscreen control hides the page
// pane (<main display:none>) so the dock fills the main area, while the left
// sidebar stays mounted; closing restores the pane. Without the
// EmilyFullscreenProvider wrap + emilyFull hide that this test guards, the
// expand control was inert on workeros.floom.dev/app.
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

// Stub EmilyDock with a control that drives the REAL shared fullscreen context,
// so CloudAppChrome's page-pane-hiding behavior is exercised end-to-end (the
// same shared context the production EmilyDock consumes).
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

vi.mock("@/components/CommandPalette", () => ({ CommandPalette: () => null }));
vi.mock("@/components/Ambient", () => ({ Ambient: () => null }));
vi.mock("@/components/IconSprite", () => ({ IconSprite: () => null }));
vi.mock("@/components/ui/sonner", () => ({ Toaster: () => null }));
vi.mock("@/components/TelemetryProvider", () => ({ TelemetryProvider: () => null }));
vi.mock("@/components/CloudAccountFooter", () => ({ CloudAccountFooter: () => null }));

function findPagePane(container: HTMLElement): HTMLElement {
  const main = Array.from(container.querySelectorAll("main")).find((m) =>
    m.textContent?.includes("PAGE CONTENT"),
  );
  if (!main) throw new Error("page pane <main> not found");
  return main as HTMLElement;
}

describe("CloudAppChrome — Emily fullscreen hides the page pane, keeps the sidebar", () => {
  beforeEach(() => {
    pathname.mockReturnValue("/overview");
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    );
  });

  it("hides <main> and keeps the sidebar on fullscreen, restores on close", async () => {
    const user = userEvent.setup();
    const { CloudAppChrome } = await import("@/components/CloudAppChrome");
    const { container } = render(
      <CloudAppChrome>
        <div>PAGE CONTENT</div>
      </CloudAppChrome>,
    );

    // Before: page pane visible, sidebar present.
    expect(findPagePane(container).className).not.toContain("hidden");
    expect(screen.getByTestId("app-sidebar")).toBeInTheDocument();

    // Enter fullscreen → page pane hidden (display:none, still mounted).
    await user.click(screen.getByRole("button", { name: /enter emily fullscreen/i }));
    expect(findPagePane(container).className).toContain("hidden");
    // Sidebar STAYS (Federico spec: keep nav).
    expect(screen.getByTestId("app-sidebar")).toBeInTheDocument();

    // Exit fullscreen → page pane restored.
    await user.click(screen.getByRole("button", { name: /exit emily fullscreen/i }));
    expect(findPagePane(container).className).not.toContain("hidden");
  });
});

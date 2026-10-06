import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";

const { pathname } = vi.hoisted(() => ({ pathname: vi.fn(() => "/runs/run_123") }));

vi.mock("next/navigation", () => ({
  usePathname: () => pathname(),
}));

vi.mock("@/components/layout/sidebar", () => ({
  Sidebar: () => <aside>navigation</aside>,
  FloomMark: () => null,
}));

vi.mock("@/components/emily/EmilyChat", () => ({
  EmilyDock: () => null,
  EmilyMobileSheet: () => null,
}));

vi.mock("@/components/CommandPalette", () => ({ CommandPalette: () => null }));
vi.mock("@/components/Ambient", () => ({ Ambient: () => null }));
vi.mock("@/components/IconSprite", () => ({ IconSprite: () => null }));
vi.mock("@/components/layout/DeepLinkRouter", () => ({ DeepLinkRouter: () => null }));
vi.mock("@/components/layout/BootSplash", () => ({ BootSplash: () => null }));
vi.mock("@/components/ui/sonner", () => ({ Toaster: () => null }));
vi.mock("@/components/TermsAcceptanceGate", () => ({ TermsAcceptanceGate: () => null }));

function renderShell() {
  return import("@/components/layout/AppShell").then(({ AppShell }) => render(
    <AppShell>
      <div data-testid="route-content">route content</div>
    </AppShell>,
  ));
}

describe("AppShell run detail layout", () => {
  beforeEach(() => {
    pathname.mockReturnValue("/runs/run_123");
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
  });

  it("renders /runs/[id] in the padded, vertically scrollable standard pane", async () => {
    const { container, getByTestId } = await renderShell();
    const main = container.querySelector("main");
    const wrapper = getByTestId("route-content").parentElement;

    expect(main).not.toBeNull();
    expect(main?.className).toContain("overflow-y-auto");
    expect(main?.className).not.toContain("overflow-hidden");
    expect(wrapper?.className).toContain("max-w-7xl");
    expect(wrapper?.className).toContain("px-4");
    expect(wrapper?.className).toContain("sm:px-6");
    expect(wrapper?.className).toContain("py-6");
    expect(wrapper?.className).toContain("sm:py-8");
  });

  it.each(["/runs", "/runs/"])("keeps the %s collection full-bleed", async (path) => {
    pathname.mockReturnValue(path);
    const { container, getByTestId } = await renderShell();
    const main = container.querySelector("main");

    expect(main?.className).toContain("overflow-hidden");
    expect(main?.className).not.toContain("overflow-y-auto");
    expect(getByTestId("route-content").parentElement).toBe(main);
  });

  it("keeps the standalone /run/[id] share route outside authenticated chrome", async () => {
    pathname.mockReturnValue("/run/run_123");
    const { container, getByTestId } = await renderShell();
    const main = container.querySelector("main");

    expect(main?.className).toContain("overflow-y-auto");
    expect(getByTestId("route-content").parentElement).toBe(main);
    expect(container.querySelector("aside")).toBeNull();
  });
});

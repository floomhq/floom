import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const { pathname } = vi.hoisted(() => ({ pathname: vi.fn(() => "/login") }));

vi.mock("next/navigation", () => ({
  usePathname: () => pathname(),
}));

vi.mock("@/components/layout/sidebar", () => ({
  Sidebar: () => <aside>authed user identity</aside>,
  // Merged tree: AppShell renders <BootSplash/> (base-engine feature) which
  // consumes FloomMark from this module. Provide it so the full-module mock
  // doesn't strip the export. (round-09 reconciliation: main test + base BootSplash.)
  FloomMark: () => null,
}));

vi.mock("@/components/emily/EmilyChat", () => ({
  EmilyDock: () => null,
  EmilyMobileSheet: () => null,
}));

vi.mock("@/components/overview/AlertsBell", () => ({
  AlertsBell: () => null,
}));

vi.mock("@/components/CommandPalette", () => ({
  CommandPalette: () => null,
}));

vi.mock("@/components/Ambient", () => ({
  Ambient: () => null,
}));

vi.mock("@/components/IconSprite", () => ({
  IconSprite: () => null,
}));

vi.mock("@/components/layout/DeepLinkRouter", () => ({
  DeepLinkRouter: () => null,
}));

vi.mock("@/components/ui/sonner", () => ({
  Toaster: () => null,
}));

describe("AppShell login chrome isolation (#1408)", () => {
  beforeEach(() => {
    pathname.mockReturnValue("/login");
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })));
  });

  it("does not render authenticated identity chrome on /login", async () => {
    const { AppShell } = await import("@/components/layout/AppShell");
    render(<AppShell><div>Login form</div></AppShell>);

    expect(screen.getByText("Login form")).toBeInTheDocument();
    expect(screen.queryByText("authed user identity")).not.toBeInTheDocument();
  });

  it("still renders the sidebar identity chrome on authenticated app routes", async () => {
    pathname.mockReturnValue("/overview");
    const { AppShell } = await import("@/components/layout/AppShell");
    render(<AppShell><div>Overview</div></AppShell>);

    expect(screen.getByText("Overview")).toBeInTheDocument();
    expect(screen.getByText("authed user identity")).toBeInTheDocument();
  });
});

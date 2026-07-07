import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";

// #1717: the standalone shell (e.g. /approvals/review) renders inside the
// `h-screen overflow-hidden` <body>, so it MUST own its own vertical scroll
// container. Without it, a multi-item proposed-output review grew past the fold
// with nothing able to scroll to it: later items were clipped and unreachable.

const { pathname } = vi.hoisted(() => ({ pathname: vi.fn(() => "/approvals/review") }));

vi.mock("next/navigation", () => ({
  usePathname: () => pathname(),
}));

vi.mock("@/components/layout/sidebar", () => ({
  Sidebar: () => <aside>authed user identity</aside>,
  FloomMark: () => null,
}));

vi.mock("@/components/emily/EmilyChat", () => ({
  EmilyDock: () => null,
  EmilyMobileSheet: () => null,
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

vi.mock("@/components/TermsAcceptanceGate", () => ({
  TermsAcceptanceGate: () => <div>Terms gate overlay</div>,
}));

describe("AppShell standalone scroll container (#1717)", () => {
  beforeEach(() => {
    pathname.mockReturnValue("/approvals/review");
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })));
  });

  it("renders the standalone review page inside an overflow-y-auto scroll pane", async () => {
    const { AppShell } = await import("@/components/layout/AppShell");
    const { container } = render(
      <AppShell>
        <div>Approval review content</div>
      </AppShell>,
    );

    const main = container.querySelector("main");
    expect(main).not.toBeNull();
    // The pane must scroll vertically; clipping (overflow-hidden) or a non-
    // scrolling min-h-screen pane regresses #1717.
    expect(main?.className).toContain("overflow-y-auto");
    expect(main?.className).not.toContain("overflow-hidden");
  });

  it("does not render the sidebar chrome on the standalone review page", async () => {
    const { AppShell } = await import("@/components/layout/AppShell");
    const { queryByText } = render(
      <AppShell>
        <div>Approval review content</div>
      </AppShell>,
    );

    expect(queryByText("authed user identity")).not.toBeInTheDocument();
  });

  it("renders legal review pages without authenticated chrome or the terms gate", async () => {
    pathname.mockReturnValue("/terms");

    const { AppShell } = await import("@/components/layout/AppShell");
    const { queryByText } = render(
      <AppShell>
        <div>Terms page content</div>
      </AppShell>,
    );

    expect(queryByText("Terms page content")).toBeInTheDocument();
    expect(queryByText("Terms gate overlay")).not.toBeInTheDocument();
    expect(queryByText("authed user identity")).not.toBeInTheDocument();
  });

  // Regression: #2211 shipped the /@{handle}/{workerSlug} L4 worker permalink
  // page but never taught AppShell about the two-segment shape, so it fell
  // through to the default (non-standalone) branch and double-mounted the
  // full authenticated shell (Sidebar/EmilyDock/CommandPalette/
  // TermsAcceptanceGate) around the permalink page's own bare <ShareNav> —
  // the confirmed root cause of a client-side $exception on real permalink
  // loads (PostHog: systemic across 2+ accounts, 5 slugs, 48h).
  it("renders worker permalink pages standalone, without authenticated chrome or the terms gate", async () => {
    pathname.mockReturnValue("/@openpaper/construction-intel-weekly");

    const { AppShell } = await import("@/components/layout/AppShell");
    const { queryByText } = render(
      <AppShell>
        <div>Permalink share card content</div>
      </AppShell>,
    );

    expect(queryByText("Permalink share card content")).toBeInTheDocument();
    expect(queryByText("Terms gate overlay")).not.toBeInTheDocument();
    expect(queryByText("authed user identity")).not.toBeInTheDocument();
  });
});

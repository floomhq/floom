import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// §5c / #817: channel-first onboarding offers Slack/WhatsApp/dashboard, routing
// to the install flows.

vi.mock("@/components/layout/sidebar", () => ({ FloomMark: () => null }));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));

describe("Onboarding /start (#817)", () => {
  it("offers channel-first options routing to the install flows", async () => {
    const { default: StartPage } = await import("@/app/start/page");
    render(<StartPage />);

    expect(screen.getByText("Start in Slack").closest("a")).toHaveAttribute("href", "/login?install=slack");
    expect(screen.getByText("Start in WhatsApp").closest("a")).toHaveAttribute("href", "/login?install=whatsapp");
    expect(screen.getByText("Use the dashboard").closest("a")).toHaveAttribute("href", "/login");
  });
});

import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, afterEach } from "vitest";

vi.mock("@/components/layout/sidebar", () => ({ FloomMark: () => null }));

describe("branded not-found page", () => {
  afterEach(() => vi.restoreAllMocks());

  // R9: not-found page is auth-aware — it probes /api/me to pick the right CTA.
  // Authenticated (or loading) → "Go to app"; unauthenticated → "Back to Overview" + "Sign in".

  it("renders Floom copy, heading and description regardless of auth state", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    const { default: NotFound } = await import("@/app/not-found");
    render(<NotFound />);

    expect(screen.getByRole("heading", { name: "Page not found" })).toBeInTheDocument();
    expect(screen.getByText("Floom")).toBeInTheDocument();
    expect(screen.getByText(/This page does not exist/)).toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it("shows 'Go to app' link when authenticated (/api/me ok)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    vi.resetModules();
    const { default: NotFound } = await import("@/app/not-found");
    render(<NotFound />);

    // After fetch resolves to ok=true, authed flips to true → "Go to app"
    await waitFor(() =>
      expect(screen.getByRole("link", { name: /Go to app/i })).toHaveAttribute("href", "/overview")
    );
    expect(screen.queryByRole("link", { name: "Sign in" })).toBeNull();
    vi.unstubAllGlobals();
  });

  it("shows 'Back to Overview' and 'Sign in' when unauthenticated (/api/me fails)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    vi.resetModules();
    const { default: NotFound } = await import("@/app/not-found");
    render(<NotFound />);

    await waitFor(() =>
      expect(screen.getByRole("link", { name: /Back to Overview/i })).toHaveAttribute("href", "/overview")
    );
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/login");
    vi.unstubAllGlobals();
  });
});

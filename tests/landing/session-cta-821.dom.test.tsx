// #821 — landing nav CTA is session-aware: "Sign in" by default, "Dashboard"
// when /api/session reports an authenticated visitor.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { V3Shell } from "@/app/v3/V3Shell";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function mockSession(authed: boolean) {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ authed }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
}

describe("session-aware CTA (#821)", () => {
  it("shows Sign in → /login for anonymous visitors", async () => {
    mockSession(false);
    render(<V3Shell>x</V3Shell>);
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    const cta = screen.getByText("Sign in").closest("a")!;
    expect(cta.getAttribute("href")).toBe("/login");
    expect(screen.queryByText("Dashboard")).toBeNull();
  });

  it("swaps to Dashboard → /app/overview when a session exists", async () => {
    mockSession(true);
    render(<V3Shell>x</V3Shell>);
    const cta = await screen.findByText("Dashboard");
    expect(cta.closest("a")!.getAttribute("href")).toBe("/app/overview");
    expect(screen.queryByText("Sign in")).toBeNull();
  });

  it("stays on Sign in when the session check fails", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    render(<V3Shell>x</V3Shell>);
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    expect(screen.getByText("Sign in")).toBeTruthy();
  });
});

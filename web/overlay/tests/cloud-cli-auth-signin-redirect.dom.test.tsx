import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CliAuthContent } from "@/app/cli-auth/page";

describe("cloud CLI auth sign-in redirect", () => {
  beforeEach(() => {
    window.history.pushState({}, "", "/cli-auth?code=ABCD-2345");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("routes logged-out approval pages to sign-in before approval", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        headers: { get: () => "application/json" },
        json: async () => ({ user: null }),
      }),
    );
    const assign = vi.fn();
    Object.defineProperty(window, "location", {
      value: { ...window.location, assign },
      writable: true,
    });

    render(<CliAuthContent loginPath="/app/login" sessionCheckPath="/app/api/me" />);

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith("/app/api/me", {
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      expect(assign).toHaveBeenCalledWith("/app/login?next=%2Fcli-auth%3Fcode%3DABCD-2345");
    });
  });

  it("routes HTML approval responses to sign-in instead of dead-ending", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        headers: { get: () => "text/html" },
        json: async () => ({}),
      }),
    );
    const assign = vi.fn();
    Object.defineProperty(window, "location", {
      value: { ...window.location, assign },
      writable: true,
    });

    render(<CliAuthContent loginPath="/app/login" />);
    fireEvent.click(await screen.findByRole("button", { name: "Approve & connect" }));

    await waitFor(() => {
      expect(assign).toHaveBeenCalledWith("/app/login?next=%2Fcli-auth%3Fcode%3DABCD-2345");
    });
  });
});

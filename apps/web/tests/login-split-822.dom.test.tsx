import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

// §5a2 (#822): the sign-in page is split — brand/value prop + form.

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/components/layout/sidebar", () => ({ FloomMark: () => null }));

describe("Sign-in split page (§5a2 / #822)", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ required: false }),
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("renders the light brand panel and the form without fabricated stats", async () => {
    const { default: LoginPage } = await import("@/app/login/page");
    render(<LoginPage />);

    expect(await screen.findByText("Hire AI workers for your company.")).toBeInTheDocument();
    expect(screen.getByText(/Jobs that run themselves/)).toBeInTheDocument();
    expect(screen.queryByText("This week")).not.toBeInTheDocument();
    expect(screen.queryByText("142")).not.toBeInTheDocument();
    expect(screen.queryByText("Weekly sales summary")).not.toBeInTheDocument();

    expect(await screen.findByLabelText("Username")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("username")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Sign in" })).toBeInTheDocument();
  });

  it("shows 'Sign in with admin secret' toggle when in username mode", async () => {
    const { default: LoginPage } = await import("@/app/login/page");
    render(<LoginPage />);

    // Wait for auto-detect to resolve to username mode.
    const toggle = await screen.findByRole("button", { name: "Sign in with admin secret" });
    expect(toggle).toBeInTheDocument();
  });

  it("switches to secret form on toggle click and back on second click", async () => {
    const { default: LoginPage } = await import("@/app/login/page");
    render(<LoginPage />);

    // Initially in username mode: username field visible, no secret field.
    await screen.findByLabelText("Username");
    expect(screen.queryByLabelText("Access secret")).not.toBeInTheDocument();

    // Click toggle → secret mode.
    const toggle = await screen.findByRole("button", { name: "Sign in with admin secret" });
    fireEvent.click(toggle);

    expect(await screen.findByLabelText("Access secret")).toBeInTheDocument();
    expect(screen.queryByLabelText("Username")).not.toBeInTheDocument();

    // Toggle label flips.
    expect(screen.getByRole("button", { name: "Back to username sign-in" })).toBeInTheDocument();

    // Click again → back to username mode.
    fireEvent.click(screen.getByRole("button", { name: "Back to username sign-in" }));
    expect(await screen.findByLabelText("Username")).toBeInTheDocument();
    expect(screen.queryByLabelText("Access secret")).not.toBeInTheDocument();
  });

  it("does not show the toggle when auto-detected mode is already secret", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("unreachable")));
    const { default: LoginPage } = await import("@/app/login/page");
    render(<LoginPage />);

    // In pure-secret mode the escape hatch is not needed and must not appear.
    await screen.findByLabelText("Access secret");
    expect(screen.queryByRole("button", { name: "Sign in with admin secret" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Back to username sign-in" })).not.toBeInTheDocument();
  });
});

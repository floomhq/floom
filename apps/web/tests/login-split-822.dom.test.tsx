import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";

// §5a2 (#822): the sign-in page is split — dark product-proof panel + form.

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

  it("renders the product-proof panel and the form", async () => {
    const { default: LoginPage } = await import("@/app/login/page");
    render(<LoginPage />);

    // Proof panel content (the "show what they get" half).
    expect(await screen.findByText("Hire AI workers.")).toBeInTheDocument();
    expect(screen.getByText("This week")).toBeInTheDocument();
    expect(screen.getByText("Your first sign-in creates your workspace.")).toBeInTheDocument();

    // The real form (username mode after the setup check).
    expect(await screen.findByLabelText("Username")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Sign in" })).toBeInTheDocument();
  });
});

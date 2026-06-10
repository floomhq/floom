import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// #784: the Rotate control issues a new secret via api.tokens.rotate and
// surfaces the new token once.

const { list, rotate, revoke, create } = vi.hoisted(() => ({
  list: vi.fn(),
  rotate: vi.fn(),
  revoke: vi.fn(),
  create: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/settings",
}));
vi.mock("@/lib/api", () => ({ api: { tokens: { list, rotate, revoke, create } } }));

beforeEach(() => {
  vi.clearAllMocks();
  list.mockResolvedValue([
    { id: "tok-1", name: "ci-token", last_used_at: null, created_at: "2026-01-01", expires_at: null },
  ]);
  rotate.mockResolvedValue({ token: "wos_NEWSECRET", pat: { id: "tok-1", name: "ci-token" } });
});

describe("PAT rotate (#784)", () => {
  it("rotates the token and reveals the new secret", async () => {
    const { PersonalAccessTokensPanel } = await import("@/app/settings/page");
    render(<PersonalAccessTokensPanel />);

    const rotateBtn = await screen.findByLabelText("Rotate ci-token");
    fireEvent.click(rotateBtn);

    await waitFor(() => expect(rotate).toHaveBeenCalledWith("tok-1"));
    expect(await screen.findByText("wos_NEWSECRET")).toBeInTheDocument();
  });
});

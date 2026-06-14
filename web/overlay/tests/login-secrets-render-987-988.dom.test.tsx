import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

const { authSetupRequired, authStatus, secretsList } = vi.hoisted(() => ({
  authSetupRequired: vi.fn(),
  authStatus: vi.fn(),
  secretsList: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/login",
}));

vi.mock("@/lib/api", () => ({
  api: {
    auth: { setupRequired: authSetupRequired, status: authStatus },
    secrets: { list: secretsList },
  },
}));

vi.mock("@/lib/use-is-admin", () => ({ useIsAdmin: () => ({ isAdmin: true, pending: false }) }));

beforeEach(() => {
  vi.clearAllMocks();
  authSetupRequired.mockResolvedValue({ required: false });
  authStatus.mockResolvedValue({ mode: "username" });
  secretsList.mockResolvedValue([]);
});

describe("#987 login page renders the sign-in form", () => {
  it("shows sign-in controls, not a blank/not-found shell", async () => {
    const mod = await import("@/app/login/page");
    render(await mod.default({ searchParams: Promise.resolve({}) }));
    await waitFor(() => {
      expect(document.body.textContent || "").not.toEqual("");
    });
    expect(screen.queryByText(/Page not found/i)).toBeNull();
    expect(document.body.textContent).toMatch(/sign in|ai workers/i);
  });
});

describe("#988 secrets page leaves the Suspense fallback and fetches", () => {
  it("calls api.secrets.list() for an admin and leaves 'Loading secrets...'", async () => {
    const mod = await import("@/app/connections/secrets/page");
    render(<mod.default />);
    await waitFor(() => expect(secretsList).toHaveBeenCalled());
    await waitFor(() => {
      expect(document.body.textContent || "").not.toMatch(/Loading secrets\.\.\./);
    });
  });
});

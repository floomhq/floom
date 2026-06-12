import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

// #987: /login must render the sign-in form (not the not-found shell / blank).
// #988: /connections/secrets must leave the "Loading secrets..." Suspense
// fallback and call api.secrets.list() for an admin.
//
// These are source-level smokes: they prove the components render and fetch.
// The live audit's blank pages were a broken DEPLOYMENT (body_len=0 hydration
// failure), not a source bug — these guard against a real source regression.

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
    render(<mod.default />);
    // the brand copy and a Sign in affordance render synchronously
    await waitFor(() => {
      expect(document.body.textContent || "").not.toEqual("");
    });
    expect(screen.queryByText(/Page not found/i)).toBeNull();
    expect(document.body.textContent).toMatch(/sign in|hire ai workers/i);
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

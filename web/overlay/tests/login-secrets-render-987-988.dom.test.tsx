import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";

const { authSetupRequired, authStatus, me, secretsList, workersList } = vi.hoisted(() => ({
  authSetupRequired: vi.fn(),
  authStatus: vi.fn(),
  me: vi.fn(),
  secretsList: vi.fn(),
  workersList: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/login",
}));

vi.mock("@/lib/api", () => ({
  api: {
    me,
    auth: { setupRequired: authSetupRequired, status: authStatus },
    workers: { list: workersList },
    secrets: { list: secretsList },
  },
}));

vi.mock("@/lib/use-is-admin", () => ({ useIsAdmin: () => ({ isAdmin: true, pending: false }) }));

beforeEach(() => {
  vi.clearAllMocks();
  authSetupRequired.mockResolvedValue({ required: false });
  authStatus.mockResolvedValue({ mode: "username" });
  me.mockResolvedValue({ user_id: "u_1", email: "admin@floom.dev", roles: ["owner"] });
  secretsList.mockResolvedValue([]);
  workersList.mockResolvedValue([]);
});

function renderWithQuery(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

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
    renderWithQuery(<mod.default />);
    await waitFor(() => expect(secretsList).toHaveBeenCalled());
    await waitFor(() => {
      expect(document.body.textContent || "").not.toMatch(/Loading secrets\.\.\./);
    });
  });
});

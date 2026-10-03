import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// jsdom does not implement window.open; replace it once so async effects that
// fire after a test completes never log an un-implemented error.
const openMock = vi.fn<typeof window.open>(() => ({}) as unknown as Window);
Object.defineProperty(window, "open", { value: openMock, writable: true });

// fix/composio-connect-flow — the /connections/redirect page must AUTO-OPEN the
// Composio authorization URL (no manual click) and explain what Composio is.
// Previously the "ready" phase rendered a static link the user had to find and
// click, which read as a stuck/blank page (problem 1). It must also fall back to
// a visible manual link when the browser blocks the pop-up (problem 1 fallback)
// and always surface the "What is Composio?" explainer (problem 2).

const initiate = vi.fn();
const statusFn = vi.fn();
const listFn = vi.fn();
const replace = vi.fn();

vi.mock("next/navigation", () => ({
  useSearchParams: () =>
    new URLSearchParams("app=gmail&return_to=%2Fconnections%2Fbrowse"),
  useRouter: () => ({ replace, push: vi.fn() }),
}));

vi.mock("@/lib/api", () => ({
  api: {
    connections: {
      initiate: (...args: unknown[]) => initiate(...args),
      status: (...args: unknown[]) => statusFn(...args),
      list: (...args: unknown[]) => listFn(...args),
    },
  },
}));

import RedirectPage from "@/app/connections/redirect/page";

const COMPOSIO_URL = "https://platform.composio.dev/link/abc123";

// #1209/#1206: RedirectPage now invalidates TanStack Query caches (connections
// / worker-detail / overview) once the poll finds an active connection, so it
// needs a real QueryClient in the tree.
function renderRedirectPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <RedirectPage />
    </QueryClientProvider>
  );
}

describe("connections/redirect auto-open", () => {
  beforeEach(() => {
    initiate.mockReset().mockResolvedValue({
      id: "floom-conn-1",
      app_name: "gmail",
      redirect_url: COMPOSIO_URL,
      composio_connection_id: "ca_abc",
    });
    statusFn.mockReset().mockResolvedValue({ status: "initiated" });
    listFn.mockReset().mockResolvedValue([]);
    replace.mockReset();
    // Default: pop-up succeeds. Individual tests override for the blocked case.
    openMock.mockReset().mockReturnValue({} as unknown as Window);
  });

  it("auto-opens the Composio URL in a new tab without a click", async () => {
    renderRedirectPage();

    await waitFor(() =>
      expect(openMock).toHaveBeenCalledWith(
        COMPOSIO_URL,
        "_blank",
        "noopener,noreferrer"
      )
    );
  });

  it("explains what Composio is", async () => {
    renderRedirectPage();
    await waitFor(() =>
      expect(screen.getByText(/What is Composio\?/i)).toBeTruthy()
    );
  });

  it("falls back to a manual Open Composio link when the pop-up is blocked", async () => {
    // Blocked pop-up: window.open returns null.
    openMock.mockReturnValue(null);
    renderRedirectPage();

    const link = await screen.findByRole("link", { name: /Open Composio/i });
    expect(link.getAttribute("href")).toBe(COMPOSIO_URL);
    expect(link.getAttribute("target")).toBe("_blank");
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

// #1006: WorkersCollection accepts host-injected top-level views so
// managed-deployment can compose the engine component (its cross-tenant
// workspace-admin view) instead of forking 869 lines.

// R9: WorkersCollection migrated to TanStack Query (useWorkers hook). Tests
// must wrap renders in a QueryClientProvider.
function createWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/",
}));

const worker = {
  id: "w1",
  name: "Weekly Update",
  description: "Turns notes into an update",
  tags: ["operations"],
  status: "healthy",
  trigger_type: "manual",
  runner: "e2b",
  triggers: [],
  triggers_spec: [],
  connections: ["github"],
  recent_stats: { last_run_at: "2026-06-08T00:00:00Z", runs_7d: 3 },
  visibility: "workspace",
};

vi.mock("@/lib/api", () => ({
  api: {
    me: vi.fn().mockResolvedValue({ is_admin: true, role: "admin" }),
    workers: {
      list: vi.fn().mockResolvedValue([worker]),
      get: vi.fn().mockResolvedValue({ ...worker, config: {}, files: [], recent_runs: [] }),
    },
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("WorkersCollection extra views (#1006)", () => {
  it("renders no view switcher when no extra views are supplied (OSS)", async () => {
    const { default: WorkersCollection } = await import("@/app/workers/WorkersCollection");
    render(<WorkersCollection initialWorkers={[worker as never]} />, { wrapper: createWrapper() });
    expect(await screen.findByText("Weekly Update")).toBeInTheDocument();
    // No top-level tablist in OSS mode.
    expect(screen.queryByRole("tablist", { name: "Workers views" })).toBeNull();
  });

  it("renders a switcher and swaps to the injected view on click", async () => {
    const { default: WorkersCollection } = await import("@/app/workers/WorkersCollection");
    const extraViews = [
      {
        key: "admin",
        label: "All members",
        render: () => <div>WORKSPACE ADMIN PANEL</div>,
      },
    ];
    render(<WorkersCollection initialWorkers={[worker as never]} extraViews={extraViews} />, { wrapper: createWrapper() });

    // Switcher is present with both tabs.
    expect(await screen.findByRole("tab", { name: "Workers" })).toBeInTheDocument();
    const adminTab = screen.getByRole("tab", { name: "All members" });

    // Default view is the workers Collection; the injected panel is hidden.
    expect(await screen.findByText("Weekly Update")).toBeInTheDocument();
    expect(screen.queryByText("WORKSPACE ADMIN PANEL")).toBeNull();

    // Switching shows the host view in place of the Collection.
    fireEvent.click(adminTab);
    await waitFor(() =>
      expect(screen.getByText("WORKSPACE ADMIN PANEL")).toBeInTheDocument()
    );
    expect(screen.queryByText("Weekly Update")).toBeNull();
    expect(adminTab).toHaveAttribute("aria-selected", "true");
  });
});

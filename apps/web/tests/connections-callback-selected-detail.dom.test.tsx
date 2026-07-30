import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const replace = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
  useSearchParams: () =>
    new URLSearchParams("connection_id=ca_2084&status=success&state=test-state"),
}));

import ConnectionsCallbackPage from "@/app/connections/callback/page";

// #1209/#1206: the callback page now invalidates TanStack Query caches
// (connections / worker-detail / overview) before navigating, so it needs a
// real QueryClient in the tree.
function renderCallbackPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ConnectionsCallbackPage />
    </QueryClientProvider>
  );
}

describe("connections callback selected detail", () => {
  beforeEach(() => {
    replace.mockReset();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        url: "http://localhost:3000/connections?connected=1&app=gmail&connection_id=conn-2084&sel=conn-2084",
      }),
    );
  });

  it("preserves the selected connection from the backend callback redirect", async () => {
    renderCallbackPage();

    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith(
        "/connections?connected=1&app=gmail&connection_id=conn-2084&sel=conn-2084",
      );
    });
  });
});

import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const replace = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
  useSearchParams: () =>
    new URLSearchParams("connection_id=ca_2084&status=success&state=test-state"),
}));

import ConnectionsCallbackPage from "@/app/connections/callback/page";

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
    render(<ConnectionsCallbackPage />);

    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith(
        "/connections?connected=1&app=gmail&connection_id=conn-2084&sel=conn-2084",
      );
    });
  });
});

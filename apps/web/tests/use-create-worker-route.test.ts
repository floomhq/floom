// @vitest-environment jsdom
import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { useCreateWorkerLegacyRedirect } from "@/lib/use-create-worker-route";

const { search, replace } = vi.hoisted(() => ({
  search: vi.fn(() => "create=1"),
  replace: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
  useSearchParams: () => new URLSearchParams(search()),
}));

describe("useCreateWorkerLegacyRedirect", () => {
  beforeEach(() => {
    search.mockReturnValue("create=1");
    replace.mockClear();
  });

  it("forwards legacy ?create=1 to /workers/new", async () => {
    renderHook(() => useCreateWorkerLegacyRedirect());
    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith("/workers/new");
    });
  });

  it("preserves primed prompt text as ?prompt=", async () => {
    search.mockReturnValue("create=1&prime=" + encodeURIComponent("Digest worker"));
    renderHook(() => useCreateWorkerLegacyRedirect());
    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith(
        "/workers/new?prompt=" + encodeURIComponent("Digest worker"),
      );
    });
  });
});

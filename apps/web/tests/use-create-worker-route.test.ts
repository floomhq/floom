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

// Product decision (2026-06-24): "New worker" drives the IN-EMILY create flow
// (`?create=1`, handled by EmilyDock) that supersedes the active Emily chat in
// place. The legacy redirect that used to forward `?create=1` to the separate
// /workers/new page is now a deliberate no-op, so `?create=1` reaches EmilyDock's
// effect instead of being redirected away.
describe("useCreateWorkerLegacyRedirect", () => {
  beforeEach(() => {
    search.mockReturnValue("create=1");
    replace.mockClear();
  });

  it("does NOT redirect ?create=1 to /workers/new (handled in place by Emily)", async () => {
    renderHook(() => useCreateWorkerLegacyRedirect());
    // Give any (would-be) redirect effect a chance to fire before asserting none did.
    await new Promise((r) => setTimeout(r, 20));
    expect(replace).not.toHaveBeenCalled();
  });

  it("does not redirect even when a primed prompt is present", async () => {
    search.mockReturnValue("create=1&prime=" + encodeURIComponent("Digest worker"));
    renderHook(() => useCreateWorkerLegacyRedirect());
    await new Promise((r) => setTimeout(r, 20));
    expect(replace).not.toHaveBeenCalled();
  });

  it("never navigates to /workers/new", async () => {
    renderHook(() => useCreateWorkerLegacyRedirect());
    await waitFor(() => {
      // No call should ever target the legacy page.
      const calledWithLegacy = replace.mock.calls.some((args) =>
        String(args[0]).includes("/workers/new"),
      );
      expect(calledWithLegacy).toBe(false);
    });
  });
});

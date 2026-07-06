// One URL per worker forever (Fede 2026-07-06): the legacy /w/<id>?token=
// page permanently redirects to the canonical /@handle/slug permalink
// instead of rendering here (finding-or-minting a durable ?share= link for a
// non-public worker along the way — a strict improvement over the legacy
// HMAC, which had no revoke path).
import { afterEach, describe, expect, it, vi } from "vitest";

const fetchPublicWorker = vi.fn();
const fetchWorkerPermalinkRedirect = vi.fn();
vi.mock("@/lib/server-api", () => ({ fetchPublicWorker, fetchWorkerPermalinkRedirect }));

const isAuthenticated = vi.fn(async () => false);
vi.mock("@/lib/server-auth", () => ({ isAuthenticated }));

vi.mock("@/components/share/WorkerShareCard", () => ({ WorkerShareCard: () => null }));
vi.mock("@/components/share/ShareCardShell", () => ({ ShareCardShell: () => null }));

class RedirectSignal extends Error {
  url: string;
  constructor(url: string) {
    super("NEXT_REDIRECT");
    this.url = url;
  }
}
const redirect = vi.fn((url: string) => {
  throw new RedirectSignal(url);
});
const notFound = vi.fn(() => {
  throw new Error("NEXT_NOT_FOUND");
});
vi.mock("next/navigation", () => ({ redirect, notFound }));

function resetMocks() {
  fetchPublicWorker.mockReset();
  fetchWorkerPermalinkRedirect.mockReset();
  redirect.mockClear();
  notFound.mockClear();
}

describe("/w/[id] legacy HMAC-link redirect", () => {
  afterEach(resetMocks);

  it("404s with no token, without calling the redirect lookup", async () => {
    resetMocks();
    const page = await import("@/app/w/[id]/page");

    await expect(
      page.default({
        params: Promise.resolve({ id: "worker-1" }),
        searchParams: Promise.resolve({}),
      })
    ).rejects.toThrow("NEXT_NOT_FOUND");

    expect(fetchWorkerPermalinkRedirect).not.toHaveBeenCalled();
  });

  it("redirects to the bare permalink for a public worker", async () => {
    resetMocks();
    fetchWorkerPermalinkRedirect.mockResolvedValue("https://floom.dev/@depontefede/morning-brief");
    const page = await import("@/app/w/[id]/page");

    await expect(
      page.default({
        params: Promise.resolve({ id: "worker-1" }),
        searchParams: Promise.resolve({ token: "deadbeef" }),
      })
    ).rejects.toBeInstanceOf(RedirectSignal);

    expect(redirect).toHaveBeenCalledWith("https://floom.dev/@depontefede/morning-brief");
    expect(fetchPublicWorker).not.toHaveBeenCalled();
  });

  it("redirects with a minted ?share= key for a non-public worker", async () => {
    resetMocks();
    fetchWorkerPermalinkRedirect.mockResolvedValue(
      "https://floom.dev/@depontefede/private-worker?share=fls_private-worker-xyz"
    );
    const page = await import("@/app/w/[id]/page");

    await expect(
      page.default({
        params: Promise.resolve({ id: "worker-1" }),
        searchParams: Promise.resolve({ token: "deadbeef" }),
      })
    ).rejects.toBeInstanceOf(RedirectSignal);

    expect(redirect).toHaveBeenCalledWith(
      "https://floom.dev/@depontefede/private-worker?share=fls_private-worker-xyz"
    );
  });

  it("falls back to the legacy card when the redirect lookup can't resolve a handle", async () => {
    resetMocks();
    fetchWorkerPermalinkRedirect.mockResolvedValue(null);
    fetchPublicWorker.mockResolvedValue({ id: "worker-1", name: "Morning Brief" });
    const page = await import("@/app/w/[id]/page");

    await page.default({
      params: Promise.resolve({ id: "worker-1" }),
      searchParams: Promise.resolve({ token: "deadbeef" }),
    });

    expect(redirect).not.toHaveBeenCalled();
    expect(fetchPublicWorker).toHaveBeenCalledWith("worker-1", "deadbeef");
  });

  it("falls back to the legacy card (never 500s) when the redirect lookup fetch fails", async () => {
    resetMocks();
    fetchWorkerPermalinkRedirect.mockRejectedValue(new Error("network blip"));
    fetchPublicWorker.mockResolvedValue({ id: "worker-1", name: "Morning Brief" });
    const page = await import("@/app/w/[id]/page");

    await page.default({
      params: Promise.resolve({ id: "worker-1" }),
      searchParams: Promise.resolve({ token: "deadbeef" }),
    });

    expect(redirect).not.toHaveBeenCalled();
  });

  it("404s on a bad/missing token exactly as before (no detail leaked)", async () => {
    resetMocks();
    fetchWorkerPermalinkRedirect.mockRejectedValue(new Error("401"));
    fetchPublicWorker.mockRejectedValue(new Error("401"));
    const page = await import("@/app/w/[id]/page");

    await expect(
      page.default({
        params: Promise.resolve({ id: "worker-1" }),
        searchParams: Promise.resolve({ token: "bad-token" }),
      })
    ).rejects.toThrow("NEXT_NOT_FOUND");
  });
});

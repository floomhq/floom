// One URL per worker forever (Fede 2026-07-06): the legacy /s/<token> page
// permanently redirects a worker share to its canonical /@handle/slug
// permalink instead of rendering here. Non-worker entity types (brain_file,
// brain_pack, run, approvals_batch) are unaffected; they keep rendering
// inline as before.
import { afterEach, describe, expect, it, vi } from "vitest";

const fetchStandaloneShare = vi.fn();
vi.mock("@/lib/server-api", () => ({ fetchStandaloneShare }));

const isAuthenticated = vi.fn(async () => false);
vi.mock("@/lib/server-auth", () => ({ isAuthenticated }));

vi.mock("./StandaloneShareCard", () => ({
  StandaloneShareCard: () => null,
}));

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
  fetchStandaloneShare.mockReset();
  redirect.mockClear();
  notFound.mockClear();
}

describe("/s/[token] worker-entity permalink redirect", () => {
  afterEach(resetMocks);

  it("redirects a public worker share to the bare canonical permalink", async () => {
    resetMocks();
    fetchStandaloneShare.mockResolvedValue({
      entity_type: "worker",
      title: "Morning Brief",
      files: [],
      permalink_redirect_url: "https://floom.dev/@depontefede/morning-brief",
    });
    const page = await import("@/app/s/[token]/page");

    await expect(
      page.default({ params: Promise.resolve({ token: "fls_abc123" }) })
    ).rejects.toBeInstanceOf(RedirectSignal);

    expect(redirect).toHaveBeenCalledWith("https://floom.dev/@depontefede/morning-brief");
  });

  it("redirects a non-public worker share with the ?share= token appended", async () => {
    resetMocks();
    fetchStandaloneShare.mockResolvedValue({
      entity_type: "worker",
      title: "Private Worker",
      files: [],
      permalink_redirect_url: "https://floom.dev/@depontefede/private-worker?share=fls_abc123",
    });
    const page = await import("@/app/s/[token]/page");

    await expect(
      page.default({ params: Promise.resolve({ token: "fls_abc123" }) })
    ).rejects.toBeInstanceOf(RedirectSignal);

    expect(redirect).toHaveBeenCalledWith(
      "https://floom.dev/@depontefede/private-worker?share=fls_abc123"
    );
  });

  it("falls back to rendering the legacy card when no handle resolves (permalink_redirect_url is null)", async () => {
    resetMocks();
    fetchStandaloneShare.mockResolvedValue({
      entity_type: "worker",
      title: "Morning Brief",
      files: [],
      permalink_redirect_url: null,
    });
    const page = await import("@/app/s/[token]/page");

    await page.default({ params: Promise.resolve({ token: "fls_abc123" }) });

    expect(redirect).not.toHaveBeenCalled();
  });

  it("never redirects a non-worker entity type (brain_pack, run, approvals_batch unaffected)", async () => {
    resetMocks();
    fetchStandaloneShare.mockResolvedValue({
      entity_type: "brain_pack",
      title: "Hiring playbook",
      files: [],
    });
    const page = await import("@/app/s/[token]/page");

    await page.default({ params: Promise.resolve({ token: "fls_pack123" }) });

    expect(redirect).not.toHaveBeenCalled();
  });
});

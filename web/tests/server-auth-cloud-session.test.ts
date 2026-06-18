import { afterEach, describe, expect, it, vi } from "vitest";

describe("server-auth cloud session detection", () => {
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("uses workeros_cloud_session and verifySession for public share pages", async () => {
    const verifySession = vi.fn().mockResolvedValue({ payload: {}, verified: true });
    vi.doMock("@/lib/verify-session", () => ({ verifySession }));
    vi.doMock("next/headers", () => ({
      cookies: async () => ({
        get: (name: string) => (name === "workeros_cloud_session" ? { value: "cloud-cookie" } : undefined),
      }),
    }));

    const { isAuthenticated } = await import("@/lib/server-auth");

    await expect(isAuthenticated()).resolves.toBe(true);
    expect(verifySession).toHaveBeenCalledWith("cloud-cookie");
  });

  it("does not treat OSS session cookies as authenticated on cloud share pages", async () => {
    const verifySession = vi.fn().mockResolvedValue(null);
    vi.doMock("@/lib/verify-session", () => ({ verifySession }));
    vi.doMock("next/headers", () => ({
      cookies: async () => ({
        get: (name: string) => (name === "workeros_session" ? { value: "oss-cookie" } : undefined),
      }),
    }));

    const { isAuthenticated } = await import("@/lib/server-auth");

    await expect(isAuthenticated()).resolves.toBe(false);
    expect(verifySession).toHaveBeenCalledWith(undefined);
  });
});

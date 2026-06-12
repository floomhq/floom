// Cloud /api/me: #941 (never shared-cacheable) + #935 (no user without a
// verified session). Engine's auth-route cache tests are excluded on cloud
// (different session model); this is the cloud-side equivalent.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let cookieValue: string | undefined;

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "workeros_cloud_session" && cookieValue
        ? { name, value: cookieValue }
        : undefined,
  }),
}));

function forgedCookie(): string {
  const payload = JSON.stringify({
    access_token: "a.b.c",
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user_id: "user-123",
  });
  return Buffer.from(payload).toString("base64url");
}

beforeEach(() => {
  cookieValue = undefined;
  vi.stubEnv("SUPABASE_URL", "https://test-project.supabase.co");
  // JWKS fetch returns an empty key set — nothing can verify.
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ keys: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("cloud /api/me — #941 cache + #935 verification", () => {
  it("responds private no-store", async () => {
    const { GET } = await import("../app/api/me/route");
    const res = await GET();
    expect(res.headers.get("cache-control")).toBe("private, no-store, max-age=0");
  });

  it("returns user:null for an unverifiable (forged) session", async () => {
    cookieValue = forgedCookie();
    const { GET } = await import("../app/api/me/route");
    const res = await GET();
    expect(res.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    await expect(res.json()).resolves.toEqual({ user: null });
  });

  it("returns user:null with no cookie at all", async () => {
    const { GET } = await import("../app/api/me/route");
    const res = await GET();
    await expect(res.json()).resolves.toEqual({ user: null });
  });
});

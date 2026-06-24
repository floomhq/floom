import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const cookieState = vi.hoisted(() => ({ value: "" }));

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: (name: string) => (name === "workeros_cloud_session" ? { value: cookieState.value } : undefined),
  })),
}));

function sessionCookie(): string {
  return Buffer.from(
    JSON.stringify({
      access_token: "jwt-test",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      user_id: "user-123",
    }),
  ).toString("base64url");
}

function unsignedJwt(claims: Record<string, unknown>): string {
  return [
    Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
    Buffer.from(JSON.stringify(claims)).toString("base64url"),
    "sig",
  ].join(".");
}

async function loadRoute() {
  vi.resetModules();
  return import("@/app/api/proxy/[...path]/route");
}

describe("api proxy route", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    delete process.env.WORKEROS_API_BASE;
    delete process.env.WORKEROS_CLOUD_SUPABASE_URL;
    cookieState.value = "";
  });

  it("keeps same-origin frontend redirects as relative locations", async () => {
    process.env.WORKEROS_API_BASE = "https://workeros-api.floom.dev";
    cookieState.value = sessionCookie();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, {
        status: 307,
        headers: {
          location: "https://workers.floom.dev/connections?connected=1&connection_id=local_123",
        },
      }),
    );
    const { GET } = await loadRoute();

    const res = await GET(
      new NextRequest(
        "https://workers.floom.dev/api/proxy/connections/callback?connection_id=ca_123&status=success",
      ),
      { params: Promise.resolve({ path: ["connections", "callback"] }) },
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "https://workeros-api.floom.dev/api/connections/callback?connection_id=ca_123&status=success",
      expect.objectContaining({ redirect: "manual" }),
    );
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("/connections?connected=1&connection_id=local_123");
  });

  it("rewrites backend-origin redirects through the proxy", async () => {
    process.env.WORKEROS_API_BASE = "https://workeros-api.floom.dev";
    cookieState.value = sessionCookie();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, {
        status: 307,
        headers: { location: "https://workeros-api.floom.dev/api/workers/abc?tab=source" },
      }),
    );
    const { GET } = await loadRoute();

    const res = await GET(
      new NextRequest("https://workers.floom.dev/api/proxy/workers"),
      { params: Promise.resolve({ path: ["workers"] }) },
    );

    expect(res.headers.get("location")).toBe("/api/proxy/workers/abc?tab=source");
  });

  it("uses backend session-token resolution for encrypted v2 cookies", async () => {
    process.env.WORKEROS_API_BASE = "https://workeros-api.floom.dev";
    cookieState.value = "v2.gAAAAencrypted";
    const token = unsignedJwt({
      sub: "user-123",
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/auth/session-token")) {
        return new Response(
          JSON.stringify({
            access_token: token,
            expires_at: Math.floor(Date.now() / 1000) + 3600,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const { GET } = await loadRoute();

    await GET(new NextRequest("https://workers.floom.dev/api/proxy/workers"), {
      params: Promise.resolve({ path: ["workers"] }),
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://workeros-api.floom.dev/api/workers",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: `Bearer ${token}` }),
      }),
    );
  });

  it("strips external upstream locations", async () => {
    process.env.WORKEROS_API_BASE = "https://workeros-api.floom.dev";
    cookieState.value = sessionCookie();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: "https://evil.example/phish" },
      }),
    );
    const { GET } = await loadRoute();

    const res = await GET(
      new NextRequest("https://workers.floom.dev/api/proxy/workers"),
      { params: Promise.resolve({ path: ["workers"] }) },
    );

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBeNull();
  });

  it("passes the configured Supabase OAuth redirect through unchanged (fresh login)", async () => {
    process.env.WORKEROS_API_BASE = "https://workeros-api.floom.dev";
    process.env.WORKEROS_CLOUD_SUPABASE_URL = "https://sgizlsyygvlqosgwdimb.supabase.co";
    // No session cookie: a fresh/incognito login has none, and /auth/* is unguarded.
    const supaLocation =
      "https://sgizlsyygvlqosgwdimb.supabase.co/auth/v1/authorize?provider=google&redirect_to=https%3A%2F%2Fworkeros-api.floom.dev%2Fauth%2Fcallback%3Fnext%3D%252Fapp&code_challenge=abc&code_challenge_method=s256";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 307, headers: { location: supaLocation } }),
    );
    const { GET } = await loadRoute();

    const res = await GET(
      new NextRequest("https://workers.floom.dev/api/proxy/auth/login?provider=google&next=%2Fapp"),
      { params: Promise.resolve({ path: ["auth", "login"] }) },
    );

    expect(res.status).toBe(307);
    // Forwarded verbatim so the browser can navigate to Supabase -> Google.
    expect(res.headers.get("location")).toBe(supaLocation);
  });

  it("still strips a non-configured supabase-lookalike origin", async () => {
    process.env.WORKEROS_API_BASE = "https://workeros-api.floom.dev";
    process.env.WORKEROS_CLOUD_SUPABASE_URL = "https://sgizlsyygvlqosgwdimb.supabase.co";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, {
        status: 307,
        headers: { location: "https://evil-project.supabase.co/auth/v1/authorize?provider=google" },
      }),
    );
    const { GET } = await loadRoute();

    const res = await GET(
      new NextRequest("https://workers.floom.dev/api/proxy/auth/login?provider=google"),
      { params: Promise.resolve({ path: ["auth", "login"] }) },
    );

    expect(res.headers.get("location")).toBeNull();
  });
});

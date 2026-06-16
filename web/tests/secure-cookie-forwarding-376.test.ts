import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const cookieState = vi.hoisted(() => ({ value: "" }));

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: (name: string) => (name === "workeros_cloud_session" ? { value: cookieState.value } : undefined),
  })),
}));

function sessionCookie(): string {
  return Buffer.from(JSON.stringify({ access_token: "jwt-test" })).toString("base64url");
}

describe("#376 cloud auth cookie forwarding", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    delete process.env.WORKEROS_API_BASE;
    cookieState.value = "";
  });

  it("password route forwards backend cookie with Secure forced", async () => {
    const upstream = new Response(JSON.stringify({ ok: true }), { status: 200 });
    upstream.headers.append(
      "set-cookie",
      "workeros_cloud_session=tok; Path=/; HttpOnly; SameSite=lax",
    );
    vi.spyOn(globalThis, "fetch").mockResolvedValue(upstream);
    const { POST } = await import("@/app/api/auth/password/route");

    const res = await POST(
      new NextRequest("https://workers.floom.dev/api/auth/password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "user@example.com", password: "password123" }),
      }),
    );

    expect(res.headers.get("set-cookie")).toContain("Secure");
  });

  it("proxy route forwards upstream cookies with Secure forced", async () => {
    process.env.WORKEROS_API_BASE = "https://workeros-api.floom.dev";
    cookieState.value = sessionCookie();
    const upstream = new Response("{}", { status: 200 });
    upstream.headers.append(
      "set-cookie",
      "workeros_cloud_session=tok; Path=/; HttpOnly; SameSite=lax",
    );
    vi.spyOn(globalThis, "fetch").mockResolvedValue(upstream);
    const { GET } = await import("@/app/api/proxy/[...path]/route");

    const res = await GET(
      new NextRequest("https://workers.floom.dev/api/proxy/me"),
      { params: Promise.resolve({ path: ["me"] }) },
    );

    expect(res.headers.get("set-cookie")).toContain("Secure");
  });
});

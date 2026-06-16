import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const cookieState = vi.hoisted(() => ({ value: "" }));

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: (name: string) => (name === "workeros_cloud_session" ? { value: cookieState.value } : undefined),
  })),
}));

describe("#392 CLI auth route cache headers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    cookieState.value = "";
    delete process.env.WORKEROS_API_BASE;
  });

  it("marks unauthenticated responses private no-store", async () => {
    const { POST } = await import("@/app/api/cli-auth/[action]/route");

    const res = await POST(
      new NextRequest("https://workers.floom.dev/app/api/cli-auth/approve", {
        method: "POST",
        body: JSON.stringify({ user_code: "ABCD-1234" }),
      }),
      { params: Promise.resolve({ action: "approve" }) },
    );

    expect(res.status).toBe(401);
    expect(res.headers.get("cache-control")).toBe("private, no-store, max-age=0");
  });

  it("marks upstream responses private no-store", async () => {
    process.env.WORKEROS_API_BASE = "https://workeros-api.floom.dev";
    cookieState.value = "session-token";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const { POST } = await import("@/app/api/cli-auth/[action]/route");

    const res = await POST(
      new NextRequest("https://workers.floom.dev/app/api/cli-auth/approve", {
        method: "POST",
        body: JSON.stringify({ user_code: "ABCD-1234" }),
      }),
      { params: Promise.resolve({ action: "approve" }) },
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store, max-age=0");
  });
});

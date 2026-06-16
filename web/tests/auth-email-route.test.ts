import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { safeAppNext } from "@/lib/safe-next";

describe("#357 email auth next validation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    delete process.env.WORKEROS_API_BASE;
  });

  it("normalizes unsafe next values before forwarding to backend login", async () => {
    process.env.WORKEROS_API_BASE = "https://workeros-api.floom.dev";
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const { POST } = await import("@/app/api/auth/email/route");

    const res = await POST(
      new NextRequest("https://workers.floom.dev/api/auth/email", {
        method: "POST",
        body: JSON.stringify({ email: "user@example.com", next: "https://evil.example/cb" }),
      }),
    );

    const url = new URL(String(fetchMock.mock.calls[0][0]));
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(url.searchParams.get("next")).toBe("/app");
    expect(new Headers(init.headers).get("x-workeros-frontend-origin")).toBe("https://workers.floom.dev");
    expect(res.headers.get("cache-control")).toBe("private, no-store, max-age=0");
  });

  it("marks validation errors private no-store", async () => {
    const { POST } = await import("@/app/api/auth/email/route");

    const res = await POST(
      new NextRequest("https://workers.floom.dev/api/auth/email", {
        method: "POST",
        body: JSON.stringify({ next: "/app" }),
      }),
    );

    expect(res.status).toBe(400);
    expect(res.headers.get("cache-control")).toBe("private, no-store, max-age=0");
  });

  it("keeps relative app paths with query and hash", () => {
    expect(safeAppNext("/settings?sel=channels#slack")).toBe("/settings?sel=channels#slack");
    expect(safeAppNext("//evil.example/path")).toBe("/app");
    expect(safeAppNext("https://evil.example/path")).toBe("/app");
  });
});

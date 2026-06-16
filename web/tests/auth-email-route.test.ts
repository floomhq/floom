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

    await POST(
      new NextRequest("https://workers.floom.dev/api/auth/email", {
        method: "POST",
        body: JSON.stringify({ email: "user@example.com", next: "https://evil.example/cb" }),
      }),
    );

    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.searchParams.get("next")).toBe("/app");
  });

  it("keeps relative app paths with query and hash", () => {
    expect(safeAppNext("/settings?sel=channels#slack")).toBe("/settings?sel=channels#slack");
    expect(safeAppNext("//evil.example/path")).toBe("/app");
    expect(safeAppNext("https://evil.example/path")).toBe("/app");
  });
});

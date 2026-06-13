// g1 security batch — #923 secret-mode login rate limiting, #944 malformed
// JSON handling + generic credential errors on /api/auth/login.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const URL_ = "http://localhost/api/auth/login";

function jsonRequest(body: string, ip = "203.0.113.10"): Request {
  return new Request(URL_, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": ip,
    },
    body,
  });
}

async function loadRoute() {
  const mod = await import("@/app/api/auth/login/route");
  return mod.POST as (req: Request) => Promise<Response>;
}

describe("/api/auth/login secret mode", () => {
  beforeEach(() => {
    process.env.FLOOM_API_SECRET = "g1-correct-secret";
  });

  afterEach(() => {
    delete process.env.FLOOM_API_SECRET;
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("#944: malformed JSON returns a generic 400, not a 401 secret error", async () => {
    const POST = await loadRoute();
    const res = await POST(jsonRequest("{not-json"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.detail).toBe("Invalid request body");
    expect(JSON.stringify(body)).not.toContain("access secret");
  });

  it("#944: wrong secret returns the generic credentials message", async () => {
    const POST = await loadRoute();
    const res = await POST(jsonRequest(JSON.stringify({ secret: "wrong" })));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.detail).toBe("invalid credentials");
  });

  it("#923: locks out an IP after 5 failed secret attempts", async () => {
    const POST = await loadRoute();
    for (let i = 0; i < 5; i++) {
      const res = await POST(jsonRequest(JSON.stringify({ secret: `wrong-${i}` }), "198.51.100.7"));
      expect(res.status).toBe(401);
    }
    // 6th attempt — even with the CORRECT secret — is locked out.
    const locked = await POST(
      jsonRequest(JSON.stringify({ secret: "g1-correct-secret" }), "198.51.100.7"),
    );
    expect(locked.status).toBe(429);

    // a different IP is unaffected
    const other = await POST(jsonRequest(JSON.stringify({ secret: "wrong" }), "198.51.100.8"));
    expect(other.status).toBe(401);
  });

  it("#923: successful login clears the failure counter", async () => {
    const POST = await loadRoute();
    for (let i = 0; i < 4; i++) {
      await POST(jsonRequest(JSON.stringify({ secret: "wrong" }), "198.51.100.9"));
    }
    const ok = await POST(
      jsonRequest(JSON.stringify({ secret: "g1-correct-secret" }), "198.51.100.9"),
    );
    expect(ok.status).toBe(200);
    const again = await POST(jsonRequest(JSON.stringify({ secret: "wrong" }), "198.51.100.9"));
    expect(again.status).toBe(401);
  });
});

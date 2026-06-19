// #935 — session cookies must be verified against the Supabase JWKS, not
// trusted after a base64 decode. Covers the exact reported attack: a forged
// cookie with a future expires_at bypassing the middleware redirect.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import {
  parseSessionPayload,
  resolveSessionPayload,
  resetJwksCacheForTests,
  verifySession,
} from "@/lib/verify-session";

const SUPABASE_URL = "https://test-project.supabase.co";
const API_BASE = "https://workeros-api.test";

let privateKey: CryptoKey;
let publicJwks: { keys: Record<string, unknown>[] };
let backendSessionToken: string | null = null;

async function makeKeys() {
  const pair = await generateKeyPair("ES256");
  privateKey = pair.privateKey as CryptoKey;
  const jwk = await exportJWK(pair.publicKey);
  publicJwks = { keys: [{ ...jwk, kid: "test-key", alg: "ES256", use: "sig" }] };
}

async function signToken(opts?: { sub?: string; aud?: string; expired?: boolean }) {
  return new SignJWT({})
    .setProtectedHeader({ alg: "ES256", kid: "test-key" })
    .setSubject(opts?.sub ?? "user-123")
    .setAudience(opts?.aud ?? "authenticated")
    .setIssuedAt()
    .setExpirationTime(opts?.expired ? "-1h" : "1h")
    .sign(privateKey);
}

function cookieFor(accessToken: string, userId = "user-123", expiresIn = 3600): string {
  const payload = JSON.stringify({
    access_token: accessToken,
    expires_at: Math.floor(Date.now() / 1000) + expiresIn,
    user_id: userId,
  });
  return Buffer.from(payload).toString("base64url");
}

function mockJwksFetch() {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    if (url.includes("/auth/session-token")) {
      const token = backendSessionToken ?? (await signToken());
      return new Response(
        JSON.stringify({
          access_token: token,
          expires_at: Math.floor(Date.now() / 1000) + 3600,
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
            "set-cookie": "workeros_cloud_session=v2.refreshed; Path=/; HttpOnly",
          },
        },
      );
    }
    if (url.includes("/.well-known/jwks.json")) {
      return new Response(JSON.stringify(publicJwks), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
}

beforeEach(async () => {
  await makeKeys();
  backendSessionToken = null;
  resetJwksCacheForTests();
  vi.stubEnv("SUPABASE_URL", SUPABASE_URL);
  vi.stubEnv("WORKEROS_API_BASE", API_BASE);
  mockJwksFetch();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("#935 verifySession", () => {
  it("accepts a properly signed Supabase JWT", async () => {
    const token = await signToken();
    const result = await verifySession(cookieFor(token));
    expect(result).not.toBeNull();
    expect(result!.verified).toBe(true);
    expect(result!.payload.user_id).toBe("user-123");
  });

  it("resolves encrypted v2 cookies through the backend session-token endpoint", async () => {
    backendSessionToken = await signToken();
    const result = await resolveSessionPayload("v2.gAAAAencrypted");

    expect(result).not.toBeNull();
    expect(result!.payload.access_token).toBe(backendSessionToken);
    expect(result!.payload.user_id).toBe("user-123");
    expect(result!.setCookieHeaders).toContain(
      "workeros_cloud_session=v2.refreshed; Path=/; HttpOnly",
    );
    expect(globalThis.fetch).toHaveBeenCalledWith(
      `${API_BASE}/auth/session-token`,
      expect.objectContaining({
        headers: { cookie: "workeros_cloud_session=v2.gAAAAencrypted" },
      }),
    );
  });

  it("verifies encrypted v2 cookies after backend resolution", async () => {
    backendSessionToken = await signToken();
    const result = await verifySession("v2.gAAAAencrypted");

    expect(result).not.toBeNull();
    expect(result!.verified).toBe(true);
    expect(result!.payload.user_id).toBe("user-123");
  });

  it("REJECTS a forged token with future expires_at (the reported attack)", async () => {
    // Attacker forges the cookie wholesale: garbage signature, far-future expiry.
    const forged = [
      Buffer.from(JSON.stringify({ alg: "ES256", kid: "test-key" })).toString("base64url"),
      Buffer.from(
        JSON.stringify({ sub: "user-123", aud: "authenticated", exp: 9999999999 }),
      ).toString("base64url"),
      "Zm9yZ2VkLXNpZ25hdHVyZQ", // "forged-signature"
    ].join(".");
    expect(await verifySession(cookieFor(forged))).toBeNull();
  });

  it("rejects a token signed by a DIFFERENT key", async () => {
    const otherPair = await generateKeyPair("ES256");
    const evil = await new SignJWT({})
      .setProtectedHeader({ alg: "ES256", kid: "test-key" })
      .setSubject("user-123")
      .setAudience("authenticated")
      .setExpirationTime("1h")
      .sign(otherPair.privateKey as CryptoKey);
    expect(await verifySession(cookieFor(evil))).toBeNull();
  });

  it("rejects an expired JWT even when the cookie claims a future expires_at", async () => {
    const token = await signToken({ expired: true });
    expect(await verifySession(cookieFor(token, "user-123", 9999))).toBeNull();
  });

  it("rejects when the cookie user_id does not match the token sub", async () => {
    const token = await signToken({ sub: "someone-else" });
    expect(await verifySession(cookieFor(token, "user-123"))).toBeNull();
  });

  it("rejects the wrong audience", async () => {
    const token = await signToken({ aud: "anon" });
    expect(await verifySession(cookieFor(token))).toBeNull();
  });

  it("falls back to the structural check when no Supabase URL is configured", async () => {
    vi.stubEnv("SUPABASE_URL", "");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("WORKEROS_CLOUD_SUPABASE_URL", "");
    const result = await verifySession(cookieFor("structurally.fine.token"));
    expect(result).not.toBeNull();
    expect(result!.verified).toBe(false);
  });

  it("parseSessionPayload still rejects malformed/expired cookie structures", () => {
    expect(parseSessionPayload(undefined)).toBeNull();
    expect(parseSessionPayload("not-base64!!")).toBeNull();
    expect(parseSessionPayload(cookieFor("tok", "user-123", -10))).toBeNull();
  });
});

describe("#935 middleware integration", () => {
  it("redirects a forged cookie to /login; valid session passes with no-store + CSP", async () => {
    const { middleware } = await import("@/middleware");

    const forgedCookie = cookieFor("a.b.c"); // structurally fine, unverifiable
    const forgedReq = new NextRequest("https://workeros.floom.dev/app/workers", {
      headers: { cookie: `workeros_cloud_session=${forgedCookie}` },
    });
    const forgedRes = await middleware(forgedReq);
    expect(forgedRes.status).toBe(307);
    expect(forgedRes.headers.get("location")).toContain("/login");

    const validCookie = cookieFor(await signToken());
    const validReq = new NextRequest("https://workeros.floom.dev/app/workers", {
      headers: { cookie: `workeros_cloud_session=${validCookie}` },
    });
    const validRes = await middleware(validReq);
    expect(validRes.headers.get("x-middleware-next")).toBe("1");
    expect(validRes.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    const csp = validRes.headers.get("content-security-policy")!;
    expect(csp).toMatch(/'nonce-[^']+'/);
    expect(csp.split(";").find((d) => d.trim().startsWith("script-src"))).not.toContain(
      "unsafe-inline",
    );
  });

  it("allows a valid encrypted v2 session cookie", async () => {
    const { middleware } = await import("@/middleware");
    backendSessionToken = await signToken();
    const validReq = new NextRequest("https://workeros.floom.dev/app/workers", {
      headers: { cookie: "workeros_cloud_session=v2.gAAAAencrypted" },
    });

    const validRes = await middleware(validReq);

    expect(validRes.headers.get("x-middleware-next")).toBe("1");
  });
});

// Round-09 P0 #5 — RSC/Flight prefetch must NOT receive a 307 HTML login
// redirect on failed auth. The App Router client expects an RSC (text/x-component)
// payload; a 307→/login HTML body is treated as a failed prefetch (404-equiv),
// throws React #418, and hangs soft <Link> navigation. Per Codex (verified vs
// next@16.2.6): return a bodiless 401 (no-store) for RSC/data requests so the
// client falls back to a hard MPA navigation; keep the 307 only for real
// document navigations. Page render + /api/proxy backend still enforce auth,
// so no protected RSC payload leaks.
describe("Round-09 #5 — RSC/Flight requests are not redirected to /login", () => {
  const rscVariants: Array<{ name: string; url: string; headers: Record<string, string> }> = [
    {
      name: "?_rsc= query param (cache-busting marker)",
      url: "https://workeros.floom.dev/app/workers?_rsc=abc123",
      headers: {},
    },
    {
      name: "RSC: 1 request header (Flight marker)",
      url: "https://workeros.floom.dev/app/runs",
      headers: { rsc: "1" },
    },
    {
      name: "Next-Router-Prefetch header (link prefetch)",
      url: "https://workeros.floom.dev/app/connections",
      headers: { "next-router-prefetch": "1" },
    },
    {
      name: "Next-Router-State-Tree header (soft nav)",
      url: "https://workeros.floom.dev/app/approvals",
      headers: { "next-router-state-tree": "%5B%22%22%5D" },
    },
  ];

  it("returns 401 (NOT a 307 /login redirect) for an anonymous RSC/data request", async () => {
    const { middleware } = await import("@/middleware");
    for (const variant of rscVariants) {
      const res = await middleware(new NextRequest(variant.url, { headers: variant.headers }));
      expect(res.status, `RSC variant: ${variant.name}`).toBe(401);
      // Must NOT be the HTML login redirect that breaks the Flight fetch.
      expect(res.headers.get("location"), `RSC variant: ${variant.name}`).toBeNull();
      // Auth-failed responses are never shared-cacheable.
      expect(res.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    }
  });

  it("returns 401 for an RSC request carrying a FORGED (unverifiable) cookie", async () => {
    const { middleware } = await import("@/middleware");
    const forgedCookie = cookieFor("a.b.c"); // structurally fine, unverifiable
    const res = await middleware(
      new NextRequest("https://workeros.floom.dev/app/workers?_rsc=xyz", {
        headers: { cookie: `workeros_cloud_session=${forgedCookie}`, rsc: "1" },
      }),
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("location")).toBeNull();
  });

  it("still 307-redirects a real document navigation (no RSC markers) to /login", async () => {
    const { middleware } = await import("@/middleware");
    const res = await middleware(
      new NextRequest("https://workeros.floom.dev/app/workers", { headers: {} }),
    );
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/login");
  });

  it("lets a VALID-session RSC request through (x-middleware-next), not a 401", async () => {
    const { middleware } = await import("@/middleware");
    const validCookie = cookieFor(await signToken());
    const res = await middleware(
      new NextRequest("https://workeros.floom.dev/app/workers?_rsc=ok", {
        headers: { cookie: `workeros_cloud_session=${validCookie}`, rsc: "1" },
      }),
    );
    expect(res.headers.get("x-middleware-next")).toBe("1");
    expect(res.status).not.toBe(401);
  });
});

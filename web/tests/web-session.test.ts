import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Fake fixture value, not a real credential. gitleaks:allow
const SECRET = "fake-test-secret-not-real";

describe("web-session", () => {
  beforeEach(() => {
    process.env.FLOOM_API_SECRET = SECRET;
  });
  afterEach(() => {
    delete process.env.FLOOM_API_SECRET;
    delete process.env.WORKEROS_LOGIN_PASSWORD;
  });

  it("accepts the correct secret and rejects wrong/empty", async () => {
    const { isCorrectSecret } = await import("@/lib/web-session");
    expect(isCorrectSecret(SECRET)).toBe(true);
    expect(isCorrectSecret("wrong")).toBe(false);
    expect(isCorrectSecret("")).toBe(false);
    // Different length must be rejected (no partial match).
    expect(isCorrectSecret(SECRET + "x")).toBe(false);
  });

  it("also accepts the memorable login password (decoupled from the master secret)", async () => {
    process.env.WORKEROS_LOGIN_PASSWORD = "Floom2026";
    const { isCorrectSecret, deriveSessionToken } = await import("@/lib/web-session");
    // Both credentials log in...
    expect(isCorrectSecret("Floom2026")).toBe(true);
    expect(isCorrectSecret(SECRET)).toBe(true);
    // ...but a wrong value (incl. a near-miss) is still rejected.
    expect(isCorrectSecret("Floom2025")).toBe(false);
    expect(isCorrectSecret("floom2026")).toBe(false);
    expect(isCorrectSecret("")).toBe(false);
    // The session cookie is still derived from the MASTER secret, never the password.
    const token = await deriveSessionToken();
    expect(token).not.toContain("Floom2026");
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("password alone (no master secret set) still works and stays fail-closed otherwise", async () => {
    delete process.env.FLOOM_API_SECRET;
    process.env.WORKEROS_LOGIN_PASSWORD = "Floom2026";
    const { isCorrectSecret } = await import("@/lib/web-session");
    expect(isCorrectSecret("Floom2026")).toBe(true);
    expect(isCorrectSecret("nope")).toBe(false);
  });

  it("derives a token that is NOT the raw secret", async () => {
    const { deriveSessionToken } = await import("@/lib/web-session");
    const token = await deriveSessionToken();
    expect(token).not.toContain(SECRET);
    expect(token).toMatch(/^[0-9a-f]{64}$/); // hex sha-256
  });

  it("verifies its own derived token and rejects tampered/empty tokens", async () => {
    const { deriveSessionToken, verifySessionToken } = await import("@/lib/web-session");
    const token = await deriveSessionToken();
    expect(await verifySessionToken(token)).toBe(true);
    expect(await verifySessionToken(token.replace(/.$/, "0"))).toBe(false);
    expect(await verifySessionToken("")).toBe(false);
    expect(await verifySessionToken(undefined)).toBe(false);
  });

  it("fails closed when no secret is configured", async () => {
    delete process.env.FLOOM_API_SECRET;
    const { isCorrectSecret, verifySessionToken, deriveSessionToken } = await import(
      "@/lib/web-session"
    );
    expect(isCorrectSecret("anything")).toBe(false);
    // A token derived under a real secret must not verify when the server has none.
    expect(await verifySessionToken(await deriveSessionToken())).toBe(false);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PUBLIC_API_BASE,
  getPublicApiBase,
  getPublicApiHost,
} from "@/lib/api-base";

describe("public API base (UI display)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("falls back to the floom-hosted URL when NEXT_PUBLIC_API_BASE is unset", () => {
    vi.stubEnv("NEXT_PUBLIC_API_BASE", "");
    expect(getPublicApiBase()).toBe(DEFAULT_PUBLIC_API_BASE);
    expect(getPublicApiHost()).toBe("workers-api.floom.dev");
  });

  it("shows the self-hosted URL when configured (localhost dev)", () => {
    vi.stubEnv("NEXT_PUBLIC_API_BASE", "http://localhost:8000");
    expect(getPublicApiBase()).toBe("http://localhost:8000");
    expect(getPublicApiHost()).toBe("localhost:8000");
  });

  it("uses a custom self-hosted domain and strips a trailing slash", () => {
    vi.stubEnv("NEXT_PUBLIC_API_BASE", "https://api.acme.internal/");
    expect(getPublicApiBase()).toBe("https://api.acme.internal");
    expect(getPublicApiHost()).toBe("api.acme.internal");
  });

  it("ignores whitespace-only config and falls back", () => {
    vi.stubEnv("NEXT_PUBLIC_API_BASE", "   ");
    expect(getPublicApiBase()).toBe(DEFAULT_PUBLIC_API_BASE);
    expect(getPublicApiHost()).toBe("workers-api.floom.dev");
  });
});

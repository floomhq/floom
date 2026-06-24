import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_CLOUD_PUBLIC_API_BASE,
  DEFAULT_PUBLIC_API_BASE,
  getPublicApiBase,
  getPublicApiHost,
  isCloudDeploy,
} from "@/lib/api-base";

describe("public API base (UI display)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("falls back to the local API URL when NEXT_PUBLIC_API_BASE is unset", () => {
    vi.stubEnv("NEXT_PUBLIC_API_BASE", "");
    expect(getPublicApiBase()).toBe(DEFAULT_PUBLIC_API_BASE);
    expect(getPublicApiHost()).toBe("localhost:8000");
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
    expect(getPublicApiHost()).toBe("localhost:8000");
  });
});

describe("cloud deploy public API base", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("defaults to the cloud API host when NEXT_PUBLIC_WORKEROS_DEPLOY=cloud", () => {
    vi.stubEnv("NEXT_PUBLIC_WORKEROS_DEPLOY", "cloud");
    vi.stubEnv("NEXT_PUBLIC_API_BASE", "");
    expect(isCloudDeploy()).toBe(true);
    expect(getPublicApiBase()).toBe(DEFAULT_CLOUD_PUBLIC_API_BASE);
    expect(getPublicApiHost()).toBe("workeros-api.floom.dev");
  });

  it("prefers NEXT_PUBLIC_WORKEROS_API_BASE on cloud when NEXT_PUBLIC_API_BASE is unset", () => {
    vi.stubEnv("NEXT_PUBLIC_WORKEROS_DEPLOY", "cloud");
    vi.stubEnv("NEXT_PUBLIC_WORKEROS_API_BASE", "https://staging-api.example.com");
    expect(getPublicApiBase()).toBe("https://staging-api.example.com");
    expect(getPublicApiHost()).toBe("staging-api.example.com");
  });

  it("still prefers explicit NEXT_PUBLIC_API_BASE on cloud", () => {
    vi.stubEnv("NEXT_PUBLIC_WORKEROS_DEPLOY", "cloud");
    vi.stubEnv("NEXT_PUBLIC_API_BASE", "https://custom.cloud.example.com");
    expect(getPublicApiBase()).toBe("https://custom.cloud.example.com");
  });
});

// #953 — internal Railway origins must never surface in the UI.
describe("#953 internal infra hosts are never displayed", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("remaps a *.up.railway.app base to the configured default", () => {
    vi.stubEnv("NEXT_PUBLIC_API_BASE", "https://api-production-b866.up.railway.app");
    expect(getPublicApiBase()).toBe(DEFAULT_PUBLIC_API_BASE);
    expect(getPublicApiHost()).toBe("localhost:8000");
  });

  it("remaps a *.up.railway.app base to the cloud default on cloud deploy", () => {
    vi.stubEnv("NEXT_PUBLIC_WORKEROS_DEPLOY", "cloud");
    vi.stubEnv("NEXT_PUBLIC_API_BASE", "https://api-production-b866.up.railway.app");
    expect(getPublicApiBase()).toBe(DEFAULT_CLOUD_PUBLIC_API_BASE);
    expect(getPublicApiHost()).toBe("workeros-api.floom.dev");
  });

  it("remaps railway.internal hosts", () => {
    vi.stubEnv("NEXT_PUBLIC_API_BASE", "http://api.railway.internal:8080");
    expect(getPublicApiBase()).toBe(DEFAULT_PUBLIC_API_BASE);
  });

  it("does NOT remap legitimate self-hosted domains", () => {
    vi.stubEnv("NEXT_PUBLIC_API_BASE", "https://api.acme-corp.com");
    expect(getPublicApiBase()).toBe("https://api.acme-corp.com");
    vi.stubEnv("NEXT_PUBLIC_API_BASE", "http://localhost:8000");
    expect(getPublicApiBase()).toBe("http://localhost:8000");
  });

  it("does NOT remap lookalike domains (railway.app.evil.com)", () => {
    vi.stubEnv("NEXT_PUBLIC_API_BASE", "https://up.railway.app.evil.com");
    expect(getPublicApiBase()).toBe("https://up.railway.app.evil.com");
  });
});

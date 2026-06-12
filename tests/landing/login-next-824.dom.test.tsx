import { describe, expect, it } from "vitest";
import { normalizeNextPath } from "@/components/LoginEmailPanel";

describe("Cloud login next routing", () => {
  it("preserves Cloud /app destinations after apex login", () => {
    expect(normalizeNextPath("/app")).toBe("/app");
    expect(normalizeNextPath("/app/workers/new?prompt=hire")).toBe("/app/workers/new?prompt=hire");
    expect(normalizeNextPath("https://workeros.floom.dev/app/workers/new")).toBe("/app/workers/new");
  });

  it("unwraps nested login URLs without falling back to the landing page", () => {
    expect(normalizeNextPath("/login?next=%2Fapp%2Foverview")).toBe("/app/overview");
    expect(normalizeNextPath("/login")).toBe("/app");
    expect(normalizeNextPath("not a url")).toBe("/not%20a%20url");
  });
});


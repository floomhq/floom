// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { sanitizedCurrentUrl, templateRoute } from "@/lib/posthog";

describe("PostHog URL sanitization", () => {
  it("templates token-bearing routes for pageview URLs", () => {
    expect(templateRoute("/s/fls_secret")).toBe("/s/:token");
    expect(templateRoute("/auth/magic/magic_secret")).toBe("/auth/magic/:token");
    expect(templateRoute("/run/run_123")).toBe("/run/:id");
  });

  it("omits query strings and dynamic secrets from $current_url", () => {
    window.history.pushState({}, "", "/s/fls_secret?token=abc&claim_token=def");

    expect(sanitizedCurrentUrl("/s/fls_secret")).toBe("http://localhost:3000/s/:token");
    expect(sanitizedCurrentUrl("/s/fls_secret")).not.toContain("abc");
    expect(sanitizedCurrentUrl("/s/fls_secret")).not.toContain("fls_secret");
  });
});

/**
 * #1700 — a failed run's error banner must never show the raw h2/transport
 * exception repr ("<ConnectionTerminated error_code:1, ...>") or a sandbox
 * machine error code. This locks the client-side humanizer defense-in-depth:
 * even if a raw `e2b_sandbox_error: <...>` string reaches the banner, it
 * collapses to the calm headline; any stray library repr is stripped.
 */
import { describe, it, expect } from "vitest";
import { humanizeRunError, isInfraLogLine } from "@/lib/run-format";

const SANDBOX_HEADLINE =
  "The sandbox could not start or stay connected. Try again, then check the E2B configuration if it repeats.";

describe("humanizeRunError sandbox hygiene (#1700)", () => {
  it("collapses a raw e2b_sandbox_error with an h2 repr to the calm headline", () => {
    const raw =
      "e2b_sandbox_error: E2B sandbox failed before the worker timeout was reached: <ConnectionTerminated error_code:1, last_stream_id:343, additional_data:None>";
    expect(humanizeRunError(raw)).toBe(SANDBOX_HEADLINE);
  });

  it("collapses a sandbox_error code to the calm headline", () => {
    expect(humanizeRunError("sandbox_error: anything raw")).toBe(SANDBOX_HEADLINE);
  });

  it("strips a bare library repr from a codeless passthrough error", () => {
    expect(humanizeRunError("Connection dropped: <ConnectionTerminated error_code:1>")).toBe(
      "Connection dropped: ConnectionTerminated",
    );
  });

  it("does not corrupt a clean already-humanized headline", () => {
    expect(humanizeRunError(SANDBOX_HEADLINE)).toBe(SANDBOX_HEADLINE);
  });

  it("leaves normal mathematical angle-brackets alone", () => {
    expect(humanizeRunError("expected a < b")).toBe("expected a < b");
  });

  it("returns empty string for empty input", () => {
    expect(humanizeRunError("")).toBe("");
    expect(humanizeRunError(null)).toBe("");
    expect(humanizeRunError(undefined)).toBe("");
  });
});

describe("isInfraLogLine angle-bracket redaction (#1703 / #1700)", () => {
  it("filters a log line carrying an unsubstituted <REDACTED:NAME> token", () => {
    expect(isInfraLogLine("scraper mode <REDACTED:EXTERNAL_APIFY_PROFILE_SCRAPER_MODE> active")).toBe(true);
  });

  it("filters a bare <REDACTED> token line", () => {
    expect(isInfraLogLine("value <REDACTED>")).toBe(true);
  });

  it("still filters [e2b] infra lines", () => {
    expect(isInfraLogLine("[e2b] Sandbox resources: memory=2048MB ...")).toBe(true);
  });

  it("keeps a normal operator log line visible", () => {
    expect(isInfraLogLine("Fetched 25 candidate profiles")).toBe(false);
  });
});

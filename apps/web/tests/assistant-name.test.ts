import { describe, it, expect } from "vitest";
import {
  resolveAssistantName,
  DEFAULT_ASSISTANT_NAME,
  ASSISTANT_NAME_KEY,
} from "@/lib/workspace/assistant-name";

// Round-09 — the assistant name is a workspace setting (Federico 2026-06-17).
// resolveAssistantName is the single source of truth used by every visible label.
describe("resolveAssistantName", () => {
  it("falls back to the default when unset", () => {
    expect(resolveAssistantName(null)).toBe(DEFAULT_ASSISTANT_NAME);
    expect(resolveAssistantName(undefined)).toBe(DEFAULT_ASSISTANT_NAME);
    expect(resolveAssistantName("")).toBe(DEFAULT_ASSISTANT_NAME);
    expect(resolveAssistantName("   ")).toBe(DEFAULT_ASSISTANT_NAME);
  });

  it("trims whitespace around a custom name", () => {
    expect(resolveAssistantName("  Nova  ")).toBe("Nova");
  });

  it("returns a custom name verbatim", () => {
    expect(resolveAssistantName("Atlas")).toBe("Atlas");
  });

  it("caps the name length so headers do not overflow", () => {
    const long = "x".repeat(80);
    expect(resolveAssistantName(long).length).toBe(32);
  });

  it("exposes the canonical KV key", () => {
    expect(ASSISTANT_NAME_KEY).toBe("assistant_name");
  });
});

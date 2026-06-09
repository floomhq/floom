import { describe, it, expect } from "vitest";
import { formatBytes, writeKey } from "@/lib/brain/format";

describe("formatBytes", () => {
  it("formats bytes / KB / MB and falsy", () => {
    expect(formatBytes(undefined)).toBe("0 B");
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});

describe("writeKey", () => {
  it("read_only wins, else writeable flag decides", () => {
    expect(writeKey({ read_only: true, writeable: true })).toBe("read-only");
    expect(writeKey({ writeable: true })).toBe("writeable");
    expect(writeKey({ writeable: false })).toBe("read-only");
  });
});

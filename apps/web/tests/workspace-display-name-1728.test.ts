import { describe, it, expect } from "vitest";
import {
  resolveWorkspaceName,
  resolveUserLabel,
  isUuid,
} from "@/lib/workspace/display-name";

// #1728 / #1709: user-facing labels must never leak a raw UUID, and the
// workspace fallback is the white-label "My workspace" (not "Floom workspace").
const UUID = "9b1a5065-3ab9-493a-8220-b6c139d9c1b7";

describe("resolveWorkspaceName (#1709)", () => {
  it("falls back to 'My workspace' for empty / nullish", () => {
    expect(resolveWorkspaceName(undefined)).toBe("My workspace");
    expect(resolveWorkspaceName(null)).toBe("My workspace");
    expect(resolveWorkspaceName("   ")).toBe("My workspace");
  });

  it("never returns a raw UUID", () => {
    expect(resolveWorkspaceName(UUID)).toBe("My workspace");
  });

  it("returns a real name unchanged", () => {
    expect(resolveWorkspaceName("Acme Inc")).toBe("Acme Inc");
  });
});

describe("isUuid", () => {
  it("detects UUID-shaped strings", () => {
    expect(isUuid(UUID)).toBe(true);
    expect(isUuid(UUID.toUpperCase())).toBe(true);
    expect(isUuid("not-a-uuid")).toBe(false);
    expect(isUuid("fede")).toBe(false);
    expect(isUuid(null)).toBe(false);
  });
});

describe("resolveUserLabel (#1728)", () => {
  it("skips UUID and empty candidates, picking the first human value", () => {
    expect(resolveUserLabel([UUID, "", "fede@floom.dev"])).toBe("fede@floom.dev");
    expect(resolveUserLabel(["   ", "Federico"])).toBe("Federico");
  });

  it("falls back to the friendly label when every candidate is a UUID/empty", () => {
    expect(resolveUserLabel([UUID, null, ""])).toBe("You");
    expect(resolveUserLabel([UUID], "Workspace owner")).toBe("Workspace owner");
    expect(resolveUserLabel([], "Local user")).toBe("Local user");
  });

  it("never returns a raw UUID", () => {
    for (const out of [
      resolveUserLabel([UUID]),
      resolveUserLabel([UUID], "Workspace owner"),
      resolveUserLabel([UUID, UUID]),
    ]) {
      expect(isUuid(out)).toBe(false);
    }
  });
});

import { describe, expect, it } from "vitest";

import { isUuid, resolveUserLabel, resolveWorkspaceName } from "@/lib/workspace/display-name";

const UUID = "9b1a5065-3ab9-493a-8220-b6c139d9c1b7";

describe("#1728 user-label resolution never leaks a UUID", () => {
  it("isUuid detects bare UUIDs", () => {
    expect(isUuid(UUID)).toBe(true);
    expect(isUuid(UUID.toUpperCase())).toBe(true);
    expect(isUuid("fede@floom.dev")).toBe(false);
    expect(isUuid("")).toBe(false);
    expect(isUuid(null)).toBe(false);
  });

  it("resolveUserLabel skips empties and UUIDs, returns first real label", () => {
    expect(resolveUserLabel([null, "", "  ", "Federico"])).toBe("Federico");
    expect(resolveUserLabel(["fede@floom.dev", "ignored"])).toBe("fede@floom.dev");
  });

  it("resolveUserLabel skips a UUID candidate and falls through", () => {
    expect(resolveUserLabel([UUID, "fede@floom.dev"])).toBe("fede@floom.dev");
  });

  it("resolveUserLabel returns the fallback when only a UUID/empties are available", () => {
    expect(resolveUserLabel([UUID])).toBe("Local user");
    expect(resolveUserLabel([null, "", UUID], "Workspace owner")).toBe("Workspace owner");
  });

  it("resolveWorkspaceName still maps a UUID workspace name to a friendly label", () => {
    expect(resolveWorkspaceName(UUID)).toBe("My workspace");
    expect(resolveWorkspaceName("Marketing")).toBe("Marketing");
  });
});

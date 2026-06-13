import { describe, it, expect } from "vitest";

import { getWorkspaceActionCopy } from "@/lib/workspace/action-copy";

describe("getWorkspaceActionCopy (#1005)", () => {
  it("uses OSS template-zip vocabulary when not in cloud mode", () => {
    const copy = getWorkspaceActionCopy(false);
    expect(copy.exportLabel).toBe("Export workspace");
    expect(copy.duplicateLabel).toBe("Duplicate workspace");
    expect(copy.shareLabel).toBe("Share as template link");
    expect(copy.shareCopied).toBe("Template link copied to clipboard");
    expect(copy.shareFailed).toBe("Failed to create template link");
  });

  it("uses cloud invite vocabulary in cloud mode", () => {
    const copy = getWorkspaceActionCopy(true);
    expect(copy.exportLabel).toBe("Download copy");
    expect(copy.duplicateLabel).toBe("Make a local copy");
    expect(copy.shareLabel).toBe("Invite someone by link");
    expect(copy.shareCopied).toBe("Invite link copied to clipboard");
    expect(copy.shareFailed).toBe("Failed to create invite link");
  });

  it("flips every visible action + toast string between modes", () => {
    const oss = getWorkspaceActionCopy(false);
    const cloud = getWorkspaceActionCopy(true);
    // The seam exists precisely so cloud need not fork the component: every
    // user-facing label that differs must actually differ.
    for (const key of [
      "exportLabel",
      "duplicateLabel",
      "shareLabel",
      "sharing",
      "shareCopied",
      "shareReady",
      "shareFailed",
      "exportToast",
    ] as const) {
      expect(cloud[key], `expected ${key} to differ`).not.toBe(oss[key]);
    }
    // No string is left blank in either mode.
    for (const v of [...Object.values(oss), ...Object.values(cloud)]) {
      expect(v.trim().length).toBeGreaterThan(0);
    }
  });
});

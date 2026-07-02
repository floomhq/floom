import { afterEach, describe, expect, it, vi } from "vitest";

import { withWorkspaceParam } from "@/lib/workspaceHref";

describe("workspace href helper", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("appends workspace_id when present in current search params", () => {
    expect(withWorkspaceParam("/workers?sel=w1", new URLSearchParams("workspace_id=ws_123"))).toBe(
      "/workers?sel=w1&workspace_id=ws_123",
    );
  });

  it("returns the href unchanged when workspace_id is absent", () => {
    expect(withWorkspaceParam("/workers?sel=w1", new URLSearchParams("sel=w2"))).toBe("/workers?sel=w1");
  });

  it("preserves existing target params and hash", () => {
    expect(withWorkspaceParam("/workers/w1?edit=1#source", new URLSearchParams("workspace_id=ws_123"))).toBe(
      "/workers/w1?edit=1&workspace_id=ws_123#source",
    );
  });

  it("does not double-append workspace_id", () => {
    expect(withWorkspaceParam("/workers?sel=w1&workspace_id=existing", new URLSearchParams("workspace_id=ws_123"))).toBe(
      "/workers?sel=w1&workspace_id=existing",
    );
  });

  it("normalizes ws alias from inbound worker links", () => {
    expect(withWorkspaceParam("/workers?sel=w1", new URLSearchParams("ws=ws_123"))).toBe(
      "/workers?sel=w1&workspace_id=ws_123",
    );
  });

  it("uses the stored active workspace when no URL workspace is present", () => {
    vi.stubGlobal("window", {
      location: { search: "" },
      localStorage: {
        getItem: vi.fn((key: string) => key === "workeros.activeWorkspaceId" ? "ws_stored" : null),
      },
    });

    expect(withWorkspaceParam("/workers?sel=w1")).toBe("/workers?sel=w1&workspace_id=ws_stored");
  });
});

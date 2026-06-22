// #1728 — the connection "Owner" field must never expose a raw workspace UUID
// (or ws_-prefixed id) to the operator. resolveOwner falls back to a friendly
// "My workspace" label when the id cannot be resolved to a member.
import { describe, it, expect, vi } from "vitest";
import type { WorkspaceMember } from "@/lib/types";

// ConnectionsCollection is a client component; mock its runtime deps so the
// module loads in a plain (non-DOM) test for the pure resolveOwner helper.
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/connections",
}));
vi.mock("@/lib/api", () => ({ api: {} }));

import { resolveOwner } from "@/app/connections/ConnectionsCollection";

const member = (over: Partial<WorkspaceMember>): WorkspaceMember => ({
  workspace_id: "w1",
  user_id: "u1",
  email: null,
  display_name: null,
  role: "admin",
  status: "active",
  invited_by: null,
  created_at: null,
  updated_at: null,
  ...over,
});

const RAW_UUID = "9b1a5065-3ab9-493a-8220-b6c139d9c1b7";

describe("resolveOwner — #1728 UUID masking", () => {
  it("never returns the raw UUID; falls back to 'My workspace'", () => {
    const out = resolveOwner(RAW_UUID, []);
    expect(out).toBe("My workspace");
    expect(out).not.toContain("9b1a5065");
  });

  it("masks a ws_-prefixed id", () => {
    expect(resolveOwner("ws_abc123", [])).toBe("My workspace");
  });

  it("prefers a matching member's display name", () => {
    expect(
      resolveOwner(RAW_UUID, [member({ user_id: RAW_UUID, display_name: "Ada Lovelace" })]),
    ).toBe("Ada Lovelace");
  });

  it("falls back to a matching member's email when no display name", () => {
    expect(
      resolveOwner(RAW_UUID, [member({ user_id: RAW_UUID, email: "ada@floom.dev" })]),
    ).toBe("ada@floom.dev");
  });

  it("returns 'Not set' for a null owner", () => {
    expect(resolveOwner(null, [])).toBe("Not set");
  });
});

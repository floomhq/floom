import { describe, it, expect } from "vitest";
import { toUnified, connStatusKey, STATUS_PILL } from "@/lib/connections/unify";
import type { ConnectionItem, SecretItem } from "@/lib/types";

const conn = (over: Partial<ConnectionItem>): ConnectionItem => ({
  id: "c1",
  app_name: "github",
  status: "active",
  created_at: "2026-01-01",
  updated_at: "2026-01-01",
  ...over,
});

const secret = (over: Partial<SecretItem>): SecretItem => ({
  name: "OPENAI_API_KEY",
  status: "set",
  used_by: [],
  ...over,
});

describe("connStatusKey (SPEC Active/Reauth/Error)", () => {
  it("maps active→active", () => expect(connStatusKey("active")).toBe("active"));
  it("maps expired/initiated→reauth", () => {
    expect(connStatusKey("expired")).toBe("reauth");
    expect(connStatusKey("initiated")).toBe("reauth");
  });
  it("maps failed/unknown/not_found→error", () => {
    expect(connStatusKey("failed")).toBe("error");
    expect(connStatusKey("unknown")).toBe("error");
    expect(connStatusKey("not_found")).toBe("error");
  });
  it("each key has a pill", () => {
    expect(STATUS_PILL.active.tone).toBe("ok");
    expect(STATUS_PILL.error.tone).toBe("err");
  });
});

describe("toUnified — one list, type is a tag (SPEC §1a)", () => {
  it("merges connections, MCP (by kind), and secrets into one list", () => {
    const out = toUnified(
      [
        conn({ id: "c1", app_name: "github", scopes: ["a", "b"] }),
        conn({ id: "m1", kind: "mcp", mcp_label: "my-tools", mcp_url: "https://x/mcp", mcp_allowed_tools: ["t1"] }),
      ],
      [secret({ name: "OPENAI_API_KEY", used_by: ["w1", "w2"] })],
    );
    expect(out.map((i) => i.kind)).toEqual(["connection", "mcp", "secret"]);
  });

  it("derives connection display fields + scopes detail", () => {
    const [c] = toUnified([conn({ display_name: "GitHub", account_label: "octocat", scopes: ["x"] })], []);
    expect(c.name).toBe("GitHub");
    expect(c.account).toBe("octocat");
    expect(c.detail).toBe("1 scopes");
  });

  it("derives MCP endpoint + tools detail", () => {
    const [m] = toUnified(
      [conn({ kind: "mcp", app_name: "srv", mcp_url: "https://x/mcp", mcp_allowed_tools: ["a", "b", "c"] })],
      [],
    );
    expect(m.kind).toBe("mcp");
    expect(m.account).toBe("https://x/mcp");
    expect(m.detail).toBe("3 tools");
  });

  it("namespaces secret ids and maps set/missing → active/error", () => {
    const out = toUnified([], [secret({ name: "A", status: "set" }), secret({ name: "B", status: "missing" })]);
    expect(out[0].id).toBe("secret:A");
    expect(out[0].statusKey).toBe("active");
    expect(out[1].statusKey).toBe("error");
    expect(out[1].detail).toBe("used by 0");
  });
});

import { describe, it, expect } from "vitest";
import { load as loadYaml } from "js-yaml";
import {
  contextSpecName,
  contextSpecWritable,
  connectionSpecApp,
  connectionSpecAllowedTools,
  patchBrainContexts,
  patchWorkerConnections,
  setContextWriteable,
  toggleContext,
  setComposioAllowlist,
  addConnection,
  removeConnection,
} from "@/lib/worker-manifest";
import type { WorkerConnectionSpec, WorkerContextSpec } from "@/lib/types";

const YML = `name: weekly-update
description: "does things"
contexts:
  - company-facts
connections:
  - github
runtime: python311
`;

describe("spec accessors", () => {
  it("reads context name + writeable", () => {
    expect(contextSpecName("a")).toBe("a");
    expect(contextSpecName({ name: "b", writeable: true })).toBe("b");
    expect(contextSpecWritable("a")).toBe(false);
    expect(contextSpecWritable({ name: "b", writeable: true })).toBe(true);
  });
  it("reads connection app + allowed tools across shapes", () => {
    expect(connectionSpecApp("slack")).toBe("slack");
    expect(connectionSpecApp({ composio: { app: "gmail", allowed_tools: ["X"] } })).toBe("gmail");
    expect(connectionSpecApp({ app: "hubspot" })).toBe("hubspot");
    expect(connectionSpecAllowedTools("slack")).toBeNull();
    expect(connectionSpecAllowedTools({ composio: { app: "gmail", allowed_tools: ["X"] } })).toEqual(["X"]);
  });
});

describe("patchBrainContexts", () => {
  it("replaces the contexts block in place, parsing back valid yaml", () => {
    const out = patchBrainContexts(YML, ["company-facts", { name: "pricing", writeable: true }]);
    const parsed = loadYaml(out) as { contexts: WorkerContextSpec[]; name: string; runtime: string };
    expect(parsed.name).toBe("weekly-update"); // siblings preserved
    expect(parsed.runtime).toBe("python311");
    expect(parsed.contexts).toEqual(["company-facts", { name: "pricing", writeable: true }]);
  });
  it("appends a contexts block when absent", () => {
    const out = patchBrainContexts("name: x\n", ["a"]);
    expect((loadYaml(out) as { contexts: string[] }).contexts).toEqual(["a"]);
  });
});

describe("patchWorkerConnections", () => {
  it("replaces the connections block, preserving siblings", () => {
    const out = patchWorkerConnections(YML, ["github", { composio: { app: "gmail", allowed_tools: ["SEND"] } }]);
    const parsed = loadYaml(out) as { connections: WorkerConnectionSpec[]; name: string };
    expect(parsed.name).toBe("weekly-update");
    expect(parsed.connections).toEqual(["github", { composio: { app: "gmail", allowed_tools: ["SEND"] } }]);
  });
});

describe("setContextWriteable / toggleContext", () => {
  it("writeable=true → object, false → bare string", () => {
    expect(setContextWriteable(["a"], "a", true)).toEqual([{ name: "a", writeable: true }]);
    expect(setContextWriteable([{ name: "a", writeable: true }], "a", false)).toEqual(["a"]);
  });
  it("preserves source mount when set writeable", () => {
    expect(setContextWriteable([{ name: "a", source: "s" }], "a", true)).toEqual([
      { name: "a", writeable: true, source: "s" },
    ]);
  });
  it("toggle attaches then detaches", () => {
    expect(toggleContext([], "a")).toEqual(["a"]);
    expect(toggleContext(["a"], "a")).toEqual([]);
  });
});

describe("setComposioAllowlist (backend semantics)", () => {
  it("a non-empty list restricts to that set", () => {
    expect(setComposioAllowlist(["gmail"], "gmail", ["SEND"])).toEqual([
      { composio: { app: "gmail", allowed_tools: ["SEND"] } },
    ]);
  });
  it("null DROPS the key (full access), never emits []", () => {
    const out = setComposioAllowlist([{ composio: { app: "gmail", allowed_tools: ["SEND"] } }], "gmail", null);
    expect(out).toEqual([{ composio: { app: "gmail" } }]);
    expect("allowed_tools" in (out[0] as { composio: object }).composio).toBe(false);
  });
  it("preserves extra composio fields like scope", () => {
    const out = setComposioAllowlist(
      [{ composio: { app: "gmail", scope: "x" } as never }],
      "gmail",
      ["SEND"],
    );
    expect(out[0]).toEqual({ composio: { app: "gmail", scope: "x", allowed_tools: ["SEND"] } });
  });
  it("no-op when slug absent", () => {
    expect(setComposioAllowlist(["github"], "gmail", ["X"])).toEqual(["github"]);
  });
});

describe("addConnection / removeConnection", () => {
  it("adds bare slug, dedupes case-insensitively", () => {
    expect(addConnection(["github"], "Gmail")).toEqual(["github", "gmail"]);
    expect(addConnection(["gmail"], "GMAIL")).toEqual(["gmail"]);
  });
  it("removes by app slug across shapes", () => {
    expect(removeConnection([{ composio: { app: "gmail" } }, "github"], "GMAIL")).toEqual(["github"]);
  });
});

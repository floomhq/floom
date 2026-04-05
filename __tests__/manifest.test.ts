import { describe, it, expect } from "vitest";
import {
  validateManifestStructure,
  isValidCron,
  Manifest,
} from "@/convex/lib/manifest";

function makeManifest(overrides: Partial<Manifest> = {}): Manifest {
  return {
    name: "test",
    description: "test automation",
    inputs: [],
    outputs: [],
    secrets_needed: [],
    python_dependencies: [],
    ...overrides,
  };
}

describe("validateManifestStructure", () => {
  it("accepts all 8 valid input types", () => {
    const types = [
      "text",
      "textarea",
      "url",
      "file",
      "number",
      "enum",
      "boolean",
      "date",
    ] as const;

    for (const type of types) {
      const manifest = makeManifest({
        inputs: [{ name: "x", label: "X", type }],
      });
      const result = validateManifestStructure(
        "def run(x): pass",
        manifest
      );
      expect(result, `input type "${type}" should be valid`).toBeNull();
    }
  });

  it("accepts all 6 valid output types", () => {
    const types = [
      "text",
      "table",
      "number",
      "html",
      "pdf",
      "image",
    ] as const;

    for (const type of types) {
      const manifest = makeManifest({
        outputs: [{ name: "y", label: "Y", type }],
      });
      const result = validateManifestStructure("def run(): pass", manifest);
      expect(result, `output type "${type}" should be valid`).toBeNull();
    }
  });

  it("rejects unknown input type", () => {
    const manifest = makeManifest({
      inputs: [{ name: "x", label: "X", type: "bolean" as any }],
    });
    const result = validateManifestStructure("def run(x): pass", manifest);
    expect(result).not.toBeNull();
    expect(result!.code).toBe("input_mismatch");
  });

  it("rejects unknown output type", () => {
    const manifest = makeManifest({
      outputs: [{ name: "y", label: "Y", type: "chart" as any }],
    });
    const result = validateManifestStructure("def run(): pass", manifest);
    expect(result).not.toBeNull();
    expect(result!.code).toBe("output_mismatch");
  });

  it("rejects exec(globals())", () => {
    const manifest = makeManifest();
    const result = validateManifestStructure(
      "exec(code, globals())",
      manifest
    );
    expect(result).not.toBeNull();
    expect(result!.code).toBe("exec_globals");
  });

  it("validates required inputs match params", () => {
    const manifest = makeManifest({
      inputs: [{ name: "name", label: "Name", type: "text" }],
    });
    const result = validateManifestStructure("def run(age): pass", manifest);
    expect(result).not.toBeNull();
    expect(result!.code).toBe("input_mismatch");
  });

  it("allows optional inputs not in params", () => {
    const manifest = makeManifest({
      inputs: [
        { name: "name", label: "Name", type: "text", required: false },
      ],
    });
    const result = validateManifestStructure("def run(): pass", manifest);
    expect(result).toBeNull();
  });
});

describe("isValidCron", () => {
  it("accepts valid 5-field cron", () => {
    expect(isValidCron("0 9 * * 1")).toBe(true);
  });

  it("rejects 6-field cron", () => {
    expect(isValidCron("0 9 * * 1 2")).toBe(false);
  });

  it("rejects 4-field cron", () => {
    expect(isValidCron("0 9 * *")).toBe(false);
  });
});

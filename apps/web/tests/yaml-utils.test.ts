import { describe, it, expect } from "vitest";
import { patchInputDefault } from "@/lib/yaml-utils";

const BASE_YAML = `\
schema_version: "0.3"
name: "ai-news-digest"
title: "AI News Digest"
description: "Posts AI news to Discord every 5 minutes."
trigger:
  type: "schedule"
  cron: "*/5 * * * *"
exec:
  entry: "run.py"
  runtime: "python311"
  runner: "e2b"
  command: "python run.py"
inputs:
  - name: "discord_channel_id"
    kind: "scalar"
    type: "string"
    required: true
    label: "Discord Channel ID"
    placeholder: "e.g. 123456789012345678"
  - name: "max_stories"
    kind: "scalar"
    type: "number"
    required: false
    label: "Max Stories"
    default: 3
connections: []
`;

describe("patchInputDefault", () => {
  it("inserts a default field for an input that has none", () => {
    const result = patchInputDefault(BASE_YAML, "discord_channel_id", "987654321098765432");
    expect(result).toContain('default: "987654321098765432"');
  });

  it("replaces an existing default field", () => {
    const result = patchInputDefault(BASE_YAML, "max_stories", "10");
    // Should replace default: 3 with default: "10"
    expect(result).toContain('default: "10"');
    // Should not have the old default value anymore for that input
    const lines = result.split("\n");
    const maxStoriesIdx = lines.findIndex((l) => l.includes('name: "max_stories"'));
    const defaultLine = lines.slice(maxStoriesIdx, maxStoriesIdx + 10).find((l) => l.trimStart().startsWith("default:"));
    expect(defaultLine).toBeDefined();
    expect(defaultLine).toContain('"10"');
  });

  it("does not modify other inputs when patching one", () => {
    const result = patchInputDefault(BASE_YAML, "discord_channel_id", "111222333444555666");
    // max_stories default should still be 3
    const lines = result.split("\n");
    const maxStoriesIdx = lines.findIndex((l) => l.includes('name: "max_stories"'));
    const defaultLine = lines.slice(maxStoriesIdx, maxStoriesIdx + 10).find((l) => l.trimStart().startsWith("default:"));
    expect(defaultLine).toContain("3");
  });

  it("returns yaml unchanged if input name is not found", () => {
    const result = patchInputDefault(BASE_YAML, "nonexistent_field", "somevalue");
    expect(result).toBe(BASE_YAML);
  });

  it("inserts default at correct indentation level", () => {
    const result = patchInputDefault(BASE_YAML, "discord_channel_id", "123");
    const lines = result.split("\n");
    const defaultLine = lines.find((l) => l.trimStart().startsWith("default:") && l.includes('"123"'));
    expect(defaultLine).toBeDefined();
    // Should be indented 4 spaces (matching the other fields in the block for this YAML format)
    expect(defaultLine!.startsWith("    ")).toBe(true);
  });

  it("handles empty string value", () => {
    const result = patchInputDefault(BASE_YAML, "discord_channel_id", "");
    expect(result).toContain('default: ""');
  });

  it("handles values with special characters", () => {
    const result = patchInputDefault(BASE_YAML, "discord_channel_id", 'hello "world"');
    expect(result).toContain('default: "hello \\"world\\""');
  });

  it("handles single-input YAML with no following input block", () => {
    const singleInputYaml = `\
inputs:
  - name: "only_input"
    kind: "scalar"
    type: "string"
    required: true
    label: "Only Input"
`;
    const result = patchInputDefault(singleInputYaml, "only_input", "myvalue");
    expect(result).toContain('default: "myvalue"');
  });

  it("is idempotent — patching same value twice gives same result", () => {
    const once = patchInputDefault(BASE_YAML, "discord_channel_id", "abc123");
    const twice = patchInputDefault(once, "discord_channel_id", "abc123");
    expect(once).toBe(twice);
  });
});
